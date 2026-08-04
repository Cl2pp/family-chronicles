import { and, eq, isNull, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/db';
import { memberships, people, relationships } from '@/db/schema';
import { familyTagsByPerson } from '@/lib/family-tags';
import { personFullName } from '@/lib/person-name';
import { canContribute, type AccessRole } from '@/lib/permissions';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type RelationshipType = 'parent' | 'spouse';
export type Gender = 'male' | 'female';

/** A relation as users phrase it: the subject is the relative's parent/child/partner. */
export type PersonRelation = 'parent' | 'child' | 'partner';

/** Turn a "subject is X of relative" relation into a canonical kinship edge. */
export function edgeForRelation(
  rel: PersonRelation,
  subjectId: string,
  relativeId: string,
): { type: RelationshipType; personFromId: string; personToId: string } {
  if (rel === 'parent') return { type: 'parent', personFromId: subjectId, personToId: relativeId };
  if (rel === 'child') return { type: 'parent', personFromId: relativeId, personToId: subjectId };
  return { type: 'spouse', personFromId: subjectId, personToId: relativeId };
}

/**
 * Find or create the person node that represents an app user IN ONE chronicle. Returns
 * personId. Matches on `(chronicleId, userId)`, not `userId` alone — under hard
 * isolation the same account legitimately has one independent person node per
 * chronicle it belongs to, and a global lookup would hand back a DIFFERENT
 * chronicle's person (see `people_chronicle_user_uq` in db/schema.ts).
 */
export async function ensurePersonForUser(
  input: { chronicleId: string; userId: string; name: string },
  tx: Tx | typeof db = db,
): Promise<string> {
  const existing = await tx.query.people.findFirst({
    where: and(eq(people.chronicleId, input.chronicleId), eq(people.userId, input.userId)),
  });
  if (existing) return existing.id;

  const [created] = await tx
    .insert(people)
    .values({
      chronicleId: input.chronicleId,
      firstName: input.name,
      userId: input.userId,
      createdBy: input.userId,
    })
    .returning({ id: people.id });
  return created.id;
}

/**
 * Claim a person node for a user account, best-effort: a single conditional UPDATE
 * that only fires while the person is still unlinked AND the user has no person yet
 * IN THAT PERSON'S CHRONICLE (`people_chronicle_user_uq` is unique on
 * `(chronicle_id, user_id)`, not `user_id` alone — the same account may already hold a
 * person in a DIFFERENT chronicle without that blocking this link). Returns whether
 * the link happened.
 */
export async function linkUserToPersonIfFree(personId: string, userId: string): Promise<boolean> {
  const other = alias(people, 'other');
  try {
    const updated = await db
      .update(people)
      .set({ userId, updatedAt: new Date() })
      .where(
        and(
          eq(people.id, personId),
          isNull(people.userId),
          notExists(
            db
              .select({ one: sql`1` })
              .from(other)
              .where(and(eq(other.userId, userId), eq(other.chronicleId, people.chronicleId))),
          ),
        ),
      )
      .returning({ id: people.id });
    return updated.length > 0;
  } catch (e) {
    // Two concurrent links of the same USER to different people in the SAME chronicle
    // both pass the notExists subquery; the loser hits `people_chronicle_user_uq`.
    // That race is this function's "already taken" case, not an error.
    const code = (e as { code?: string; cause?: { code?: string } }).code
      ?? (e as { cause?: { code?: string } }).cause?.code;
    if (code === '23505') return false;
    throw e;
  }
}

/** The target account must be a member of the chronicle the owner is acting in —
 *  otherwise an owner of ANY chronicle could anchor an arbitrary account to a
 *  puppet person node and hijack (or strand) that account's story access. */
async function assertTargetIsMember(chronicleId: string, userId: string) {
  const member = await db.query.memberships.findFirst({
    where: and(eq(memberships.chronicleId, chronicleId), eq(memberships.userId, userId)),
  });
  if (!member) throw new Error('That account is not a member of this chronicle.');
}

/**
 * Owner repair: link a chronicle member's account to a tree person. Guards (the
 * caller gates that the ACTING user is an owner): the target user is a member of
 * this chronicle, the person is in this chronicle's tree and unlinked, and the
 * target user has no person row in THIS chronicle yet (a person row in another
 * chronicle is unrelated and never blocks this).
 */
export async function linkUserToPerson(chronicleId: string, userId: string, personId: string) {
  await assertTargetIsMember(chronicleId, userId);
  if (!(await isPersonInChronicle(chronicleId, personId))) {
    throw new Error("That person is not in this chronicle's tree.");
  }
  const person = await db.query.people.findFirst({ where: eq(people.id, personId) });
  if (person?.userId) {
    throw new Error('That person is already linked to an account.');
  }
  const existing = await db.query.people.findFirst({
    where: and(eq(people.userId, userId), eq(people.chronicleId, chronicleId)),
  });
  if (existing) {
    throw new Error(`This account is already linked to ${personFullName(existing)}.`);
  }
  const linked = await linkUserToPersonIfFree(personId, userId);
  if (!linked) {
    throw new Error('Could not link — the person or account was claimed meanwhile.');
  }
}

/** Owner repair: unlink a member's account from its tree person in this chronicle. */
export async function unlinkUserPerson(chronicleId: string, userId: string) {
  await assertTargetIsMember(chronicleId, userId);
  const person = await db.query.people.findFirst({
    where: and(eq(people.userId, userId), eq(people.chronicleId, chronicleId)),
  });
  if (!person) return; // nothing linked in this chronicle — a no-op
  await db
    .update(people)
    .set({ userId: null, updatedAt: new Date() })
    .where(and(eq(people.id, person.id), eq(people.userId, userId)));
}

export interface NewPerson {
  firstName: string;
  familyName?: string | null;
  birthFamilyName?: string | null;
  gender?: Gender | null;
  bornOn?: Date | null;
  bornPrecision?: 'day' | 'month' | 'year' | 'circa' | null;
  diedOn?: Date | null;
  diedPrecision?: 'day' | 'month' | 'year' | 'circa' | null;
  notes?: string | null;
}

/**
 * Create a person, permanently anchored to `chronicleId` — a person's chronicle is set
 * here, once, and never changes (see `people.chronicleId`'s comment in db/schema.ts).
 */
export async function createPerson(input: NewPerson & { createdBy: string; chronicleId: string }) {
  const [person] = await db
    .insert(people)
    .values({
      chronicleId: input.chronicleId,
      firstName: input.firstName,
      familyName: input.familyName ?? null,
      birthFamilyName: input.birthFamilyName ?? null,
      gender: input.gender ?? null,
      bornOn: input.bornOn ?? null,
      bornPrecision: input.bornPrecision ?? null,
      diedOn: input.diedOn ?? null,
      diedPrecision: input.diedPrecision ?? null,
      notes: input.notes ?? null,
      createdBy: input.createdBy,
    })
    .returning();
  return person;
}

/* addPersonToChronicle is gone — a person's chronicle is fixed at creation time
 * (createPerson's required chronicleId) and is immutable thereafter. */

export async function getPerson(id: string) {
  return db.query.people.findFirst({ where: eq(people.id, id) });
}

export interface PersonPatch {
  firstName?: string;
  familyName?: string | null;
  birthFamilyName?: string | null;
  gender?: Gender | null;
  bornOn?: Date | null;
  bornPrecision?: 'day' | 'month' | 'year' | 'circa' | null;
  diedOn?: Date | null;
  diedPrecision?: 'day' | 'month' | 'year' | 'circa' | null;
  notes?: string | null;
}

/** Update a person's details. Only the keys present in `patch` are changed. */
export async function updatePerson(id: string, patch: PersonPatch) {
  if (Object.keys(patch).length === 0) return;
  await db
    .update(people)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(people.id, id));
}

