import { z } from 'zod';

/**
 * The layout plan: the data source of truth for how a book is typeset (see
 * docs/BOOK_LAYOUT_PLAN.md §1). Stored on `books.layout_plan` (jsonb), produced by
 * the auto-layouter (`lib/book-autolayout.ts`) today; a future AI pass and builder
 * UI edits will write the same shape. `lib/book-layout.ts` renders any plan that
 * validates against this schema — it never hard-codes a layout again.
 */

export const LAYOUT_THEMES = ['classic', 'modern'] as const;
export type LayoutTheme = (typeof LAYOUT_THEMES)[number];

export const COVER_STYLES = ['framed', 'full-bleed'] as const;
export type CoverStyle = (typeof COVER_STYLES)[number];

export const FIGURE_SIZES = ['full', 'float-left', 'float-right'] as const;
export type FigureSize = (typeof FIGURE_SIZES)[number];

const paragraphsBlockSchema = z.object({
  type: z.literal('paragraphs'),
  /** Inclusive start/end indices into the chapter's paragraph array. */
  from: z.int().nonnegative(),
  to: z.int().nonnegative(),
});
export type ParagraphsBlock = z.infer<typeof paragraphsBlockSchema>;

const figureBlockSchema = z.object({
  type: z.literal('figure'),
  assetId: z.string(),
  size: z.enum(FIGURE_SIZES),
});
export type FigureBlock = z.infer<typeof figureBlockSchema>;

const photoRowBlockSchema = z.object({
  type: z.literal('photo-row'),
  assetIds: z.array(z.string()).length(2),
});
export type PhotoRowBlock = z.infer<typeof photoRowBlockSchema>;

const photoGridBlockSchema = z.object({
  type: z.literal('photo-grid'),
  assetIds: z.array(z.string()).min(3).max(4),
});
export type PhotoGridBlock = z.infer<typeof photoGridBlockSchema>;

const photoPageBlockSchema = z.object({
  type: z.literal('photo-page'),
  assetId: z.string(),
});
export type PhotoPageBlock = z.infer<typeof photoPageBlockSchema>;

export const blockSchema = z.discriminatedUnion('type', [
  paragraphsBlockSchema,
  figureBlockSchema,
  photoRowBlockSchema,
  photoGridBlockSchema,
  photoPageBlockSchema,
]);
export type Block = z.infer<typeof blockSchema>;

const chapterPlanSchema = z.object({
  storyId: z.string(),
  blocks: z.array(blockSchema),
});
export type ChapterPlan = z.infer<typeof chapterPlanSchema>;

const coverPlanSchema = z.object({
  style: z.enum(COVER_STYLES),
  heroAssetId: z.string().optional(),
});
export type CoverPlan = z.infer<typeof coverPlanSchema>;

export const layoutPlanSchema = z.object({
  theme: z.enum(LAYOUT_THEMES),
  cover: coverPlanSchema,
  chapters: z.array(chapterPlanSchema),
});
export type LayoutPlan = z.infer<typeof layoutPlanSchema>;

export interface LayoutPlanValidationError {
  ok: false;
  error: string;
}

/** Parses + validates a layout plan against the schema. Throws nothing; returns a Result. */
export function validateLayoutPlan(
  data: unknown,
): { ok: true; plan: LayoutPlan } | LayoutPlanValidationError {
  const result = layoutPlanSchema.safeParse(data);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => i.message).join('; ') };
  }
  return { ok: true, plan: result.data };
}

/** Minimal shape of "what the book currently contains", for consistency checking. */
export interface PlanContent {
  chapters: Array<{
    storyId: string;
    paragraphCount: number;
    /** Asset ids of photos available to this chapter (respects includePhotos). */
    assetIds: string[];
  }>;
  /** Every photo asset id in the book, regardless of a chapter's includePhotos flag —
   *  `cover.heroAssetId` may reference one of these even when its own chapter excludes
   *  photos from the flowed text (see lib/book-content.ts `LoadedBook.allPhotosById`).
   *  Optional for backward compatibility; when omitted the cover hero is not checked. */
  allAssetIds?: string[];
}

/**
 * Checks a plan against the book's current content: every storyId/assetId the plan
 * references must still exist, and every chapter's paragraphs must be covered
 * exactly once, in ascending order, with no gaps or overlaps. Used to decide whether
 * a stored plan is still usable or must be regenerated (see `layout_stale`).
 */
export function checkPlanConsistency(plan: LayoutPlan, content: PlanContent): string[] {
  const problems: string[] = [];
  const contentByStory = new Map(content.chapters.map((c) => [c.storyId, c]));

  const planStoryIds = new Set(plan.chapters.map((c) => c.storyId));
  for (const c of content.chapters) {
    if (!planStoryIds.has(c.storyId)) problems.push(`Plan is missing chapter for story ${c.storyId}`);
  }

  if (content.allAssetIds && plan.cover.heroAssetId) {
    if (!content.allAssetIds.includes(plan.cover.heroAssetId)) {
      problems.push(`Cover references unknown asset ${plan.cover.heroAssetId}`);
    }
  }

  for (const chapter of plan.chapters) {
    const info = contentByStory.get(chapter.storyId);
    if (!info) {
      problems.push(`Plan references unknown story ${chapter.storyId}`);
      continue;
    }
    const validAssetIds = new Set(info.assetIds);

    const paragraphRanges: Array<[number, number]> = [];
    for (const block of chapter.blocks) {
      switch (block.type) {
        case 'paragraphs':
          if (block.from > block.to) {
            problems.push(
              `Story ${chapter.storyId}: paragraphs block has from(${block.from}) > to(${block.to})`,
            );
          } else {
            paragraphRanges.push([block.from, block.to]);
          }
          break;
        case 'figure':
        case 'photo-page':
          if (!validAssetIds.has(block.assetId)) {
            problems.push(`Story ${chapter.storyId}: unknown asset ${block.assetId}`);
          }
          break;
        case 'photo-row':
        case 'photo-grid':
          for (const id of block.assetIds) {
            if (!validAssetIds.has(id)) {
              problems.push(`Story ${chapter.storyId}: unknown asset ${id}`);
            }
          }
          break;
      }
    }

    paragraphRanges.sort((a, b) => a[0] - b[0]);
    let expected = 0;
    for (const [from, to] of paragraphRanges) {
      if (from !== expected) {
        problems.push(
          `Story ${chapter.storyId}: paragraph coverage gap/overlap at index ${expected} (block starts at ${from})`,
        );
        break;
      }
      expected = to + 1;
    }
    if (expected !== info.paragraphCount) {
      problems.push(
        `Story ${chapter.storyId}: paragraphs covered up to ${expected}, but chapter has ${info.paragraphCount}`,
      );
    }
  }

  return problems;
}

export function isPlanConsistent(plan: LayoutPlan, content: PlanContent): boolean {
  return checkPlanConsistency(plan, content).length === 0;
}
