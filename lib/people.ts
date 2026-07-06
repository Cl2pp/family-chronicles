import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { familyMembers, memberships, people, relationships } from '@/db/schema';
import { canContribute, type AccessRole } from '@/lib/permissions';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type RelationshipType = 'parent' | 'spouse';

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
  bornOn?: Date | null;
  bornPrecision?: 'day' | 'month' | 'year' | 'circa' | null;
  diedOn?: Date | null;
  diedPrecision?: 'day' | 'month' | 'year' | 'circa' | null;
  notes?: string | null;
}

/** Create a person and (optionally) add them to a family's tree. */
export async function createPerson(
  input: NewPerson & { createdBy: string; familyId?: string },
) {
  return db.transaction(async (tx) => {
    const [person] = await tx
      .insert(people)
      .values({
        displayName: input.displayName,
        givenName: input.givenName ?? null,
        familyName: input.familyName ?? null,
        bornOn: input.bornOn ?? null,
        bornPrecision: input.bornPrecision ?? null,
        diedOn: input.diedOn ?? null,
        diedPrecision: input.diedPrecision ?? null,
        notes: input.notes ?? null,
        createdBy: input.createdBy,
      })
      .returning();

    if (input.familyId) {
      await tx
        .insert(familyMembers)
        .values({ familyId: input.familyId, personId: person.id })
        .onConflictDoNothing();
    }
    return person;
  });
}

export async function addPersonToFamily(familyId: string, personId: string) {
  await db
    .insert(familyMembers)
    .values({ familyId, personId })
    .onConflictDoNothing();
}

export async function getPerson(id: string) {
  return db.query.people.findFirst({ where: eq(people.id, id) });
}

export interface PersonPatch {
  displayName?: string;
  familyName?: string | null;
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

export async function isPersonInFamily(familyId: string, personId: string): Promise<boolean> {
  const row = await db.query.familyMembers.findFirst({
    where: and(eq(familyMembers.familyId, familyId), eq(familyMembers.personId, personId)),
  });
  return Boolean(row);
}

/** True if the user contributes to at least one family this person is a tree node of. */
export async function canUserEditPerson(userId: string, personId: string): Promise<boolean> {
  const rows = await db
    .select({ role: memberships.accessRole })
    .from(familyMembers)
    .innerJoin(memberships, eq(familyMembers.familyId, memberships.familyId))
    .where(and(eq(familyMembers.personId, personId), eq(memberships.userId, userId)));
  return rows.some((r) => canContribute(r.role as AccessRole));
}

/**
 * Delete a person globally. Their kinship edges, family memberships, and story links
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
  if (input.type === 'spouse' && personFromId > personToId) {
    [personFromId, personToId] = [personToId, personFromId];
  }
  await db
    .insert(relationships)
    .values({
      type: input.type,
      personFromId,
      personToId,
      createdBy: input.createdBy,
    })
    .onConflictDoNothing();
}

export interface TreePerson {
  id: string;
  displayName: string;
  familyName: string | null;
  userId: string | null;
  bornOn: Date | null;
  bornPrecision: string | null;
  diedOn: Date | null;
  diedPrecision: string | null;
  /** Family ids (within scope) this person belongs to — for colored dots. */
  familyIds: string[];
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
 * Merged tree across the given families: every person who is a member of any of
 * them, plus the global kinship edges connecting two such people. Each person
 * carries the subset of `familyIds` (from the scope) they belong to.
 */
async function getTreeForFamilies(familyIds: string[]): Promise<FamilyTree> {
  if (familyIds.length === 0) return { people: [], edges: [] };

  const fmRows = await db
    .select({ familyId: familyMembers.familyId, personId: familyMembers.personId })
    .from(familyMembers)
    .where(inArray(familyMembers.familyId, familyIds));

  const familyIdsByPerson = new Map<string, string[]>();
  for (const r of fmRows) {
    const arr = familyIdsByPerson.get(r.personId) ?? [];
    arr.push(r.familyId);
    familyIdsByPerson.set(r.personId, arr);
  }
  const personIds = [...familyIdsByPerson.keys()];
  if (personIds.length === 0) return { people: [], edges: [] };

  const personRows = await db
    .select({
      id: people.id,
      displayName: people.displayName,
      familyName: people.familyName,
      userId: people.userId,
      bornOn: people.bornOn,
      bornPrecision: people.bornPrecision,
      diedOn: people.diedOn,
      diedPrecision: people.diedPrecision,
    })
    .from(people)
    .where(inArray(people.id, personIds));

  const treePeople: TreePerson[] = personRows.map((p) => ({
    ...p,
    familyIds: familyIdsByPerson.get(p.id) ?? [],
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

/** The merged tree across every family a user belongs to. */
export async function getMergedTreeForUser(userId: string): Promise<FamilyTree> {
  const fams = await db
    .select({ familyId: memberships.familyId })
    .from(memberships)
    .where(eq(memberships.userId, userId));
  return getTreeForFamilies(fams.map((f) => f.familyId));
}

/** People in one family's tree (for pickers / People tab). */
export async function listFamilyPeople(familyId: string) {
  return db
    .select({
      id: people.id,
      displayName: people.displayName,
      familyName: people.familyName,
      userId: people.userId,
      bornOn: people.bornOn,
      diedOn: people.diedOn,
    })
    .from(familyMembers)
    .innerJoin(people, eq(familyMembers.personId, people.id))
    .where(eq(familyMembers.familyId, familyId))
    .orderBy(people.displayName);
}