export async function isPersonInChronicle(chronicleId: string, personId: string): Promise<boolean> {
  const row = await db.query.people.findFirst({
    where: and(eq(people.id, personId), eq(people.chronicleId, chronicleId)),
  });
  return Boolean(row);
}

/** True if the user contributes to the chronicle this person belongs to. */
export async function canUserEditPerson(userId: string, personId: string): Promise<boolean> {
  const rows = await db
    .select({ role: memberships.accessRole })
    .from(people)
    .innerJoin(memberships, eq(people.chronicleId, memberships.chronicleId))
    .where(and(eq(people.id, personId), eq(memberships.userId, userId)));
  return rows.some((r) => canContribute(r.role as AccessRole));
}

/**
 * Delete a person. Their kinship edges and story links are removed by ON DELETE
 * CASCADE. No-op if the person no longer exists.
 */
export async function deletePerson(personId: string) {
  await db.delete(people).where(eq(people.id, personId));
}

/** How many parents a person already has on record — used to warn before staging a
 *  third parent link (connectPeople enforces the real cap at write time). */
export async function countParents(personId: string): Promise<number> {
  const rows = await db
    .select({ id: relationships.personFromId })
    .from(relationships)
    .where(and(eq(relationships.type, 'parent'), eq(relationships.personToId, personId)));
  return rows.length;
}

/** Remove a single kinship edge (spouse edges are canonicalised, matching connectPeople). */
export async function removeRelationship(input: {
  type: RelationshipType;
  personFromId: string;
  personToId: string;
}) {
  let { personFromId, personToId } = input;
  if (input.type === 'spouse' && personFromId > personToId) {
    [personFromId, personToId] = [personToId, personFromId];
  }
  await db
    .delete(relationships)
    .where(
      and(
        eq(relationships.type, input.type),
        eq(relationships.personFromId, personFromId),
        eq(relationships.personToId, personToId),
      ),
    );
}

