import { eq } from 'drizzle-orm';

/**
 * Story read-access core (docs/STORY_ACCESS_PLAN.md) — pure rule + thin DB shell.
 *
 * A user may read a story iff any of:
 *  1. they hold an `owner` membership in a chronicle the story is shared into,
 *  2. they wrote it (`stories.submitted_by`), or
 *  3. [`family` mode] the story is tagged with ≥1 person in the viewer's
 *     visible-people set: self ∪ spouses ∪ blood(self) ∪ blood(each spouse),
 *     where blood(X) = all descendants of all ancestors of X (incl. X).
 *
 * In a chronicle with `story_access = 'open'`, every member reads every story
 * (legacy behavior). Chronicles the user is NOT a member of grant nothing.
 * Explicitly excluded from the visible set: spouses of blood relatives (a
 * son-in-law alone is his family's material) and anything past a spouse's own
 * blood (the spouse's parents' side never leaks across the marriage).
 *
 * The rule runs on the kinship graph (`relationships`), never on surnames —
 * mirroring lib/family-tags.ts. Family graphs are small (hundreds of edges),
 * so the whole graph is loaded and walked in TS; no recursive SQL.
 */

/**
 * Hard cap on traversal depth per direction (ancestors, then descendants);
 * also guards against accidental cycles. Mirrors family-tags' cap.
 */
export const MAX_GENERATIONS = 25;

/** A kinship edge. `parent`: from = parent, to = child. `spouse`: symmetric. */
export interface KinshipEdge {
  type: 'parent' | 'spouse';
  personFromId: string;
  personToId: string;
}

/** Everything `canReadStory` needs to know about the viewer — plain data, no DB. */
export interface StoryAccessContext {
  userId: string;
  /** The viewer's person node (`people.user_id`), or null if unlinked. */
  personId: string | null;
  /**
   * People whose stories the viewer may read under rule 3 (see module docs).
   * CAUTION: on the fast path (no family-mode membership, or unlinked viewer)
   * this is an under-approximation holding just the viewer's own person —
   * `canReadStory` never consults it in that state, but any new consumer must
   * replicate its open/owner branching or it will wrongly deny in open mode.
   */
  visiblePersonIds: Set<string>;
  /** Chronicles where the viewer holds an `owner` membership. */
  ownerChronicleIds: Set<string>;
  /** Chronicles the viewer belongs to whose `story_access` is 'open'. */
  openChronicleIds: Set<string>;
  /** Every chronicle the viewer belongs to (any role, any mode). */
  memberChronicleIds: Set<string>;
}

/** The story facts the access rule consumes (a subset of any story row). */
export interface StoryAccessInput {
  submittedBy: string;
  /** Chronicles the story is shared into (`story_chronicles`). */
  chronicleIds: string[];
  /** People tagged in the story (`story_people`). */
  personIds: string[];
}

/**
 * The viewer's visible-people set, walked over an in-memory edge list (pure).
 *
 * visible(P) = {P} ∪ spouses(P) ∪ blood(P) ∪ blood(s) for each spouse s,
 * where blood(X) = descendants of ancestors of X (both walks depth-capped at
 * MAX_GENERATIONS and cycle-safe). Spouse edges match either end.
 */
export function computeVisiblePersonIds(
  personId: string,
  edges: KinshipEdge[],
): Set<string> {
  const parentsOf = new Map<string, string[]>();
  const childrenOf = new Map<string, string[]>();
  const spousesOf = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, value: string) => {
    const arr = map.get(key);
    if (arr) arr.push(value);
    else map.set(key, [value]);
  };
  for (const e of edges) {
    if (e.type === 'parent') {
      push(childrenOf, e.personFromId, e.personToId);
      push(parentsOf, e.personToId, e.personFromId);
    } else {
      // Spouse edges are stored in canonical order — index both directions.
      push(spousesOf, e.personFromId, e.personToId);
      push(spousesOf, e.personToId, e.personFromId);
    }
  }

  // blood(X): up all parent edges (ancestors incl. X), then down all parent
  // edges from every ancestor (their descendants). NOT spouses at any step.
  const blood = (root: string): Set<string> =>
    walk([...walk([root], parentsOf)], childrenOf);

  const spouses = spousesOf.get(personId) ?? [];
  const visible = new Set<string>([personId, ...spouses]);
  for (const id of blood(personId)) visible.add(id);
  for (const s of spouses) for (const id of blood(s)) visible.add(id);
  return visible;
}

