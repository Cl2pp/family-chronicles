import { validateLayoutPlan } from '@/lib/book-layout-plan';
import { validatePhotoBookPlan } from '@/lib/photo-book-plan';

/**
 * Which ENGINE a book renders through (unified-book plan, PR C).
 *
 * The unification replaced the story-book stack with the photo-book one, but Clemens'
 * requirement is that existing memoir books keep their exact current look until their
 * owner actively regenerates them. So the discriminator is not `books.kind` (which is
 * now only an entry-point marker) and not a new column — it's the SHAPE OF THE STORED
 * PLAN itself:
 *
 *  - a plan that validates as the old `LayoutPlan` (`lib/book-layout-plan.ts`: has
 *    `theme`, blocks with `type`) → `'legacy'`: rendered by the old story renderer,
 *    edited by the old builder, exactly as before;
 *  - a plan that validates as a `PhotoBookPlan`, or NO plan at all → `'unified'`: a book
 *    with no plan has no look to preserve, so it gets the new engine immediately.
 *
 * Storing this in the data rather than in a flag means there is no migration to run and
 * no state to get out of sync: converting a book is simply "clear its legacy plan", and
 * the fork follows automatically. The legacy stack can be deleted once no book in
 * production answers `'legacy'`.
 */
export type BookEngine = 'legacy' | 'unified';

export function bookEngineFor(layoutPlan: unknown): BookEngine {
  if (layoutPlan == null) return 'unified';
  // Check the unified shape FIRST: it carries `kind: 'photo'`, so it can never be
  // mistaken for a legacy plan, whereas a malformed plan should not be treated as
  // legacy just because it fails the newer schema.
  if (validatePhotoBookPlan(layoutPlan).ok) return 'unified';
  return validateLayoutPlan(layoutPlan).ok ? 'legacy' : 'unified';
}

/** True when this book still renders through the retired story-book stack. */
export function isLegacyStoryPlan(layoutPlan: unknown): boolean {
  return bookEngineFor(layoutPlan) === 'legacy';
}
