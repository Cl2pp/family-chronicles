import { describe, expect, it } from 'vitest';
import {
  decideChapterOrder,
  isDateOrdered,
  reorderChapterSections,
  sortByDate,
  type StoryDateKeys,
} from '@/lib/book-chapter-order';
import type { PhotoBookPlan } from '@/lib/photo-book-plan';

const d = (iso: string) => new Date(iso);

// A: 1954, B: 1968, C: 1972, D: 1980, U: undated (created after everything).
// T1/T2 tie on both keys — a seeded batch.
const keys: StoryDateKeys = new Map([
  ['A', { eventDate: d('1954-06-15'), createdAt: d('2026-01-01') }],
  ['B', { eventDate: d('1968-06-15'), createdAt: d('2026-01-01') }],
  ['C', { eventDate: d('1972-06-15'), createdAt: d('2026-01-01') }],
  ['D', { eventDate: d('1980-06-15'), createdAt: d('2026-01-01') }],
  ['U', { eventDate: null, createdAt: d('2026-02-01') }],
  ['T1', { eventDate: d('1990-01-01'), createdAt: d('2026-03-01') }],
  ['T2', { eventDate: d('1990-01-01'), createdAt: d('2026-03-01') }],
]);

describe('sortByDate / isDateOrdered', () => {
  it('sorts by event date, undated last, and is stable across ties', () => {
    expect(sortByDate(['U', 'C', 'A', 'B'], keys)).toEqual(['A', 'B', 'C', 'U']);
    expect(sortByDate(['T2', 'T1'], keys)).toEqual(['T2', 'T1']);
    expect(sortByDate(['T1', 'T2'], keys)).toEqual(['T1', 'T2']);
  });

  it('treats ties and the empty list as ordered, and undated as latest', () => {
    expect(isDateOrdered([], keys)).toBe(true);
    expect(isDateOrdered(['A', 'B', 'C', 'U'], keys)).toBe(true);
    expect(isDateOrdered(['T2', 'T1'], keys)).toBe(true);
    expect(isDateOrdered(['A', 'C', 'B'], keys)).toBe(false);
    expect(isDateOrdered(['U', 'A'], keys)).toBe(false);
  });

  it('puts unknown ids last without throwing', () => {
    expect(sortByDate(['X', 'B', 'A'], keys)).toEqual(['A', 'B', 'X']);
    expect(isDateOrdered(['A', 'X'], keys)).toBe(true);
  });
});

describe('decideChapterOrder', () => {
  it('a real move switches to custom and keeps the requested order', () => {
    expect(
      decideChapterOrder({ previousIds: ['A', 'B', 'C'], requested: ['A', 'C', 'B'], keys }),
    ).toEqual({ ordered: ['A', 'C', 'B'], switchedToCustom: true });
  });

  it('a pure remove keeps date order and the grouping', () => {
    expect(
      decideChapterOrder({ previousIds: ['A', 'B', 'C'], requested: ['A', 'C'], keys }),
    ).toEqual({ ordered: ['A', 'C'], switchedToCustom: false });
  });

  it('an appended story on a date-ordered book is slotted in by date', () => {
    expect(
      decideChapterOrder({ previousIds: ['A', 'C', 'D'], requested: ['A', 'C', 'D', 'B'], keys }),
    ).toEqual({ ordered: ['A', 'B', 'C', 'D'], switchedToCustom: false });
  });

  it('an appended story that IS the newest changes nothing', () => {
    expect(
      decideChapterOrder({ previousIds: ['A', 'B'], requested: ['A', 'B', 'D'], keys }),
    ).toEqual({ ordered: ['A', 'B', 'D'], switchedToCustom: false });
  });

  it('a legacy hand-ordered book becomes custom on its next add instead of being re-sorted', () => {
    expect(
      decideChapterOrder({ previousIds: ['C', 'A', 'B'], requested: ['C', 'A', 'B', 'D'], keys }),
    ).toEqual({ ordered: ['C', 'A', 'B', 'D'], switchedToCustom: true });
  });

  it('a book that only ties on the sort keys is NOT mistaken for a custom one', () => {
    expect(
      decideChapterOrder({ previousIds: ['T2', 'T1'], requested: ['T2', 'T1', 'A'], keys }),
    ).toEqual({ ordered: ['A', 'T2', 'T1'], switchedToCustom: false });
  });

  it('a caller-supplied order with nothing retained is honoured as custom', () => {
    // First chapters of a pure photo book, or every chapter replaced at once.
    expect(decideChapterOrder({ previousIds: [], requested: ['B', 'A'], keys })).toEqual({
      ordered: ['B', 'A'],
      switchedToCustom: true,
    });
    expect(decideChapterOrder({ previousIds: ['C'], requested: ['B', 'A'], keys })).toEqual({
      ordered: ['B', 'A'],
      switchedToCustom: true,
    });
    // …but one that happens to be in date order needs no switch.
    expect(decideChapterOrder({ previousIds: [], requested: ['A', 'B'], keys })).toEqual({
      ordered: ['A', 'B'],
      switchedToCustom: false,
    });
  });
});

describe('reorderChapterSections', () => {
  const plan: PhotoBookPlan = {
    kind: 'photo',
    style: 'classic',
    cover: { heroAssetId: 'h', title: 'T' },
    sections: [
      { title: 'A', storyId: 'A', pages: [{ template: 'full-bleed', assetIds: ['a1'] }] },
      { title: 'Photos', pages: [{ template: 'full-bleed', assetIds: ['p1'] }] },
      { title: 'B', storyId: 'B', pages: [{ template: 'full-bleed', assetIds: ['b1'] }] },
      { title: 'Ghost', storyId: 'Z', pages: [{ template: 'full-bleed', assetIds: ['z1'] }] },
      { title: 'C', storyId: 'C', pages: [{ template: 'full-bleed', assetIds: ['c1'] }] },
    ],
  };

  it('moves chapter sections into the same slots in the new order, leaving the rest put', () => {
    const out = reorderChapterSections(plan, ['C', 'A', 'B']);
    expect(out.sections.map((s) => s.title)).toEqual(['C', 'Photos', 'A', 'Ghost', 'B']);
    // Untouched input.
    expect(plan.sections.map((s) => s.title)).toEqual(['A', 'Photos', 'B', 'Ghost', 'C']);
  });

  it('is a no-op for an order the plan already has', () => {
    expect(reorderChapterSections(plan, ['A', 'B', 'C']).sections).toEqual(plan.sections);
  });
});
