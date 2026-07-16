import { inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import { chronicleMembers, storyPeople } from '@/db/schema';

/**
 * Derived "family" tags — families are never set up or stored. A person belongs to:
 *  - the family of their own surname (`people.family_name`),
 *  - every ancestor's surname (recursively via `parent` edges), and
 *  - each spouse's surname (marrying in: an Ortlepp with a Hartwick spouse is a Hartwick too).
 * A tag is the trimmed surname as written on the person; people with no surname
 * anywhere in that set simply carry no tags.
 */

/** Hard cap on ancestor recursion; also guards against accidental cycles in the graph. */
const MAX_GENERATIONS = 25;

/** Family tags for each of the given people, keyed by person id. */
export async function familyTagsByPerson(
  personIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (personIds.length === 0) return map;

  // node-postgres won't serialize a JS array for a `::uuid[]` cast — pass the
  // Postgres array literal form ({a,b,c}) as a single text param instead.
  const idArrayLiteral = `{${personIds.join(',')}}`;

  const result = await db.execute(sql`
    WITH RECURSIVE roots AS (
      SELECT unnest(${idArrayLiteral}::uuid[]) AS root_id
    ),
    lineage AS (
      SELECT root_id, root_id AS person_id, 0 AS depth FROM roots
      UNION
      SELECT l.root_id, r.person_from_id, l.depth + 1
      FROM lineage l
      JOIN relationships r ON r.type = 'parent' AND r.person_to_id = l.person_id
      WHERE l.depth < ${sql.raw(String(MAX_GENERATIONS))}
    ),
    tagged AS (
      -- own + ancestor surnames
      SELECT l.root_id, p.family_name AS tag
      FROM lineage l
      JOIN people p ON p.id = l.person_id
      UNION
      -- spouse surnames (spouse edges are stored in canonical order — match both ends)
      SELECT ro.root_id, sp.family_name
      FROM roots ro
      JOIN relationships r
        ON r.type = 'spouse'
       AND (r.person_from_id = ro.root_id OR r.person_to_id = ro.root_id)
      JOIN people sp
        ON sp.id = CASE
             WHEN r.person_from_id = ro.root_id THEN r.person_to_id
             ELSE r.person_from_id
           END
    )
    SELECT root_id, array_agg(DISTINCT trim(tag)) AS tags
    FROM tagged
    WHERE tag IS NOT NULL AND trim(tag) <> ''
    GROUP BY root_id
  `);

  for (const row of result.rows as { root_id: string; tags: string[] }[]) {
    map.set(
      row.root_id,
      [...row.tags].sort((a, b) => a.localeCompare(b)),
    );
  }
  // People with no surname anywhere still get an (empty) entry.
  for (const id of personIds) if (!map.has(id)) map.set(id, []);
  return map;
}

/** Family tags for a single person. */
export async function familyTagsForPerson(personId: string): Promise<string[]> {
  return (await familyTagsByPerson([personId])).get(personId) ?? [];
}

/**
 * "Close family" surnames for each of the given people — a deliberately narrower set
 * than {@link familyTagsByPerson}. It is just the names that person carries themselves:
 *  - their own surname (`family_name`) and birth surname (`birth_family_name`, e.g. a
 *    maiden name), and
 *  - each spouse's own + birth surname (marrying in: an Ortlepp with a Hartwig spouse
 *    is a Hartwig too).
 * Crucially it does NOT walk the ancestor chain — a person's grandparents' surnames are
 * their heritage, not their close family, and pulling them in makes a single story fan
 * out to half a dozen family tags. Keyed by person id; people with no surname anywhere
 * in that set get an empty entry.
 */
export async function closeFamilyTagsByPerson(
  personIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (personIds.length === 0) return map;

  const idArrayLiteral = `{${personIds.join(',')}}`;

  const result = await db.execute(sql`
    WITH roots AS (
      SELECT unnest(${idArrayLiteral}::uuid[]) AS root_id
    ),
    tagged AS (
      -- the person's own surname + birth surname
      SELECT ro.root_id, p.family_name AS tag
      FROM roots ro JOIN people p ON p.id = ro.root_id
      UNION
      SELECT ro.root_id, p.birth_family_name
      FROM roots ro JOIN people p ON p.id = ro.root_id
      UNION
      -- each spouse's own + birth surname (spouse edges are symmetric — match both ends)
      SELECT ro.root_id, sp.family_name
      FROM roots ro
      JOIN relationships r
        ON r.type = 'spouse'
       AND (r.person_from_id = ro.root_id OR r.person_to_id = ro.root_id)
      JOIN people sp
        ON sp.id = CASE
             WHEN r.person_from_id = ro.root_id THEN r.person_to_id
             ELSE r.person_from_id
           END
      UNION
      SELECT ro.root_id, sp.birth_family_name
      FROM roots ro
      JOIN relationships r
        ON r.type = 'spouse'
       AND (r.person_from_id = ro.root_id OR r.person_to_id = ro.root_id)
      JOIN people sp
        ON sp.id = CASE
             WHEN r.person_from_id = ro.root_id THEN r.person_to_id
             ELSE r.person_from_id
           END
    )
    SELECT root_id, array_agg(DISTINCT trim(tag)) AS tags
    FROM tagged
    WHERE tag IS NOT NULL AND trim(tag) <> ''
    GROUP BY root_id
  `);

  for (const row of result.rows as { root_id: string; tags: string[] }[]) {
    map.set(
      row.root_id,
      [...row.tags].sort((a, b) => a.localeCompare(b)),
    );
  }
  for (const id of personIds) if (!map.has(id)) map.set(id, []);
  return map;
}

/**
 * A story's family tags: the union of the CLOSE-family names of everyone tagged in it
 * (see {@link closeFamilyTagsByPerson}). A story about the Ortlepps therefore shows
 * "Ortlepp" (and "Hartwig" for a married-in spouse) — not every ancestral surname the
 * people in it happen to descend from.
 */
export async function familyTagsByStory(
  storyIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (storyIds.length === 0) return map;

  const links = await db
    .select({ storyId: storyPeople.storyId, personId: storyPeople.personId })
    .from(storyPeople)
    .where(inArray(storyPeople.storyId, storyIds));

  const personTags = await closeFamilyTagsByPerson([...new Set(links.map((l) => l.personId))]);

  for (const { storyId, personId } of links) {
    const merged = new Set([...(map.get(storyId) ?? []), ...(personTags.get(personId) ?? [])]);
    map.set(storyId, [...merged].sort((a, b) => a.localeCompare(b)));
  }
  for (const id of storyIds) if (!map.has(id)) map.set(id, []);
  return map;
}

export interface FamilyTagCount {
  tag: string;
  /** How many people in scope carry the tag. */
  count: number;
}

/** All family tags across a chronicle's people, with member counts (for legends/filters). */
export async function listFamilyTags(chronicleId: string): Promise<FamilyTagCount[]> {
  const members = await db
    .select({ personId: chronicleMembers.personId })
    .from(chronicleMembers)
    .where(inArray(chronicleMembers.chronicleId, [chronicleId]));

  const byPerson = await familyTagsByPerson(members.map((m) => m.personId));
  const counts = new Map<string, number>();
  for (const tags of byPerson.values()) {
    for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
