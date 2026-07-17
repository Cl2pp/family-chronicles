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
}

export type PersonMatch<T extends MatchablePerson> =
  | { person: T }
  | { error: 'missing' }
  | { error: 'ambiguous'; candidates: T[] };

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Resolve one name against the tree: exact display name first, then unique forgiving matches. */
export function findPersonByName<T extends MatchablePerson>(
  people: T[],
  name: string,
): PersonMatch<T> {
  const wanted = norm(name);
  if (!wanted) return { error: 'missing' };

  const exact = people.filter((p) => norm(p.firstName) === wanted);
  if (exact.length === 1) return { person: exact[0] };
  if (exact.length > 1) return { error: 'ambiguous', candidates: exact };

  const candidates = people.filter((p) => {
    const dn = norm(p.firstName);
    // "Ava" → "Ava Naoko" (first name / prefix of the stored name)
    if (dn.startsWith(`${wanted} `)) return true;
    // "Ava Naoko Ortlepp" → "Ava Naoko" (stored name plus extras, e.g. an appended surname)
    if (wanted.startsWith(`${dn} `)) return true;
    // "Clemens Ortlepp" → firstName "Clemens" + familyName "Ortlepp"
    const fam = p.familyName ? norm(p.familyName) : '';
    if (fam && norm(`${dn} ${fam}`) === wanted) return true;
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
