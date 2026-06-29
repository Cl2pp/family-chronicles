import { and, desc, eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { db } from '@/db';
import { families, familyMembers, memberships, user } from '@/db/schema';
import { type AccessRole, canContribute, canManage } from '@/lib/permissions';
import { ensurePersonForUser } from '@/lib/people';

/** Families the user belongs to (access), with their role. */
export async function listFamiliesForUser(userId: string) {
  return db
    .select({
      id: families.id,
      name: families.name,
      description: families.description,
      role: memberships.accessRole,
      createdAt: families.createdAt,
    })
    .from(memberships)
    .innerJoin(families, eq(memberships.familyId, families.id))
    .where(eq(memberships.userId, userId))
    .orderBy(desc(families.createdAt));
}

/** Create a family, make the creator owner, and add their person to the tree. */
export async function createFamily(input: {
  name: string;
  description?: string | null;
  userId: string;
  userName: string;
}) {
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(families)
      .values({
        name: input.name,
        description: input.description ?? null,
        createdBy: input.userId,
      })
      .returning();

    await tx.insert(memberships).values({
      familyId: created.id,
      userId: input.userId,
      accessRole: 'owner',
    });

    const personId = await ensurePersonForUser(
      { userId: input.userId, name: input.userName },
      tx,
    );
    await tx
      .insert(familyMembers)
      .values({ familyId: created.id, personId })
      .onConflictDoNothing();

    return created;
  });
}

export async function getFamily(id: string) {
  return db.query.families.findFirst({ where: eq(families.id, id) });
}

export async function getMembership(familyId: string, userId: string) {
  return db.query.memberships.findFirst({
    where: and(eq(memberships.familyId, familyId), eq(memberships.userId, userId)),
  });
}

/** Require membership; redirect to /family if not a member. */
export async function requireMembership(familyId: string, userId: string) {
  const membership = await getMembership(familyId, userId);
  if (!membership) redirect('/family');
  return { ...membership, accessRole: membership.accessRole as AccessRole };
}

/** Require at least contributor; redirect if insufficient. */
export async function requireContributor(familyId: string, userId: string) {
  const m = await requireMembership(familyId, userId);
  if (!canContribute(m.accessRole)) redirect(`/family`);
  return m;
}

/** Require owner; redirect if insufficient. */
export async function requireOwner(familyId: string, userId: string) {
  const m = await requireMembership(familyId, userId);
  if (!canManage(m.accessRole)) redirect(`/family`);
  return m;
}

/** Access members of a family (user accounts + their access role). */
export async function listMembers(familyId: string) {
  return db
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      role: memberships.accessRole,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(user, eq(memberships.userId, user.id))
    .where(eq(memberships.familyId, familyId))
    .orderBy(memberships.createdAt);
}

export async function updateFamily(
  id: string,
  patch: { name?: string; description?: string | null; styleGuide?: string | null },
) {
  await db
    .update(families)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(families.id, id));
}

/** Resolve the active family for a user from a cookie value, falling back to first. */
export async function resolveActiveFamily(userId: string, cookieValue?: string) {
  const fams = await listFamiliesForUser(userId);
  if (fams.length === 0) return { families: fams, active: undefined };
  const active = fams.find((f) => f.id === cookieValue) ?? fams[0];
  return { families: fams, active };
}
