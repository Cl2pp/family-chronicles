import { and, desc, eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { db } from '@/db';
import { chronicles, memberships, user } from '@/db/schema';

export type MembershipRole = 'owner' | 'editor' | 'viewer';

/** Chronicles the user belongs to, with their role. */
export async function listChroniclesForUser(userId: string) {
  return db
    .select({
      id: chronicles.id,
      name: chronicles.name,
      description: chronicles.description,
      role: memberships.role,
      createdAt: chronicles.createdAt,
    })
    .from(memberships)
    .innerJoin(chronicles, eq(memberships.chronicleId, chronicles.id))
    .where(eq(memberships.userId, userId))
    .orderBy(desc(chronicles.createdAt));
}

/** Create a chronicle and make the creator its owner (atomic). */
export async function createChronicle(input: {
  name: string;
  description?: string | null;
  userId: string;
}) {
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(chronicles)
      .values({
        name: input.name,
        description: input.description ?? null,
        createdBy: input.userId,
      })
      .returning();

    await tx.insert(memberships).values({
      chronicleId: created.id,
      userId: input.userId,
      role: 'owner',
    });

    return created;
  });
}

export async function getChronicle(id: string) {
  return db.query.chronicles.findFirst({ where: eq(chronicles.id, id) });
}

export async function getMembership(chronicleId: string, userId: string) {
  return db.query.memberships.findFirst({
    where: and(eq(memberships.chronicleId, chronicleId), eq(memberships.userId, userId)),
  });
}

/** Require the user to be a member of the chronicle; redirect if not. */
export async function requireMembership(chronicleId: string, userId: string) {
  const membership = await getMembership(chronicleId, userId);
  if (!membership) redirect('/dashboard');
  return membership;
}

/** Roles that may contribute/edit (everything except read-only viewers). */
export function canEdit(role: MembershipRole) {
  return role === 'owner' || role === 'editor';
}

/** List members of a chronicle with their user details. */
export async function listMembers(chronicleId: string) {
  return db
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      role: memberships.role,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(user, eq(memberships.userId, user.id))
    .where(eq(memberships.chronicleId, chronicleId))
    .orderBy(memberships.createdAt);
}

export async function updateStyleGuide(chronicleId: string, styleGuide: string) {
  await db
    .update(chronicles)
    .set({ styleGuide, updatedAt: new Date() })
    .where(eq(chronicles.id, chronicleId));
}
