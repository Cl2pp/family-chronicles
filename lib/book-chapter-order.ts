/**
 * Chapter order vs. the book's grouping (`lib/photo-book-grouping.ts`): every grouping but
 * `custom` promises the story chapters run by date; `custom` is the reader's own order.
 * The decisions that keep that promise honest are pure and live here, tested; the DB
 * plumbing around them (`setBookStories`, `createBook`, `updatePhotoBookSettings` in
 * `lib/books.ts`) only fetches the dates and applies the answer.
 *
 * "By date" is `(event_date, created_at)` — the order `readyStoriesForChronicle` starts
 * every book with (undated stories last, like Postgres `ASC`). Ties are real: `created_at`
 * is frozen per transaction, so a seeded batch shares one timestamp. `isDateOrdered` is
 * therefore tie-TOLERANT (non-decreasing), while `sortByDate` is a stable sort that keeps
 * the given order among ties — so a book that only ties is never mistaken for a custom one.
 */

import type { PhotoBookPlan } from '@/lib/photo-book-plan';

/** The sort keys of one story. `eventDate` null = undated (sorts last). */
export interface StoryDateKey {
  eventDate: Date | null;
  createdAt: Date;
}

export type StoryDateKeys = ReadonlyMap<string, StoryDateKey>;

/** Element-wise equality of two id lists — "these chapters are in that order". */
export const sameOrder = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

function compareKeys(a: StoryDateKey | undefined, b: StoryDateKey | undefined): number {
  // Unknown keys (an id the lookup didn't return — shouldn't happen after
  // `ensureUsableBookStories`) sort after everything, keeping their relative order.
  if (!a || !b) return (a ? 0 : 1) - (b ? 0 : 1);
  const ea = a.eventDate?.getTime() ?? Number.POSITIVE_INFINITY;
  const eb = b.eventDate?.getTime() ?? Number.POSITIVE_INFINITY;
  if (ea !== eb) return ea < eb ? -1 : 1;
  return a.createdAt.getTime() - b.createdAt.getTime();
}

/** `ids` sorted by date, stable — ties keep the order they came in. */
export function sortByDate(ids: readonly string[], keys: StoryDateKeys): string[] {
  return ids
    .map((id, index) => ({ id, index }))
    .sort((a, b) => compareKeys(keys.get(a.id), keys.get(b.id)) || a.index - b.index)
    .map((x) => x.id);
}

/** True when `ids` never go backwards in date (ties allowed). An empty list is ordered. */
export function isDateOrdered(ids: readonly string[], keys: StoryDateKeys): boolean {
  for (let i = 1; i < ids.length; i++) {
    if (compareKeys(keys.get(ids[i - 1]), keys.get(ids[i])) > 0) return false;
  }
  return true;
}

export interface ChapterOrderDecision {
  /** The order to store. */
  ordered: string[];
  /** True when the book has to switch to the `custom` grouping. */
  switchedToCustom: boolean;
}

/**
 * What a full chapter replace (`setBookStories`) does to a NON-custom book — a `custom`
 * book always keeps exactly the requested order and never gets here.
 *
 * - Chapters moved relative to each other (a real reorder): store as requested and switch
 *   to `custom` — that's the reader's own order.
 * - Otherwise a pure add/remove. If the previous chapters were in date order, keep the
 *   promise: slot the newcomers in by date (stable, so nothing else moves). If they were
 *   NOT (a book reordered before `custom` existed, or all chapters replaced at once by a
 *   caller with an order of its own), that order is a custom one that just hadn't been
 *   named yet: store as requested and switch to `custom`.
 * - Nothing to decide when the result is in date order anyway.
 */
export function decideChapterOrder(input: {
  previousIds: readonly string[];
  requested: readonly string[];
  keys: StoryDateKeys;
}): ChapterOrderDecision {
  const { previousIds, requested, keys } = input;
  const previous = new Set(previousIds);
  const retainedNow = requested.filter((id) => previous.has(id));
  const retainedSet = new Set(retainedNow);
  const retainedBefore = previousIds.filter((id) => retainedSet.has(id));

  if (!sameOrder(retainedNow, retainedBefore)) {
    return { ordered: [...requested], switchedToCustom: true };
  }
  if (isDateOrdered(requested, keys)) {
    return { ordered: [...requested], switchedToCustom: false };
  }
  const hadDateOrder = retainedNow.length > 0 && isDateOrdered(previousIds, keys);
  return hadDateOrder
    ? { ordered: sortByDate(requested, keys), switchedToCustom: false }
    : { ordered: [...requested], switchedToCustom: true };
}

/**
 * The plan's chapter sections (those carrying a `storyId` in `order`) rearranged to
 * follow `order`, occupying the same slots they did before; every other section — photo
 * sections, sections for stories not in `order` — stays where it is.
 */
export function reorderChapterSections(plan: PhotoBookPlan, order: readonly string[]): PhotoBookPlan {
  const rank = new Map(order.map((id, i) => [id, i]));
  const slots = plan.sections
    .map((section, index) => ({ section, index }))
    .filter(({ section }) => section.storyId !== undefined && rank.has(section.storyId));
  const sorted = [...slots].sort(
    (a, b) => rank.get(a.section.storyId!)! - rank.get(b.section.storyId!)!,
  );
  const sections = plan.sections.slice();
  slots.forEach(({ index }, i) => {
    sections[index] = sorted[i].section;
  });
  return { ...plan, sections };
}
