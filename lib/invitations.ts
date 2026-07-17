import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { chronicles, invitations, memberships, people } from '@/db/schema';
import { getMembership } from '@/lib/chronicles';
import { isPersonInChronicle, linkUserToPersonIfFree } from '@/lib/people';
import { personFullName } from '@/lib/person-name';
import type { AccessRole } from '@/lib/permissions';

const INVITE_TTL_DAYS = 14;

/** Create an invitation and return it (token is shareable). */
export async function createInvitation(input: {
  chronicleId: string;
  email: string;
  role: AccessRole;
  invitedBy: string;
  /** The tree node the invitee IS — accepting links `people.user_id` to their account. */
  personId?: string | null;
}) {
  if (input.personId) {
    if (!(await isPersonInChronicle(input.chronicleId, input.personId))) {
      throw new Error("That person is not in this chronicle's tree.");
    }
    const person = await db.query.people.findFirst({ where: eq(people.id, input.personId) });
    if (person?.userId) {
      throw new Error('That person is already linked to an account.');
    }
  }

  const token = randomUUID();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  const [created] = await db
    .insert(invitations)
    .values({
      chronicleId: input.chronicleId,
      email: input.email.trim().toLowerCase(),
      accessRole: input.role,
      token,
      invitedBy: input.invitedBy,
      personId: input.personId ?? null,
      expiresAt,
    })
    .returning();

  return created;
}

/**
 * Pending invitations of a chronicle, with the linked tree person's name (if
 * any). Deliberately does NOT select `token`: the list is rendered to every
 * member, and a token is a bearer credential that would let any member redeem
 * the invite — and claim its tree person — for themselves. Owners get the
 * shareable link once, from `createInvitation`'s return value.
 */
export async function listPendingInvitations(chronicleId: string) {
  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      accessRole: invitations.accessRole,
      personId: invitations.personId,
      personFirstName: people.firstName,
      personFamilyName: people.familyName,
    })
    .from(invitations)
    .leftJoin(people, eq(invitations.personId, people.id))
    .where(and(eq(invitations.chronicleId, chronicleId), isNull(invitations.acceptedAt)));

  return rows.map(({ personFirstName, personFamilyName, ...i }) => ({
    ...i,
    personName: personFirstName
      ? personFullName({ firstName: personFirstName, familyName: personFamilyName })
      : null,
  }));
}

export type InvitePreview =
  | {
      status: 'ok';
      chronicleName: string;
      /** The tree person the invitee will be linked to on accept, if chosen. */
      personName: string | null;
    }
  | { status: 'not_found' | 'expired' | 'used' };

/**
 * Read-only look at an invitation for the confirmation screen — acceptance is
 * a deliberate button click (`acceptInvitation`), never a side effect of a GET:
 * the token is a bearer credential that may carry a tree identity, and mail
 * scanners prefetch links.
 */
export async function getInvitationByToken(token: string): Promise<InvitePreview> {
  const [row] = await db
    .select({
      acceptedAt: invitations.acceptedAt,
      expiresAt: invitations.expiresAt,
      chronicleName: chronicles.name,
      personFirstName: people.firstName,
      personFamilyName: people.familyName,
    })
    .from(invitations)
    .innerJoin(chronicles, eq(invitations.chronicleId, chronicles.id))
    .leftJoin(people, eq(invitations.personId, people.id))
    .where(eq(invitations.token, token))
    .limit(1);

  if (!row) return { status: 'not_found' };
  if (row.acceptedAt) return { status: 'used' };
  if (row.expiresAt.getTime() < Date.now()) return { status: 'expired' };
  const personName = row.personFirstName
    ? personFullName({ firstName: row.personFirstName, familyName: row.personFamilyName })
    : null;
  return { status: 'ok', chronicleName: row.chronicleName, personName };
}

export type AcceptResult =
  | {
      ok: true;
      chronicleId: string;
      personLinked: boolean;
      /** The invite carried a person but the link could not be made (claimed meanwhile). */
      personLinkFailed: boolean;
    }
  | { ok: false; reason: 'not_found' | 'expired' | 'used' };

/** Accept an invitation for the given user, creating their membership. */
export async function acceptInvitation(token: string, userId: string): Promise<AcceptResult> {
  const invite = await db.query.invitations.findFirst({
    where: eq(invitations.token, token),
  });

  if (!invite) return { ok: false, reason: 'not_found' };
  if (invite.acceptedAt) return { ok: false, reason: 'used' };
  if (invite.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired' };

  // Atomically claim the token — the conditional WHERE is the gate, so two
  // accepts racing on the same link can never both redeem it (the loser sees
  // 0 rows and gets 'used', whichever user it was).
  const claimed = await db
    .update(invitations)
    .set({ acceptedAt: new Date() })
    .where(and(eq(invitations.id, invite.id), isNull(invitations.acceptedAt)))
    .returning({ id: invitations.id });
  if (claimed.length === 0) return { ok: false, reason: 'used' };

  const existing = await getMembership(invite.chronicleId, userId);
  if (!existing) {
    await db.insert(memberships).values({
      chronicleId: invite.chronicleId,
      userId,
      accessRole: invite.accessRole,
    });
  }

  // Best-effort: claim the invite's tree person for this account. Skipped (never
  // fatal) if the person was claimed meanwhile or the user already has a person.
  let personLinked = false;
  if (invite.personId) {
    personLinked = await linkUserToPersonIfFree(invite.personId, userId);
  }

  return {
    ok: true,
    chronicleId: invite.chronicleId,
    personLinked,
    personLinkFailed: Boolean(invite.personId) && !personLinked,
  };
}