/**
 * Create a kinship edge. parent: from=parent,to=child. spouse: symmetric.
 *
 * INVARIANT: both endpoints must already belong to the SAME chronicle — a
 * relationship never spans two chronicles. `relationships.chronicleId` is
 * denormalised from the endpoints precisely so the family-tags CTE and the
 * story-access graph load can filter with one predicate instead of joining `people`
 * twice (see its comment in db/schema.ts); this check plus writing that chronicleId
 * here is what keeps the denormalised column truthful. Throws if the people are in
 * different chronicles, or don't exist.
 */
export async function connectPeople(input: {
  type: RelationshipType;
  personFromId: string;
  personToId: string;
  createdBy: string;
}) {
  // Canonicalise spouse edges (smaller id first) to dedupe symmetric pairs.
  let { personFromId, personToId } = input;
  if (personFromId === personToId) {
    throw new Error('A person cannot be related to themselves.');
  }
  if (input.type === 'spouse' && personFromId > personToId) {
    [personFromId, personToId] = [personToId, personFromId];
  }

  await db.transaction(async (tx) => {
    const [from, to] = await Promise.all([
      tx.query.people.findFirst({ where: eq(people.id, personFromId) }),
      tx.query.people.findFirst({ where: eq(people.id, personToId) }),
    ]);
    if (!from || !to) {
      throw new Error('One of these people could not be found.');
    }
    if (from.chronicleId !== to.chronicleId) {
      throw new Error('Both people must be in the same chronicle.');
    }
    const chronicleId = from.chronicleId;

    const existing = await tx.query.relationships.findFirst({
      where: and(
        eq(relationships.type, input.type),
        eq(relationships.personFromId, personFromId),
        eq(relationships.personToId, personToId),
      ),
    });
    if (existing) return; // idempotent — the edge is already there

    if (input.type === 'parent') {
      const parents = await tx
        .select({ id: relationships.personFromId })
        .from(relationships)
        .where(and(eq(relationships.type, 'parent'), eq(relationships.personToId, personToId)));
      if (parents.length >= 2) {
        throw new Error(
          `${personFullName(to)} already has two parents — remove one of the existing parent links first.`,
        );
      }
    }

    await tx
      .insert(relationships)
      .values({
        chronicleId,
        type: input.type,
        personFromId,
        personToId,
        createdBy: input.createdBy,
      })
      .onConflictDoNothing();
  });
}

export interface TreePerson {
  id: string;
  firstName: string;
  familyName: string | null;
  birthFamilyName: string | null;
  userId: string | null;
  gender: Gender | null;
  bornOn: Date | null;
  bornPrecision: string | null;
  diedOn: Date | null;
  diedPrecision: string | null;
  /** The one chronicle this person belongs to. */
  chronicleId: string;
  /** Derived family tags (own/ancestor/spouse surnames) — for colored dots. */
  familyTags: string[];
}

export interface TreeEdge {
  type: RelationshipType;
  from: string;
  to: string;
}

export interface FamilyTree {
  people: TreePerson[];
  edges: TreeEdge[];
}

/** One chronicle's tree: its people plus the kinship edges between them. */
export async function getTreeForChronicle(chronicleId: string): Promise<FamilyTree> {
  const personRows = await db
    .select({
      id: people.id,
      firstName: people.firstName,
      familyName: people.familyName,
      birthFamilyName: people.birthFamilyName,
      userId: people.userId,
      gender: people.gender,
      bornOn: people.bornOn,
      bornPrecision: people.bornPrecision,
      diedOn: people.diedOn,
      diedPrecision: people.diedPrecision,
    })
    .from(people)
    .where(eq(people.chronicleId, chronicleId));

  if (personRows.length === 0) return { people: [], edges: [] };

  const tagsByPerson = await familyTagsByPerson(personRows.map((p) => p.id));
  const treePeople: TreePerson[] = personRows.map((p) => ({
    ...p,
    chronicleId,
    familyTags: tagsByPerson.get(p.id) ?? [],
  }));

  // Every edge's endpoints already live in this chronicle by construction
  // (connectPeople's invariant), so filtering on the edge's own denormalised
  // chronicleId is enough — no need to also check both endpoints are in scope.
  const relRows = await db
    .select()
    .from(relationships)
    .where(eq(relationships.chronicleId, chronicleId));
  const edges: TreeEdge[] = relRows.map((r) => ({
    type: r.type as RelationshipType,
    from: r.personFromId,
    to: r.personToId,
  }));

  return { people: treePeople, edges };
}

/* getMergedTreeForUser is gone — chronicles are hard-isolated, so the tree page shows
 * ONLY the active chronicle (getTreeForChronicle). Merging trees across a user's
 * chronicles was exactly the cross-space leak this isolation work fixes. */

/** People in one chronicle's tree (for pickers / People tab). */
export async function listChroniclePeople(chronicleId: string) {
  return db
    .select({
      id: people.id,
      firstName: people.firstName,
      familyName: people.familyName,
      birthFamilyName: people.birthFamilyName,
      userId: people.userId,
      gender: people.gender,
      bornOn: people.bornOn,
      diedOn: people.diedOn,
    })
    .from(people)
    .where(eq(people.chronicleId, chronicleId))
    .orderBy(people.firstName);
}
