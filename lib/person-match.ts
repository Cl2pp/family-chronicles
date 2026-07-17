/**
 * Name → tree-person matching, shared by every flow that turns free-text names into
 * `people` rows (story accept, chat tools). Matching is forgiving on purpose: drafts
 * often say "Ava" while the tree says "Ava Naoko", or "Clemens Ortlepp" while the tree
 * stores firstName "Clemens" + familyName "Ortlepp". A name only matches when it
 * resolves to exactly ONE person — anything ambiguous stays unmatched rather than
 * guessing wrong.
 */

export interface MatchablePerson {
  id: string;
  firstName: string;
  familyName?: string | null;
  /** Surname at birth (maiden name) — a valid way to refer to someone, too. */
  birthFamilyName?: string | null;
}

export type PersonMatch<T extends MatchablePerson> =
  | { person: T }
  | { error: 'missing' }
  | { error: 'ambiguous'; candidates: T[] };

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** The surnames a person can be qualified by: current family name and name at birth. */
function surnamesOf(p: MatchablePerson): string[] {
  return [p.familyName, p.birthFamilyName].flatMap((s) => (s?.trim() ? [norm(s)] : []));
}

/**
 * Resolve one name against the tree, most-specific rule first. The tiers matter:
 * surname-qualified names ("Gisela Koch" → firstName "Gisela" + familyName "Koch")
 * must be tried on their own BEFORE the loose partial-name rules — pooled together,
 * "Gisela Koch" would also collect every other Gisela via the prefix rule, so the
 * surname could never disambiguate two people sharing a first name.
 */
export function findPersonByName<T extends MatchablePerson>(
  people: T[],
  name: string,
): PersonMatch<T> {
  const wanted = norm(name);
  if (!wanted) return { error: 'missing' };

  // Tier 1: exact stored name.
  const exact = people.filter((p) => norm(p.firstName) === wanted);
  if (exact.length === 1) return { person: exact[0] };
  if (exact.length > 1) return { error: 'ambiguous', candidates: exact };

  // Tier 2: first name + a surname (current or at birth).
  const qualified = people.filter((p) =>
    surnamesOf(p).some((fam) => `${norm(p.firstName)} ${fam}` === wanted),
  );
  if (qualified.length === 1) return { person: qualified[0] };
  if (qualified.length > 1) return { error: 'ambiguous', candidates: qualified };

  // Tier 3: loose partial-name overlap.
  const candidates = people.filter((p) => {
    const dn = norm(p.firstName);
    // "Ava" → "Ava Naoko" (first name / prefix of the stored name)
    if (dn.startsWith(`${wanted} `)) return true;
    // "Ava Naoko Ortlepp" → "Ava Naoko" (stored name plus extras, e.g. an appended surname)
    if (wanted.startsWith(`${dn} `)) return true;
    return false;
  });
  if (candidates.length === 1) return { person: candidates[0] };
  if (candidates.length > 1) return { error: 'ambiguous', candidates };
  return { error: 'missing' };
}

/** Resolve many names at once; matched people are deduped by id, failures keep the given name. */
export function matchPeopleByName<T extends MatchablePerson>(
  people: T[],
  names: string[],
): { matched: T[]; unmatched: string[] } {
  const matched = new Map<string, T>();
  const unmatched: string[] = [];
  for (const name of names) {
    if (!name.trim()) continue;
    const result = findPersonByName(people, name);
    if ('person' in result) matched.set(result.person.id, result.person);
    else unmatched.push(name.trim());
  }
  return { matched: [...matched.values()], unmatched };
}
