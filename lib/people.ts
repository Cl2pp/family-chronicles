import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { chronicleMembers, memberships, people, relationships } from '@/db/schema';
import { familyTagsByPerson } from '@/lib/family-tags';
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

/** Find or create the person node that represents an app user. Returns personId. */
export async function ensurePersonForUser(
  input: { userId: string; name: string },
  tx: Tx | typeof db = db,
): Promise<string> {
  const existing = await tx.query.people.findFirst({
    where: eq(people.userId, input.userId),
  });
  if (existing) return existing.id;

  const [created] = await tx
    .insert(people)
    .values({
      displayName: input.name,
      userId: input.userId,
      createdBy: input.userId,
    })
    .returning({ id: people.id });
  return created.id;
}

export interface NewPerson {
  displayName: string;
  givenName?: string | null;
  familyName?: string | null;
  gender?: Gender | null;
  bornOn?: Date | null;
  bornPrecision?: 'day' | 'month' | 'year' | 'circa' | null;
  diedOn?: Date | null;
  diedPrecision?: 'day' | 'month' | 'year' | 'circa' | null;
  notes?: string | null;
}

/** Create a person and (optionally) add them to a family's tree. */
export async function createPerson(
  input: NewPerson & { createdBy: string; chronicleId?: string },
) {
  return db.transaction(async (tx) => {
    const [person] = await tx
      .insert(people)
      .values({
        displayName: input.displayName,
        givenName: input.givenName ?? null,
        familyName: input.familyName ?? null,
        gender: input.gender ?? null,
        bornOn: input.bornOn ?? null,
        bornPrecision: input.bornPrecision ?? null,
        diedOn: input.diedOn ?? null,
        diedPrecision: input.diedPrecision ?? null,
        notes: input.notes ?? null,
        createdBy: input.createdBy,
      })
      .returning();

    if (input.chronicleId) {
      await tx
        .insert(chronicleMembers)
        .values({ chronicleId: input.chronicleId, personId: person.id })
        .onConflictDoNothing();
    }
    return person;
  });
}

export async function addPersonToChronicle(chronicleId: string, personId: string) {
  await db
    .insert(chronicleMembers)
    .values({ chronicleId, personId })
    .onConflictDoNothing();
}

export async function getPerson(id: string) {
  return db.query.people.findFirst({ where: eq(people.id, id) });
}

export interface PersonPatch {
  displayName?: string;
  familyName?: string | null;
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
  const row = await db.query.chronicleMembers.findFirst({
    where: and(eq(chronicleMembers.chronicleId, chronicleId), eq(chronicleMembers.personId, personId)),
  });
  return Boolean(row);
}

/** True if the user contributes to at least one chronicle this person is a tree node of. */
export async function canUserEditPerson(userId: string, personId: string): Promise<boolean> {
  const rows = await db
    .select({ role: memberships.accessRole })
    .from(chronicleMembers)
    .innerJoin(memberships, eq(chronicleMembers.chronicleId, memberships.chronicleId))
    .where(and(eq(chronicleMembers.personId, personId), eq(memberships.userId, userId)));
  return rows.some((r) => canContribute(r.role as AccessRole));
}

/**
 * Delete a person globally. Their kinship edges, chronicle memberships, and story links
 * are removed by ON DELETE CASCADE. No-op if the person no longer exists.
 */
export async function deletePerson(personId: string) {
  await db.delete(people).where(eq(people.id, personId));
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

/** Create a global kinship edge. parent: from=parent,to=child. spouse: symmetric. */
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
        const child = await tx.query.people.findFirst({ where: eq(people.id, personToId) });
        throw new Error(
          `${child?.displayName ?? 'This person'} already has two parents — remove one of the existing parent links first.`,
        );
      }
    }

    await tx
      .insert(relationships)
      .values({
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
  displayName: string;
  familyName: string | null;
  userId: string | null;
  gender: Gender | null;
  bornOn: Date | null;
  bornPrecision: string | null;
  diedOn: Date | null;
  diedPrecision: string | null;
  /** Chronicle ids (within scope) this person is a tree node of — gates editing. */
  chronicleIds: string[];
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

/**
 * Merged tree across the given chronicles: every person who is a member of any of
 * them, plus the global kinship edges connecting two such people. Each person
 * carries the subset of `chronicleIds` (from the scope) they belong to.
 */
async function getTreeForChronicles(chronicleIds: string[]): Promise<FamilyTree> {
  if (chronicleIds.length === 0) return { people: [], edges: [] };

  const fmRows = await db
    .select({ chronicleId: chronicleMembers.chronicleId, personId: chronicleMembers.personId })
    .from(chronicleMembers)
    .where(inArray(chronicleMembers.chronicleId, chronicleIds));

  const chronicleIdsByPerson = new Map<string, string[]>();
  for (const r of fmRows) {
    const arr = chronicleIdsByPerson.get(r.personId) ?? [];
    arr.push(r.chronicleId);
    chronicleIdsByPerson.set(r.personId, arr);
  }
  const personIds = [...chronicleIdsByPerson.keys()];
  if (personIds.length === 0) return { people: [], edges: [] };

  const personRows = await db
    .select({
      id: people.id,
      displayName: people.displayName,
      familyName: people.familyName,
      userId: people.userId,
      gender: people.gender,
      bornOn: people.bornOn,
      bornPrecision: people.bornPrecision,
      diedOn: people.diedOn,
      diedPrecision: people.diedPrecision,
    })
    .from(people)
    .where(inArray(people.id, personIds));

  const tagsByPerson = await familyTagsByPerson(personIds);
  const treePeople: TreePerson[] = personRows.map((p) => ({
    ...p,
    chronicleIds: chronicleIdsByPerson.get(p.id) ?? [],
    familyTags: tagsByPerson.get(p.id) ?? [],
  }));

  // Edges where BOTH endpoints are in scope.
  const inScope = new Set(personIds);
  const relRows = await db
    .select()
    .from(relationships)
    .where(inArray(relationships.personFromId, personIds));
  const edges: TreeEdge[] = relRows
    .filter((r) => inScope.has(r.personToId))
    .map((r) => ({ type: r.type as RelationshipType, from: r.personFromId, to: r.personToId }));

  return { people: treePeople, edges };
}

/** One chronicle's tree: its people plus the kinship edges between them. */
export async function getTreeForChronicle(chronicleId: string): Promise<FamilyTree> {
  return getTreeForChronicles([chronicleId]);
}

/** The merged tree across every chronicle a user belongs to. */
export async function getMergedTreeForUser(userId: string): Promise<FamilyTree> {
  const fams = await db
    .select({ chronicleId: memberships.chronicleId })
    .from(memberships)
    .where(eq(memberships.userId, userId));
  return getTreeForChronicles(fams.map((f) => f.chronicleId));
}

/** People in one chronicle's tree (for pickers / People tab). */
export async function listChroniclePeople(chronicleId: string) {
  return db
    .select({
      id: people.id,
      displayName: people.displayName,
      familyName: people.familyName,
      userId: people.userId,
      gender: people.gender,
      bornOn: people.bornOn,
      diedOn: people.diedOn,
    })
    .from(chronicleMembers)
    .innerJoin(people, eq(chronicleMembers.personId, people.id))
    .where(eq(chronicleMembers.chronicleId, chronicleId))
    .orderBy(people.displayName);
}