/** BFS from all starts along `next` edges: depth-capped, cycle-safe, includes starts. */
function walk(starts: string[], next: Map<string, string[]>): Set<string> {
  const seen = new Set(starts);
  let frontier = starts;
  for (let depth = 0; depth < MAX_GENERATIONS && frontier.length > 0; depth++) {
    const upcoming: string[] = [];
    for (const id of frontier) {
      for (const n of next.get(id) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          upcoming.push(n);
        }
      }
    }
    frontier = upcoming;
  }
  return seen;
}

/**
 * The full read-access rule (pure). Chronicles the viewer is not a member of
 * grant nothing; a story shared into several chronicles is readable if ANY of
 * the viewer's chronicles grants access. Zero-tagged-people stories and
 * viewers with no person link fall through rule 3 (author + owners only).
 */
export function canReadStory(ctx: StoryAccessContext, story: StoryAccessInput): boolean {
  // Rule 2: the author always reads their own story.
  if (story.submittedBy === ctx.userId) return true;

  let inFamilyModeChronicle = false;
  for (const chronicleId of story.chronicleIds) {
    if (!ctx.memberChronicleIds.has(chronicleId)) continue;
    // Rule 1: owner bypass.
    if (ctx.ownerChronicleIds.has(chronicleId)) return true;
    // Legacy 'open' mode: every member reads every story.
    if (ctx.openChronicleIds.has(chronicleId)) return true;
    inFamilyModeChronicle = true;
  }
  if (!inFamilyModeChronicle) return false;

  // Rule 3 (family mode): kinship. An unlinked viewer, or a story with zero
  // tagged people, grants nothing here — the tests above are the only way in.
  if (ctx.personId === null) return false;
  return story.personIds.some((id) => ctx.visiblePersonIds.has(id));
}

/** Keep only the stories the viewer may read (pure; for list callers). */
export function filterReadableStories<T extends StoryAccessInput>(
  ctx: StoryAccessContext,
  stories: T[],
): T[] {
  return stories.filter((story) => canReadStory(ctx, story));
}

/**
 * Load the viewer's access context — the module's only DB touchpoint.
 *
 * Reads the user's person link, their memberships (+ role and each chronicle's
 * `story_access`), and — only when some chronicle is in `family` mode and the
 * user has a person — the global kinship graph. Fast path: when every one of
 * the user's chronicles is 'open' (or the user is unlinked), the graph is never
 * consulted by `canReadStory`, so edges are skipped and `visiblePersonIds`
 * holds just the viewer's own person.
 */
export async function loadStoryAccessContext(userId: string): Promise<StoryAccessContext> {
  // Lazy-import the DB so the pure core above stays importable without env/DB
  // (unit tests exercise the rule functions with in-memory fixtures only).
  const [{ db }, { chronicles, memberships, people, relationships }] = await Promise.all([
    import('@/db'),
    import('@/db/schema'),
  ]);

  const [memberRows, personRows] = await Promise.all([
    db
      .select({
        chronicleId: memberships.chronicleId,
        role: memberships.accessRole,
        storyAccess: chronicles.storyAccess,
      })
      .from(memberships)
      .innerJoin(chronicles, eq(memberships.chronicleId, chronicles.id))
      .where(eq(memberships.userId, userId)),
    db.select({ id: people.id }).from(people).where(eq(people.userId, userId)).limit(1),
  ]);

  const personId = personRows[0]?.id ?? null;
  const memberChronicleIds = new Set(memberRows.map((r) => r.chronicleId));
  const ownerChronicleIds = new Set(
    memberRows.filter((r) => r.role === 'owner').map((r) => r.chronicleId),
  );
  const openChronicleIds = new Set(
    memberRows.filter((r) => r.storyAccess === 'open').map((r) => r.chronicleId),
  );

  let visiblePersonIds = new Set<string>(personId ? [personId] : []);
  const needsGraph = personId !== null && memberRows.some((r) => r.storyAccess === 'family');
  if (needsGraph) {
    const edges = await db
      .select({
        type: relationships.type,
        personFromId: relationships.personFromId,
        personToId: relationships.personToId,
      })
      .from(relationships);
    visiblePersonIds = computeVisiblePersonIds(personId, edges);
  }

  return {
    userId,
    personId,
    visiblePersonIds,
    ownerChronicleIds,
    openChronicleIds,
    memberChronicleIds,
  };
}
