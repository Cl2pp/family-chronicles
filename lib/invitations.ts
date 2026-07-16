import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { invitations, memberships, people } from '@/db/schema';
import { getMembership } from '@/lib/chronicles';
import { isPersonInChronicle, linkUserToPersonIfFree } from '@/lib/people';
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

/** Pending invitations of a chronicle, with the linked tree person's name (if any). */
export async function listPendingInvitations(chronicleId: string) {
  return db
    .select({
      id: invitations.id,
      email: invitations.email,
      accessRole: invitations.accessRole,
      token: invitations.token,
      personId: invitations.personId,
      personName: people.displayName,
    })
    .from(invitations)
    .leftJoin(people, eq(invitations.personId, people.id))
    .where(and(eq(invitations.chronicleId, chronicleId), isNull(invitations.acceptedAt)));
}

export type AcceptResult =
  | { ok: true; chronicleId: string; personLinked: boolean }
  | { ok: false; reason: 'not_found' | 'expired' | 'used' };

/** Accept an invitation for the given user, creating their membership. */
export async function acceptInvitation(token: string, userId: string): Promise<AcceptResult> {
  const invite = await db.query.invitations.findFirst({
    where: eq(invitations.token, token),
  });

  if (!invite) return { ok: false, reason: 'not_found' };
  if (invite.acceptedAt) return { ok: false, reason: 'used' };
  if (invite.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired' };

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

  await db
    .update(invitations)
    .set({ acceptedAt: new Date() })
    .where(eq(invitations.id, invite.id));

  return { ok: true, chronicleId: invite.chronicleId, personLinked };
}
