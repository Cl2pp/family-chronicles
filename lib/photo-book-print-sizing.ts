import {
  PHOTO_BOOK_BLEED_MM,
  PHOTO_BOOK_CONTENT_MARGIN_MM,
  rowStackCellSizesMm,
  TEMPLATE_ROW_ARRANGEMENT,
} from '@/lib/photo-book-layout';
import { isTextItem, type PhotoBookPlan } from '@/lib/photo-book-plan';

/** Pixel dimensions of the photos a plan places, keyed by assetId — lets the sizing
 *  functions below replay the renderer's exact justified-row math instead of guessing
 *  per-template slot fractions. */
export type PhotoDimsById = Map<string, { width: number; height: number }>;

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
/** Rough flowed-text density for the page-count ESTIMATE below — justified 10.5pt body
 *  on the 21×28 content box runs ~350 words/page; the real count still comes from the
 *  rendered PDF (`padPdf`). */
const WORDS_PER_TEXT_PAGE = 350;

export function countPhotoBookPages(
  plan: PhotoBookPlan,
  stories?: Array<{ storyId: string; paragraphWordCounts: number[] }>,
): number {
  const wordsByStory = new Map((stories ?? []).map((s) => [s.storyId, s.paragraphWordCounts]));
  const coverPages = 2; // front + back
  let sectionPages = 0;
  for (const section of plan.sections) {
    sectionPages += 1; // divider
    for (const page of section.pages) {
      if (isTextItem(page)) {
        // A flowing text run spans as many pages as its words need — estimated, since
        // only the renderer knows line breaks. Without word data: one page.
        const counts = section.storyId ? wordsByStory.get(section.storyId) : undefined;
        const words = counts
          ? counts.slice(page.from, page.to + 1).reduce((a, b) => a + b, 0)
          : WORDS_PER_TEXT_PAGE;
        sectionPages += Math.max(1, Math.ceil(words / WORDS_PER_TEXT_PAGE));
      } else {
        sectionPages += 1;
      }
    }
  }
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
  dims?: PhotoDimsById,
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
      // Text runs hold no photos — nothing to size (and with the story plan's floats
      // retired, no figure ever lives inside a text flow).
      if (isTextItem(page)) continue;
      const rows = TEMPLATE_ROW_ARRANGEMENT[page.template];
      if (rows) {
        // A justified row stack: replay the renderer's own math (shared helper — the
        // one source of geometry) so every photo is embedded at exactly the pixels its
        // cell prints at. A justified cell's width depends on its ROW-MATES' aspect
        // ratios (a landscape sharing a row with a portrait can span ~70% of the
        // width), which is why fixed per-template fractions systematically undershot.
        const photoDims = page.assetIds.map((id) => dims?.get(id));
        if (photoDims.every((d): d is { width: number; height: number } => d != null)) {
          const aspectRows: number[][] = [];
          let offset = 0;
          for (const size of rows) {
            aspectRows.push(photoDims.slice(offset, offset + size).map((d) => d.width / d.height));
            offset += size;
          }
          const cells = rowStackCellSizesMm(aspectRows, { w: contentW, h: contentH });
          let idx = 0;
          cells.forEach((row) =>
            row.forEach((cell) => {
              set(page.assetIds[idx], cell.w, cell.h);
              idx += 1;
            }),
          );
        } else {
          // Dimensions unknown (shouldn't happen for a placeable photo) — err large:
          // the whole content box per slot. Costs memory, never softens the print.
          for (const id of page.assetIds) set(id, contentW, contentH);
        }
        continue;
      }
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
      }
    }
  }
  return sizes;
}

/** The widest box (mm) each plan photo renders into on the PRINT page — the row-stack
 *  cell width for justified slots, the content box for full-page slots, the physical
 *  sheet for the cover hero/divider backdrops. Feeds `photoAssetRenditionNeeds` in
 *  `lib/photo-book-content.ts`: a slot wider than the ~1600px display rendition can
 *  serve at 300 dpi must print from the original. */
export function photoSlotPrintWidthsMm(
  plan: PhotoBookPlan,
  trim: { w: number; h: number },
  dims: PhotoDimsById,
): Map<string, number> {
  const widths = new Map<string, number>();
  for (const [id, size] of photoAssetPrintTargetSizeMm(plan, trim, dims)) {
    widths.set(id, size.w);
  }
  return widths;
}
