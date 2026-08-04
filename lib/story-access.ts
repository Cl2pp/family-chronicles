import { and, eq } from 'drizzle-orm';

/**
 * Story read-access core (docs/STORY_ACCESS_PLAN.md) — pure rule + thin DB shell.
 *
 * A story lives in exactly ONE chronicle (`stories.chronicle_id`), so access is always
 * evaluated against that one chronicle: `loadStoryAccessContext(userId, chronicleId)`
 * resolves the viewer's standing in THAT chronicle only — never across the whole
 * install. A user may read a story iff any of:
 *  1. they wrote it (`stories.submitted_by`) — regardless of membership, or
 *  2. they are a member of the story's chronicle AND either
 *     a. they hold an `owner` membership in it, or
 *     b. [`open` mode] every member reads every story, or
 *     c. [`family` mode] the story is tagged with ≥1 person in the viewer's
 *        visible-people set: self ∪ spouses ∪ blood(self) ∪ blood(each spouse),
 *        where blood(X) = all descendants of all ancestors of X (incl. X).
 *
 * A viewer who isn't a member of the story's chronicle gets nothing (rule 1 aside).
 * Explicitly excluded from the visible set: spouses of blood relatives (a
 * son-in-law alone is his family's material) and anything past a spouse's own
 * blood (the spouse's parents' side never leaks across the marriage).
 *
 * The rule runs on the kinship graph (`relationships`), never on surnames —
 * mirroring lib/family-tags.ts. Family graphs are small (hundreds of edges per
 * chronicle), so one chronicle's edges are loaded and walked in TS; no recursive SQL.
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
  /** The one chronicle this context was loaded for — every check below is scoped to it. */
  chronicleId: string;
  /** The viewer's person node in this chronicle (`people.user_id` + `people.chronicle_id`),
   *  or null if the viewer has no person here. */
  personId: string | null;
  /**
   * People whose stories the viewer may read under rule 2c (see module docs).
   * CAUTION: on the fast path (not `family` mode, or unlinked viewer) this is
   * an under-approximation holding just the viewer's own person —
   * `canReadStory` never consults it in that state, but any new consumer must
   * replicate its open/owner branching or it will wrongly deny in open mode.
   */
  visiblePersonIds: Set<string>;
  /** Whether the viewer holds ANY membership in this chronicle. */
  isMember: boolean;
  /** Whether the viewer's membership role in this chronicle is `owner`. */
  isOwner: boolean;
  /** Whether this chronicle's `story_access` is `open`. */
  isOpenMode: boolean;
}

/** The story facts the access rule consumes (a subset of any story row). */
export interface StoryAccessInput {
  submittedBy: string;
  /** The one chronicle this story lives in (`stories.chronicle_id`). */
  chronicleId: string;
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
 * The full read-access rule (pure). `ctx` is scoped to one chronicle
 * (`loadStoryAccessContext`'s second argument); a story from any OTHER chronicle
 * is denied outright (author bypass aside) — this also catches a caller
 * accidentally pairing a context with a story it wasn't loaded for.
 */
export function canReadStory(ctx: StoryAccessContext, story: StoryAccessInput): boolean {
  // Rule 1: the author always reads their own story.
  if (story.submittedBy === ctx.userId) return true;

  // Not the story's chronicle, or not a member of it: nothing.
  if (story.chronicleId !== ctx.chronicleId || !ctx.isMember) return false;
  // Owner bypass.
  if (ctx.isOwner) return true;
  // Legacy 'open' mode: every member reads every story.
  if (ctx.isOpenMode) return true;

  // 'family' mode: kinship. An unlinked viewer, or a story with zero tagged
  // people, grants nothing here — the tests above are the only way in.
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
 * Load the viewer's access context for ONE chronicle — the module's only DB
 * touchpoint. Resolves the viewer's membership (+ role) in `chronicleId`, that
 * chronicle's `story_access` mode, the viewer's person node IN THAT CHRONICLE
 * (a person belongs to exactly one chronicle — db/schema.ts), and — only when
 * the chronicle is in `family` mode and the viewer has a person there — that
 * chronicle's own kinship edges (`relationships.chronicle_id = ?`). Fast path:
 * in 'open' mode (or an unlinked viewer), `canReadStory` never consults the
 * graph, so edges are skipped and `visiblePersonIds` holds just the viewer's
 * own person.
 */
export async function loadStoryAccessContext(
  userId: string,
  chronicleId: string,
): Promise<StoryAccessContext> {
  // Lazy-import the DB so the pure core above stays importable without env/DB
  // (unit tests exercise the rule functions with in-memory fixtures only).
  const [{ db }, { chronicles, memberships, people, relationships }] = await Promise.all([
    import('@/db'),
    import('@/db/schema'),
  ]);

  const [memberRows, personRows] = await Promise.all([
    db
      .select({ role: memberships.accessRole, storyAccess: chronicles.storyAccess })
      .from(memberships)
      .innerJoin(chronicles, eq(memberships.chronicleId, chronicles.id))
      .where(and(eq(memberships.userId, userId), eq(memberships.chronicleId, chronicleId)))
      .limit(1),
    db
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.userId, userId), eq(people.chronicleId, chronicleId)))
      .limit(1),
  ]);

  const membership = memberRows[0];
  const personId = personRows[0]?.id ?? null;
  const isMember = membership !== undefined;
  const isOwner = membership?.role === 'owner';
  const isOpenMode = membership?.storyAccess === 'open';

  let visiblePersonIds = new Set<string>(personId ? [personId] : []);
  if (personId !== null && membership?.storyAccess === 'family') {
    const edges = await db
      .select({
        type: relationships.type,
        personFromId: relationships.personFromId,
        personToId: relationships.personToId,
      })
      .from(relationships)
      .where(eq(relationships.chronicleId, chronicleId));
    visiblePersonIds = computeVisiblePersonIds(personId, edges);
  }

  return {
    userId,
    chronicleId,
    personId,
    visiblePersonIds,
    isMember,
    isOwner,
    isOpenMode,
  };
}
