import { and, desc, eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { db } from '@/db';
import { chronicles, chronicleMembers, memberships, user } from '@/db/schema';
import { type AccessRole, canContribute, canManage } from '@/lib/permissions';
import { ensurePersonForUser } from '@/lib/people';
import { isLocale, type Locale } from '@/lib/i18n/config';

/**
 * Normalize any story-language input to its stored form: a supported locale
 * stays as-is; 'auto', null, or junk becomes null (= keep the submission's language).
 */
export function normalizeStoryLanguage(value: string | null | undefined): Locale | null {
  return isLocale(value) ? value : null;
}

/** Chronicles the user belongs to (access), with their role. */
export async function listChroniclesForUser(userId: string) {
  return db
    .select({
      id: chronicles.id,
      name: chronicles.name,
      description: chronicles.description,
      role: memberships.accessRole,
      createdAt: chronicles.createdAt,
    })
    .from(memberships)
    .innerJoin(chronicles, eq(memberships.chronicleId, chronicles.id))
    .where(eq(memberships.userId, userId))
    .orderBy(desc(chronicles.createdAt));
}

/** Create a chronicle, make the creator owner, and add their person to the tree. */
export async function createChronicle(input: {
  name: string;
  description?: string | null;
  userId: string;
  userName: string;
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
      accessRole: 'owner',
    });

    const personId = await ensurePersonForUser(
      { userId: input.userId, name: input.userName },
      tx,
    );
    await tx
      .insert(chronicleMembers)
      .values({ chronicleId: created.id, personId })
      .onConflictDoNothing();

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

/** Require membership; redirect to /chronicle if not a member. */
export async function requireMembership(chronicleId: string, userId: string) {
  const membership = await getMembership(chronicleId, userId);
  if (!membership) redirect('/chronicle');
  return { ...membership, accessRole: membership.accessRole as AccessRole };
}

/** Require at least contributor; redirect if insufficient. */
export async function requireContributor(chronicleId: string, userId: string) {
  const m = await requireMembership(chronicleId, userId);
  if (!canContribute(m.accessRole)) redirect(`/chronicle`);
  return m;
}

/** Require owner; redirect if insufficient. */
export async function requireOwner(chronicleId: string, userId: string) {
  const m = await requireMembership(chronicleId, userId);
  if (!canManage(m.accessRole)) redirect(`/chronicle`);
  return m;
}

/** Access members of a chronicle (user accounts + their access role). */
export async function listMembers(chronicleId: string) {
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
    .where(eq(memberships.chronicleId, chronicleId))
    .orderBy(memberships.createdAt);
}

export async function updateChronicle(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    styleGuide?: string | null;
    storyLanguage?: string | null;
  },
) {
  await db
    .update(chronicles)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(chronicles.id, id));
}

/** Resolve the active chronicle for a user from a cookie value, falling back to first. */
export async function resolveActiveChronicle(userId: string, cookieValue?: string) {
  const fams = await listChroniclesForUser(userId);
  if (fams.length === 0) return { chronicles: fams, active: undefined };
  const active = fams.find((f) => f.id === cookieValue) ?? fams[0];
  return { chronicles: fams, active };
}
