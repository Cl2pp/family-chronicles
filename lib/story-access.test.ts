import { describe, expect, it } from 'vitest';
import {
  MAX_GENERATIONS,
  canReadStory,
  computeVisiblePersonIds,
  filterReadableStories,
  type KinshipEdge,
  type StoryAccessContext,
  type StoryAccessInput,
} from './story-access';

function parent(from: string, to: string): KinshipEdge {
  return { type: 'parent', personFromId: from, personToId: to };
}

function spouse(a: string, b: string): KinshipEdge {
  return { type: 'spouse', personFromId: a, personToId: b };
}

/** Spouse edge plus both-parent edges for every child. */
function couple(a: string, b: string, children: string[]): KinshipEdge[] {
  return [spouse(a, b), ...children.flatMap((c) => [parent(a, c), parent(b, c)])];
}

// The plan's worked-example family (docs/STORY_ACCESS_PLAN.md):
// Anna Ortlepp ⚭ Ben Hartwick, children Clara & Max. Anna's parents Otto &
// Olga; Ben's parents Hans & Helga; Ben's paternal grandfather Gustav.
const FAMILY: KinshipEdge[] = [
  ...couple('anna', 'ben', ['clara', 'max']),
  ...couple('otto', 'olga', ['anna']),
  ...couple('hans', 'helga', ['ben']),
  parent('gustav', 'hans'),
];

/** Whether `viewer` may see a story tagged with exactly `tagged` (rule 3 only). */
function sees(viewer: string, tagged: string[]): boolean {
  const visible = computeVisiblePersonIds(viewer, FAMILY);
  return tagged.some((id) => visible.has(id));
}

describe('computeVisiblePersonIds', () => {
  it('matches the worked-example table (Otto and Anna rows)', () => {
    const table: [tagged: string[], otto: boolean, anna: boolean][] = [
      [['hans', 'helga'], false, true],
      [['hans', 'helga', 'gustav'], false, true],
      [['hans', 'helga', 'clara'], true, true],
      [['hans', 'helga', 'anna'], true, true],
      [['ben'], false, true],
      [['max'], true, true],
    ];
    for (const [tagged, otto, anna] of table) {
      expect(sees('otto', tagged), `Otto vs [${tagged}]`).toBe(otto);
      expect(sees('anna', tagged), `Anna vs [${tagged}]`).toBe(anna);
    }
  });

  it('grants siblings access to each other', () => {
    expect(sees('max', ['clara'])).toBe(true);
    expect(sees('clara', ['max'])).toBe(true);
  });

  it('grants grandparent and grandchild access in both directions', () => {
    expect(sees('otto', ['clara'])).toBe(true); // grandchild
    expect(sees('clara', ['otto'])).toBe(true); // grandparent
    // Any depth: Gustav is Clara's great-grandparent.
    expect(sees('gustav', ['clara'])).toBe(true);
    expect(sees('clara', ['gustav'])).toBe(true);
  });

  it("does not extend a spouse's blood to the spouse's parents", () => {
    // Anna (spouse Ben) sees Ben's parents, but her father Otto does not.
    expect(sees('anna', ['hans', 'helga'])).toBe(true);
    const otto = computeVisiblePersonIds('otto', FAMILY);
    expect(otto.has('hans')).toBe(false);
    expect(otto.has('helga')).toBe(false);
    expect(otto.has('gustav')).toBe(false);
    // ...and vice versa across the marriage: Hans never sees Anna's side.
    const hans = computeVisiblePersonIds('hans', FAMILY);
    expect(hans.has('anna')).toBe(false);
    expect(hans.has('otto')).toBe(false);
  });

  it('excludes spouses of blood relatives (son-in-law)', () => {
    // A story tagged only with Ben is his family's material, not Otto's.
    expect(sees('otto', ['ben'])).toBe(false);
    expect(computeVisiblePersonIds('otto', FAMILY).has('ben')).toBe(false);
  });

  it('always includes self and spouses', () => {
    const otto = computeVisiblePersonIds('otto', FAMILY);
    expect(otto.has('otto')).toBe(true);
    expect(otto.has('olga')).toBe(true);
  });

  it('caps deep chains at MAX_GENERATIONS in each direction', () => {
    // p0 → p1 → … → p30, each the parent of the next.
    const chainLength = MAX_GENERATIONS + 5;
    const chain: KinshipEdge[] = [];
    for (let i = 0; i < chainLength; i++) chain.push(parent(`p${i}`, `p${i + 1}`));

    // Viewer at the bottom: ancestors up to exactly MAX_GENERATIONS steps.
    const bottom = computeVisiblePersonIds(`p${chainLength}`, chain);
    expect(bottom.has(`p${chainLength - MAX_GENERATIONS}`)).toBe(true);
    expect(bottom.has(`p${chainLength - MAX_GENERATIONS - 1}`)).toBe(false);

    // Viewer at the top: descendants up to exactly MAX_GENERATIONS steps.
    const top = computeVisiblePersonIds('p0', chain);
    expect(top.has(`p${MAX_GENERATIONS}`)).toBe(true);
    expect(top.has(`p${MAX_GENERATIONS + 1}`)).toBe(false);
  });

  it('terminates on parent and spouse cycles', () => {
    const cyclic: KinshipEdge[] = [
      parent('a', 'b'),
      parent('b', 'a'), // parent cycle
      spouse('a', 'b'),
      spouse('b', 'a'), // duplicated spouse edge, both orders
    ];
    const visible = computeVisiblePersonIds('a', cyclic);
    expect(visible).toEqual(new Set(['a', 'b']));
  });
});

