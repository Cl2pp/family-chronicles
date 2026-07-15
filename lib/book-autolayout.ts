import type { Block, ChapterPlan, CoverStyle, LayoutPlan, LayoutTheme } from '@/lib/book-layout-plan';

/**
 * The deterministic auto-layouter (docs/BOOK_LAYOUT_PLAN.md §5, producer #1): always
 * runs, zero cost, turns paragraph counts + image geometry into a `LayoutPlan`. Pure
 * function — no I/O, no randomness, same input always produces the same plan, which
 * is what makes re-renders stable. `lib/book-render.ts` calls this whenever a book has
 * no plan yet or its plan has gone stale.
 */

export interface AutoLayoutImage {
  assetId: string;
  /** Pixel dimensions after EXIF-orientation correction. Both required — the render
   *  job backfills these via sharp metadata before calling this function. */
  width: number;
  height: number;
}

export interface AutoLayoutChapter {
  storyId: string;
  /** Word count of each paragraph, in reading order (length = paragraph count). */
  paragraphWordCounts: number[];
  /** This chapter's photos, in a stable order (e.g. asset creation order). */
  images: AutoLayoutImage[];
}

export interface AutoLayoutInput {
  /** The book's explicit cover choice, if any (`books.cover_asset_id`) — always wins as the
   *  hero when set, overriding anything carried over from a previous plan. */
  coverAssetId: string | null;
  /** Theme/cover choices from a previous plan (auto, AI, or manually edited), carried
   *  forward so a content-only regeneration never silently resets a design choice —
   *  docs/BOOK_LAYOUT_PLAN.md §6 phase 4. Omit for a book with no prior plan. */
  existingTheme?: LayoutTheme;
  existingCoverStyle?: CoverStyle;
  /** Hero picked by a previous plan (e.g. the AI design pass) even when it was never
   *  pinned via `coverAssetId` — still preferred over re-picking the first photo. */
  existingHeroAssetId?: string;
  chapters: AutoLayoutChapter[];
}

/** Paragraphs between successive image insertions — fixed at the midpoint of the
 *  spec's 2-4 range so placement is deterministic. */
const PARAGRAPH_CHUNK = 3;

function resolution(img: AutoLayoutImage): number {
  return img.width * img.height;
}

/** Highest-resolution image; ties broken by assetId for determinism. */
function pickHighestResolution(images: AutoLayoutImage[]): AutoLayoutImage {
  return images.reduce((best, img) => {
    const r = resolution(img);
    const br = resolution(best);
    if (r > br) return img;
    if (r === br && img.assetId < best.assetId) return img;
    return best;
  });
}

/**
 * Builds the block list for one chapter: paragraphs interleaved with image groups.
 *
 * Heuristics (docs/BOOK_LAYOUT_PLAN.md §5, revised for the fill-the-page rules):
 * - A chapter with >=3 photos has its highest-resolution image promoted to its own
 *   `photo-page`, pulled out of the interleaved flow.
 * - Remaining images are consumed left-to-right, preferring groups that fill the
 *   column width: a trailing run of 3-4 images becomes a `photo-grid`; any two
 *   adjacent images pair into a justified `photo-row` (the renderer sizes both to
 *   one shared height across the full width, whatever the orientations); only a
 *   lone leftover image becomes a full-width centered `figure`. The auto-layouter
 *   never emits floats — a float whose neighboring text runs short leaves the photo
 *   glued to one side with white space beside it, exactly the asymmetry the layout
 *   rules forbid (floats remain available as a manual/AI choice).
 * - Image groups are inserted after every `PARAGRAPH_CHUNK` paragraphs; once the
 *   chapter's images run out, remaining paragraphs are appended as a trailing block.
 *   If more image groups exist than there are paragraph boundaries, the rest are
 *   appended after the last paragraph block (never before the first).
 */
function buildChapterBlocks(chapter: AutoLayoutChapter): Block[] {
  const paragraphCount = chapter.paragraphWordCounts.length;
  let pool = chapter.images.slice();

  let photoPageAssetId: string | null = null;
  if (pool.length >= 3) {
    const promoted = pickHighestResolution(pool);
    photoPageAssetId = promoted.assetId;
    pool = pool.filter((img) => img.assetId !== promoted.assetId);
  }

  // Last paragraph index of each PARAGRAPH_CHUNK-sized run — one potential image
  // insertion point per boundary.
  const boundaries: number[] = [];
  for (let end = PARAGRAPH_CHUNK - 1; end < paragraphCount; end += PARAGRAPH_CHUNK) {
    boundaries.push(end);
  }

  const groups: Block[] = [];
  let i = 0;
  let boundaryIdx = 0;
  while (i < pool.length) {
    const remaining = pool.length - i;
    const isLastInsertion = boundaryIdx >= boundaries.length - 1;
    if (isLastInsertion && remaining >= 3 && remaining <= 4) {
      groups.push({ type: 'photo-grid', assetIds: pool.slice(i).map((p) => p.assetId) });
      i = pool.length;
      break;
    }
    if (remaining >= 2) {
      groups.push({ type: 'photo-row', assetIds: [pool[i].assetId, pool[i + 1].assetId] });
      i += 2;
    } else {
      groups.push({ type: 'figure', assetId: pool[i].assetId, size: 'full' });
      i += 1;
    }
    boundaryIdx++;
  }

  const blocks: Block[] = [];
  let cursor = 0;
  let g = 0;
  for (const end of boundaries) {
    if (g >= groups.length) break;
    blocks.push({ type: 'paragraphs', from: cursor, to: end });
    blocks.push(groups[g]);
    cursor = end + 1;
    g++;
  }
  if (cursor <= paragraphCount - 1) {
    blocks.push({ type: 'paragraphs', from: cursor, to: paragraphCount - 1 });
  }
  while (g < groups.length) {
    blocks.push(groups[g]);
    g++;
  }
  if (photoPageAssetId) {
    blocks.push({ type: 'photo-page', assetId: photoPageAssetId });
  }
  return blocks;
}

/** Builds a full layout plan for a book from its chapters' content + image geometry. */
export function buildLayoutPlan(input: AutoLayoutInput): LayoutPlan {
  const chapters: ChapterPlan[] = input.chapters.map((chapter) => ({
    storyId: chapter.storyId,
    blocks: buildChapterBlocks(chapter),
  }));

  const heroAssetId =
    input.coverAssetId ?? input.existingHeroAssetId ?? input.chapters[0]?.images[0]?.assetId;
  const theme = input.existingTheme ?? 'classic';
  const coverStyle = input.existingCoverStyle ?? 'framed';

  return {
    theme,
    cover: heroAssetId ? { style: coverStyle, heroAssetId } : { style: coverStyle },
    chapters,
  };
}
