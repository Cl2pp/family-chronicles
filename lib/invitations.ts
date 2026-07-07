import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { invitations, memberships } from '@/db/schema';
import { getMembership } from '@/lib/chronicles';
import type { AccessRole } from '@/lib/permissions';

const INVITE_TTL_DAYS = 14;

/** Create an invitation and return it (token is shareable). */
export async function createInvitation(input: {
  chronicleId: string;
  email: string;
  role: AccessRole;
  invitedBy: string;
}) {
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
      expiresAt,
    })
    .returning();

  return created;
}

export async function listPendingInvitations(chronicleId: string) {
  return db
    .select()
    .from(invitations)
    .where(and(eq(invitations.chronicleId, chronicleId), isNull(invitations.acceptedAt)));
}

export type AcceptResult =
  | { ok: true; chronicleId: string }
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

  await db
    .update(invitations)
    .set({ acceptedAt: new Date() })
    .where(eq(invitations.id, invite.id));

  return { ok: true, chronicleId: invite.chronicleId };
}
