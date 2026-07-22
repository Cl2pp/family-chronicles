import { PHOTO_BOOK_BLEED_MM, PHOTO_BOOK_CONTENT_MARGIN_MM } from '@/lib/photo-book-layout';
import type { PhotoBookPlan } from '@/lib/photo-book-plan';

/**
 * Pure page-count/print-sizing math for photo-book plans — deliberately its own module,
 * separate from `lib/photo-book-content.ts` (which owns everything DB/S3-touching): this
 * file imports only `lib/photo-book-plan.ts` and `lib/photo-book-layout.ts`, both pure, so
 * it (and its test file) never drags in `@/db`/`@/lib/env`/`@/lib/s3` — the codebase's
 * existing test suite never imports anything on that chain (no test file needs a database
 * or a populated env to run), and this module keeps that property. Re-exported from
 * `lib/photo-book-content.ts` for convenience so existing callers there don't need a
 * second import path.
 */

/** Total page count of a photo-book plan, BEFORE Gelato page-count padding: cover front +
 *  back (2, always present, bleed pages) plus every section's divider page (1) and its
 *  photo pages. Shared by `lib/books.ts`'s `estimatePageCount` (a rough quote-screen
 *  estimate before any render exists) and, indirectly, `lib/book-render.ts`'s photo render
 *  path (which pads the ACTUAL rendered PDF to Gelato's rules via `pdf-lib`, not this
 *  count — but both describe "how many pages does this plan lay out to" and should never
 *  drift apart in their reasoning). */
export function countPhotoBookPages(plan: PhotoBookPlan): number {
  const coverPages = 2; // front + back
  const sectionPages = plan.sections.reduce(
    (sum, section) => sum + 1 /* divider */ + section.pages.length,
    0,
  );
  return coverPages + sectionPages;
}

/** A photo's target size in mm — the physical box its template slot occupies on the
 *  (bleed-inclusive) `print` page, so `lib/book-render.ts`'s photo embedding can downscale
 *  each original to exactly the pixels that box needs at 300 dpi instead of inlining full
 *  camera-resolution originals (docs/PHOTO_BOOK_PLAN.md §8's worker-sizing note — the
 *  thing that bounds render memory on a 100+ photo book). */
export interface PrintTargetSizeMm {
  w: number;
  h: number;
}

/**
 * Computes every plan-referenced photo's print target size from the plan's page templates
 * alone, using the SAME page-box math `lib/photo-book-layout.ts`'s `print` variant renders
 * with (`PHOTO_BOOK_BLEED_MM`/`PHOTO_BOOK_CONTENT_MARGIN_MM`, imported rather than
 * re-derived, so the two can never drift apart). A photo is only ever placed once in a
 * valid plan (`checkPhotoBookPlanConsistency` forbids reuse), so each assetId gets exactly
 * one definite target; the `Math.max` merge below is a defensive fallback for a plan that
 * (bypassing that check) somehow places one photo twice, not the expected path.
 *
 * Slot sizes are deliberately generous estimates (e.g. `full-framed` uses the whole
 * content box, though the actual matted frame inside it is a little smaller) — erring
 * large costs a little memory, erring small would visibly soften the print. Grid/row
 * templates split the content box evenly across their slots, which is the same
 * approximation `lib/book-render.ts`'s story-book path already accepts for its flat
 * 2000px print budget; here it's just applied per-slot instead of flat.
 */
export function photoAssetPrintTargetSizeMm(
  plan: PhotoBookPlan,
  trim: { w: number; h: number },
): Map<string, PrintTargetSizeMm> {
  const sizes = new Map<string, PrintTargetSizeMm>();
  const pageW = trim.w + PHOTO_BOOK_BLEED_MM * 2;
  const pageH = trim.h + PHOTO_BOOK_BLEED_MM * 2;
  const m = PHOTO_BOOK_CONTENT_MARGIN_MM;
  const contentW = pageW - m.inner - m.outer - PHOTO_BOOK_BLEED_MM * 2;
  const contentH = pageH - m.top - m.bottom - PHOTO_BOOK_BLEED_MM * 2;

  function set(id: string, w: number, h: number) {
    const prev = sizes.get(id);
    sizes.set(id, prev ? { w: Math.max(prev.w, w), h: Math.max(prev.h, h) } : { w, h });
  }

  if (plan.cover.heroAssetId) set(plan.cover.heroAssetId, pageW, pageH);
  // Back-cover photos are fixed-size (`.pb-cover-back-photos .ph-frame` in
  // `lib/photo-book-layout.ts`).
  for (const id of plan.cover.backAssetIds ?? []) set(id, 40, 50);

  for (const section of plan.sections) {
    for (const page of section.pages) {
      switch (page.template) {
        case 'divider':
          for (const id of page.assetIds) set(id, pageW, pageH);
          break;
        // `full-bleed` fills the content box (it sits inside the shared page frame like
        // every other photo page — see `lib/photo-book-layout.ts`), it no longer bleeds
        // to the physical sheet edge.
        case 'full-bleed':
        case 'full-framed':
          for (const id of page.assetIds) set(id, contentW, contentH);
          break;
        // The multi-photo templates are justified row stacks: any photo in a
        // single-photo row can span the full content width, and a photo in a shared row
        // gets a proportional share — the estimates below stay deliberately generous
        // (a row's height depends on its siblings' aspect ratios, unknown here).
        case 'two-horizontal':
          for (const id of page.assetIds) set(id, contentW, contentH / 2);
          break;
        case 'two-vertical':
          for (const id of page.assetIds) set(id, contentW / 2, contentH);
          break;
        case 'three-column':
          for (const id of page.assetIds) set(id, contentW / 3, contentH);
          break;
        case 'three-mixed': {
          const [dominant, ...rest] = page.assetIds;
          if (dominant) set(dominant, contentW, (contentH * 2) / 3);
          for (const id of rest) set(id, contentW / 2, contentH / 2);
          break;
        }
        case 'four-mixed': {
          const [dominant, ...rest] = page.assetIds;
          if (dominant) set(dominant, contentW, (contentH * 2) / 3);
          for (const id of rest) set(id, contentW / 3, contentH / 2);
          break;
        }
        case 'collage-4':
          for (const id of page.assetIds) set(id, contentW / 2, contentH / 2);
          break;
        case 'collage-5':
          for (const id of page.assetIds) set(id, contentW / 2, contentH / 2);
          break;
        case 'collage-6':
          for (const id of page.assetIds) set(id, contentW / 2, contentH / 2);
          break;
      }
    }
  }
  return sizes;
}
