import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { chronicles, joinLinks, joinRequests, memberships, user } from '@/db/schema';
import { getMembership } from '@/lib/chronicles';
import type { AccessRole } from '@/lib/permissions';

/**
 * The chronicle's signup link, or null if it has none.
 *
 * Deliberately DOES include `token`: unlike a pending invitation this row is
 * the shareable link itself, so the caller must only read it for an owner —
 * the access page gates on the role before it ever loads this.
 */
export async function getJoinLink(chronicleId: string) {
  const row = await db.query.joinLinks.findFirst({
    where: eq(joinLinks.chronicleId, chronicleId),
  });
  return row ?? null;
}

/**
 * Create the chronicle's signup link, or hand back the one it already has —
 * unchanged, mode and role included. A chronicle only ever has one (the unique
 * `chronicle_id`), so a double click on "create" returns the same link instead
 * of erroring, and a second call can never silently re-point an already-shared
 * link at different settings: changing those means revoking first.
 *
 * The re-select covers the case where the conflicting row was inserted by a
 * concurrent call rather than by an earlier one. `created` says which of the two
 * happened, so the caller can avoid telling an owner it made a link with the
 * settings they picked when it in fact handed back an older one.
 */
export async function createJoinLink(
  chronicleId: string,
  userId: string,
  opts: { requiresApproval: boolean; role: AccessRole },
) {
  const [created] = await db
    .insert(joinLinks)
    .values({
      chronicleId,
      token: randomUUID(),
      requiresApproval: opts.requiresApproval,
      accessRole: opts.role,
      createdBy: userId,
    })
    .onConflictDoNothing({ target: joinLinks.chronicleId })
    .returning();
  if (created) return { link: created, created: true };

  const existing = await getJoinLink(chronicleId);
  if (!existing) throw new Error('Could not create the signup link.');
  return { link: existing, created: false };
}

/**
 * Kill the signup link — everyone it was shared with lands on the "not valid"
 * panel from here on.
 *
 * Pending requests deliberately survive: someone who already asked to join is
 * the owner's to approve or decline, and dropping them silently would make
 * their request look like it went nowhere.
 *
 * Returns false if there was no link to revoke.
 */
export async function revokeJoinLink(chronicleId: string) {
  const deleted = await db
    .delete(joinLinks)
    .where(eq(joinLinks.chronicleId, chronicleId))
    .returning({ id: joinLinks.id });

  return deleted.length > 0;
}

export type JoinLinkPreview =
  | {
      status: 'ok';
      chronicleId: string;
      chronicleName: string;
      /** Drives the wording on the join screen: ask-and-wait vs. straight in. */
      requiresApproval: boolean;
      /** Role a direct join grants; meaningless while `requiresApproval` is true. */
      accessRole: AccessRole;
    }
  | { status: 'not_found' };

/**
 * Read-only look at a signup link for the join screen. Same rule as the invite
 * page: joining is a deliberate button click (`requestJoin`), never a side
 * effect of a GET — mail and chat clients prefetch links, and on an open link
 * that would hand out a membership to a link scanner.
 */
export async function getJoinLinkByToken(token: string): Promise<JoinLinkPreview> {
  const [row] = await db
    .select({
      chronicleId: chronicles.id,
      chronicleName: chronicles.name,
      requiresApproval: joinLinks.requiresApproval,
      accessRole: joinLinks.accessRole,
    })
    .from(joinLinks)
    .innerJoin(chronicles, eq(joinLinks.chronicleId, chronicles.id))
    .where(eq(joinLinks.token, token))
    .limit(1);

  if (!row) return { status: 'not_found' };
  return { status: 'ok', ...row, accessRole: row.accessRole as AccessRole };
}

export type JoinRequestResult =
  | { status: 'joined'; chronicleId: string; chronicleName: string }
  | { status: 'pending'; chronicleName: string }
  | { status: 'already_member'; chronicleId: string }
  | { status: 'not_found' };

/**
 * Redeem a signup link. What that means is the link's own decision: an approval
 * link only queues the user for the owner ('pending'), an open one lets them
 * straight in at the link's role ('joined').
 *
 * Idempotent either way — a second click lands on 'already_member' or leaves
 * the single pending row (the unique index is the gate).
 */