function ctx(over: Partial<StoryAccessContext> = {}): StoryAccessContext {
  return {
    userId: 'user-anna',
    personId: 'anna',
    visiblePersonIds: computeVisiblePersonIds('anna', FAMILY),
    ownerChronicleIds: new Set(),
    openChronicleIds: new Set(),
    memberChronicleIds: new Set(['fam']), // 'fam' is a family-mode chronicle
    ...over,
  };
}

function story(over: Partial<StoryAccessInput> = {}): StoryAccessInput {
  return { submittedBy: 'user-other', chronicleIds: ['fam'], personIds: [], ...over };
}

describe('canReadStory', () => {
  it('grants family-mode access via a tagged visible person', () => {
    expect(canReadStory(ctx(), story({ personIds: ['hans'] }))).toBe(true);
    expect(canReadStory(ctx(), story({ personIds: ['stranger'] }))).toBe(false);
  });

  it('lets owners read everything in their chronicle', () => {
    const owner = ctx({
      personId: null,
      visiblePersonIds: new Set(),
      ownerChronicleIds: new Set(['fam']),
    });
    expect(canReadStory(owner, story({ personIds: ['stranger'] }))).toBe(true);
    expect(canReadStory(owner, story({ personIds: [] }))).toBe(true);
  });

  it('lets the author read their own story regardless of membership', () => {
    const author = ctx({
      personId: null,
      visiblePersonIds: new Set(),
      memberChronicleIds: new Set(),
    });
    expect(canReadStory(author, story({ submittedBy: 'user-anna' }))).toBe(true);
  });

  it('lets every member read every story in an open-mode chronicle', () => {
    const member = ctx({
      openChronicleIds: new Set(['fam']),
      visiblePersonIds: new Set(['anna']),
    });
    expect(canReadStory(member, story({ personIds: ['stranger'] }))).toBe(true);
    expect(canReadStory(member, story({ personIds: [] }))).toBe(true);
  });

  it('restricts zero-people stories to author and owners in family mode', () => {
    const zero = story({ personIds: [] });
    expect(canReadStory(ctx(), zero)).toBe(false); // plain member
    expect(canReadStory(ctx({ ownerChronicleIds: new Set(['fam']) }), zero)).toBe(true);
    expect(canReadStory(ctx(), story({ personIds: [], submittedBy: 'user-anna' }))).toBe(true);
  });

  it('gives users without a person link only their own stories', () => {
    const unlinked = ctx({ personId: null, visiblePersonIds: new Set() });
    expect(canReadStory(unlinked, story({ personIds: ['anna'] }))).toBe(false);
    expect(canReadStory(unlinked, story({ submittedBy: 'user-anna' }))).toBe(true);
  });

  it('grants access when ANY of the story’s chronicles does (open membership wins)', () => {
    const member = ctx({
      memberChronicleIds: new Set(['fam', 'open']),
      openChronicleIds: new Set(['open']),
    });
    const shared = story({ chronicleIds: ['fam', 'open'], personIds: ['stranger'] });
    expect(canReadStory(member, shared)).toBe(true);
    // Without the open share, the family-mode chronicle alone denies it.
    expect(canReadStory(member, story({ personIds: ['stranger'] }))).toBe(false);
  });

  it('grants nothing through chronicles the user is not a member of', () => {
    // Even a story tagged with a visible person is invisible when it is only
    // shared into chronicles outside the user's memberships.
    const foreign = story({ chronicleIds: ['elsewhere'], personIds: ['anna'] });
    expect(canReadStory(ctx(), foreign)).toBe(false);
    // Owner role elsewhere doesn't help either.
    const owner = ctx({ ownerChronicleIds: new Set(['fam']) });
    expect(canReadStory(owner, foreign)).toBe(false);
  });
});

describe('filterReadableStories', () => {
  it('keeps only readable stories and preserves extra fields', () => {
    const stories = [
      { id: 's1', ...story({ personIds: ['clara'] }) },
      { id: 's2', ...story({ personIds: ['stranger'] }) },
      { id: 's3', ...story({ submittedBy: 'user-anna' }) },
      { id: 's4', ...story({ chronicleIds: ['elsewhere'], personIds: ['anna'] }) },
    ];
    expect(filterReadableStories(ctx(), stories).map((s) => s.id)).toEqual(['s1', 's3']);
  });
});