export async function requestJoin(token: string, userId: string): Promise<JoinRequestResult> {
  const link = await getJoinLinkByToken(token);
  if (link.status !== 'ok') return { status: 'not_found' };

  // Already in — nothing to redeem, so the page sends them straight to the
  // chat rather than parking them on a request that never resolves.
  if (await getMembership(link.chronicleId, userId)) {
    return { status: 'already_member', chronicleId: link.chronicleId };
  }

  if (link.requiresApproval) {
    await db
      .insert(joinRequests)
      .values({ chronicleId: link.chronicleId, userId })
      .onConflictDoNothing();

    return { status: 'pending', chronicleName: link.chronicleName };
  }

  // `onConflictDoNothing` is the real guard, not the membership check above:
  // two clicks racing each other would both pass that check, and the second
  // insert must be a no-op rather than a unique-violation the user sees.
  await db
    .insert(memberships)
    .values({ chronicleId: link.chronicleId, userId, accessRole: link.accessRole })
    .onConflictDoNothing();

  // They may still be queued from an older approval-mode link on this chronicle.
  // They are in now, so that request is moot — leaving it would show the owner a
  // pending row for someone who is already a member.
  await db
    .delete(joinRequests)
    .where(and(eq(joinRequests.chronicleId, link.chronicleId), eq(joinRequests.userId, userId)));

  return { status: 'joined', chronicleId: link.chronicleId, chronicleName: link.chronicleName };
}

/**
 * Pending join requests of a chronicle, with the asking account's name and email.
 *
 * Anyone who is already a member is filtered out: they can be left over from an
 * invitation they accepted, or an owner adding them by hand, while their request
 * still sat here. Listing them would offer the owner an approval that cannot do
 * anything — their role would stay whatever it already is.
 */
export async function listJoinRequests(chronicleId: string) {
  return db
    .select({
      id: joinRequests.id,
      userId: joinRequests.userId,
      name: user.name,
      email: user.email,
      createdAt: joinRequests.createdAt,
    })
    .from(joinRequests)
    .innerJoin(user, eq(joinRequests.userId, user.id))
    .leftJoin(
      memberships,
      and(
        eq(memberships.chronicleId, joinRequests.chronicleId),
        eq(memberships.userId, joinRequests.userId),
      ),
    )
    .where(and(eq(joinRequests.chronicleId, chronicleId), isNull(memberships.id)))
    .orderBy(joinRequests.createdAt);
}

export type ApproveJoinRequestResult =
  /** Membership created at the chosen role. */
  | 'approved'
  /** No such pending request — another owner decided it first, or it is another chronicle's. */
  | 'stale'
  /** The request is gone, but they were already a member: the chosen role was NOT applied. */
  | 'already_member';

/**
 * Approve a pending request, creating the membership. This is the only place a
 * signup link ever turns into access — holding the link is never enough.
 *
 * Claim and grant share one transaction: without it a failure between the two
 * would swallow the request (the owner's list loses the row) while granting
 * nothing, and the person would be left waiting on a decision that "happened".
 */
export async function approveJoinRequest(
  chronicleId: string,
  requestId: string,
  role: AccessRole,
): Promise<ApproveJoinRequestResult> {
  return db.transaction(async (tx) => {
    // Claim the request by deleting it: the conditional DELETE is the gate, so
    // two owners racing on the same row can never both approve it — the loser
    // sees 0 rows, and an approve racing a decline is settled the same way.
    const [claimed] = await tx
      .delete(joinRequests)
      .where(and(eq(joinRequests.id, requestId), eq(joinRequests.chronicleId, chronicleId)))
      .returning({ userId: joinRequests.userId });
    if (!claimed) return 'stale';

    const [existing] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(eq(memberships.chronicleId, chronicleId), eq(memberships.userId, claimed.userId)),
      )
      .limit(1);
    // They got in some other way meanwhile. Dropping the stale request is right,
    // but say so rather than report a role that was never applied — an existing
    // membership's role is only ever changed deliberately, not by an approval.
    if (existing) return 'already_member';

    await tx.insert(memberships).values({
      chronicleId,
      userId: claimed.userId,
      accessRole: role,
    });

    return 'approved';
  });
}

/**
 * Turn a request down. Nothing is recorded — the user can ask again while the
 * link lives, which is the point: this is a "not now", not a ban.
 *
 * Returns false if there was no such pending request.
 */
export async function declineJoinRequest(chronicleId: string, requestId: string) {
  const deleted = await db
    .delete(joinRequests)
    .where(and(eq(joinRequests.id, requestId), eq(joinRequests.chronicleId, chronicleId)))
    .returning({ id: joinRequests.id });

  return deleted.length > 0;
}
