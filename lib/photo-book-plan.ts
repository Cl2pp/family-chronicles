import { z } from 'zod';

/**
 * The photo-book layout plan (docs/PHOTO_BOOK_PLAN.md §5): the photo-book counterpart of
 * `lib/book-layout-plan.ts`'s `LayoutPlan`, stored in the same `books.layout_plan` jsonb
 * column. Same philosophy: **layout is data** — the deterministic auto-layouter
 * (`lib/photo-book-autolayout.ts`) writes this shape today; a future AI pass (PR3) and
 * targeted builder/chat edits (PR4) write the same shape; `lib/photo-book-layout.ts`
 * renders whatever validates against this schema.
 *
 * `books.layout_plan` is untyped jsonb shared by both book kinds — the discriminator
 * between "this is a `LayoutPlan`" and "this is a `PhotoBookPlan`" is the OWNING ROW's
 * `books.kind` column, not a field inside the JSON itself (mirrors how every caller today
 * — `preview-html`, `getBookLayoutSummary`, `updateBookLayout` — already branches on
 * `book.kind` before ever touching `layoutPlan`). `kind: 'photo'` is still stamped onto
 * the plan itself as a defensive tag (so a plan accidentally loaded through the wrong
 * validator fails fast instead of silently misparsing), but it is never the switch a
 * caller reads first.
 */

/** All 6 style suites (docs/PHOTO_BOOK_PLAN.md §7) — PR2 shipped `classic`/`modern`/
 *  `gallery`; PR5 adds `heirloom`/`bold`/`journal`. The canonical id list lives here (not
 *  `lib/photo-book-styles.ts`) so the plan schema's `style` enum is the single source of
 *  truth — `lib/photo-book-styles.ts` imports `PhotoBookStyle` and maps each id to its
 *  design tokens (palette, photo treatment, cover design) and, since PR5, its self-hosted
 *  font pairing (`lib/photo-book-fonts.ts`) — exactly like `LAYOUT_THEMES`/`THEME_TOKENS`
 *  split between `lib/book-layout-plan.ts` and `lib/book-layout.ts`. */
export const PHOTO_BOOK_STYLES = ['classic', 'modern', 'gallery', 'heirloom', 'bold', 'journal'] as const;
export type PhotoBookStyle = (typeof PHOTO_BOOK_STYLES)[number];

/** The fixed layout vocabulary (docs/PHOTO_BOOK_PLAN.md §5 table). Slot counts are
 *  enforced per-template below (mirrors `photoRowBlockSchema`/`photoGridBlockSchema` in
 *  `lib/book-layout-plan.ts`, which do the same thing for the story plan's blocks). */
export const PHOTO_PAGE_TEMPLATES = [
  'full-bleed',
  'full-framed',
  'two-horizontal',
  'two-vertical',
  'three-column',
  'three-mixed',
  'four-mixed',
  'collage-4',
  'collage-5',
  'collage-6',
  'divider',
] as const;
export type PhotoPageTemplate = (typeof PHOTO_PAGE_TEMPLATES)[number];

/** How many photo slots each template takes — a fixed number, or a `{min,max}` range for
 *  `divider` (a section opener with an optional single muted photo). Exported so both the
 *  schema below and `lib/photo-book-autolayout.ts` (which never needs to import zod) share
 *  one definition of "how many photos does a `two-horizontal` page take". */
export const PHOTO_PAGE_TEMPLATE_SLOTS: Record<PhotoPageTemplate, { min: number; max: number }> = {
  'full-bleed': { min: 1, max: 1 },
  'full-framed': { min: 1, max: 1 },
  'two-horizontal': { min: 2, max: 2 },
  'two-vertical': { min: 2, max: 2 },
  'three-column': { min: 3, max: 3 },
  'three-mixed': { min: 3, max: 3 },
  'four-mixed': { min: 4, max: 4 },
  'collage-4': { min: 4, max: 4 },
  'collage-5': { min: 5, max: 5 },
  'collage-6': { min: 6, max: 6 },
  divider: { min: 0, max: 1 },
};

/**
 * Aspect-ratio buckets that drive every template decision in the photo-book pipeline.
 *
 * ONE definition, here, because four independent places have to agree exactly or they
 * silently contradict each other: the auto-layouter's page pacing
 * (`lib/photo-book-autolayout.ts`), the design check's shape rules
 * (`lib/photo-book-lint.ts`'s `TEMPLATE_SHAPE_RULES`), the repair pass that re-fits pages
 * (`lib/photo-book-repair.ts`), and the photo table the model is shown
 * (`lib/photo-book-ai-layout.ts`). Each of those used to carry its own copy of the same two
 * thresholds with a comment pointing at the others; a single edit to one of them would have
 * made the model's instructions, the layout it produces, and the check that scores it
 * disagree.
 */
export type PhotoOrientation = 'portrait' | 'landscape' | 'square';

export function photoOrientation(photo: { width: number; height: number }): PhotoOrientation {
  const ratio = photo.width / photo.height;
  if (ratio < 0.9) return 'portrait';
  if (ratio > 1.1) return 'landscape';
  return 'square';
}

/** Templates whose renderer deliberately drops captions — a dense mosaic has no room, and a
 *  divider already shows its section title (`renderPage` in `lib/photo-book-layout.ts` is
 *  the authority). Shared by the design check (which flags captions here) and the repair
 *  pass (which strips them). */
export const CAPTION_LESS_TEMPLATES: readonly PhotoPageTemplate[] = ['collage-4', 'collage-5', 'collage-6', 'divider'];

export function templateRendersCaptions(template: PhotoPageTemplate): boolean {
  return !CAPTION_LESS_TEMPLATES.includes(template);
}

/** One page template variant, its `assetIds` arity fixed by `PHOTO_PAGE_TEMPLATE_SLOTS` —
 *  a structural, non-content-dependent constraint, so (mirroring `photoRowBlockSchema`'s
 *  `.length(2)`) it belongs in the zod schema itself, not the consistency checker. Content
 *  checks (do these ids exist? are any reused?) still belong to
 *  `checkPhotoBookPlanConsistency` below, same split as the story plan. */
/** Only ever called with a FIXED-arity template (every one except `divider`) — the ranged
 *  case (`divider`, 0-1 photos) is built separately below, since `z.array().length(n)`
 *  has no variable-arity equivalent to fall back to. */
function pageVariantSchema<T extends PhotoPageTemplate>(template: T) {
  const { min, max } = PHOTO_PAGE_TEMPLATE_SLOTS[template];
  if (min !== max) throw new Error(`pageVariantSchema is only for fixed-arity templates, got ${template}`);
  return z.object({
    template: z.literal(template),
    assetIds: z.array(z.string()).length(min),
    /** Per-photo captions, same order/length as `assetIds` when present — a dense
     *  collage has no room for these (mirrors `.photo-grid figcaption { display: none }`
     *  in `lib/book-layout.ts`), but the renderer, not this schema, decides that. */
    captions: z.array(z.string().nullable()).length(min).optional(),
  });
}

function pageVariantSchemaRanged<T extends PhotoPageTemplate>(template: T) {
  const { min, max } = PHOTO_PAGE_TEMPLATE_SLOTS[template];
  return z.object({
    template: z.literal(template),
    assetIds: z.array(z.string()).min(min).max(max),
    captions: z.array(z.string().nullable()).max(max).optional(),
  });
}

const PHOTO_PAGE_VARIANTS = [
  pageVariantSchema('full-bleed'),
  pageVariantSchema('full-framed'),
  pageVariantSchema('two-horizontal'),
  pageVariantSchema('two-vertical'),
  pageVariantSchema('three-column'),
  pageVariantSchema('three-mixed'),
  pageVariantSchema('four-mixed'),
  pageVariantSchema('collage-4'),
  pageVariantSchema('collage-5'),
  pageVariantSchema('collage-6'),
  pageVariantSchemaRanged('divider'),
] as const;

export const pagePlanSchema = z.discriminatedUnion('template', [...PHOTO_PAGE_VARIANTS]);
export type PhotoPagePlan = z.infer<typeof pagePlanSchema>;

/**
 * A run of the owning section's story paragraphs (unified-book plan, PR B) — 0-based
 * indices, INCLUSIVE on both ends, the same range shape the retired story plan's
 * `paragraphs` blocks used. Unlike a photo page this is NOT a fixed sheet: the renderer
 * flows it across as many print pages as the text needs (`.text-flow`,
 * `lib/photo-book-layout.ts`). Only legal in a section that carries a `storyId`.
 */
export const textBlockPlanSchema = z.object({
  template: z.literal('text'),
  from: z.int().nonnegative(),
  to: z.int().nonnegative(),
});
export type TextBlockPlan = z.infer<typeof textBlockPlanSchema>;

/** One entry of `section.pages`: a fixed photo page, or a flowing text run. Kept under
 *  the `pages`/`template` keys the photo-only schema always used, so every stored plan
 *  keeps validating and every `switch (page.template)` in the pipeline had to learn the
 *  `'text'` case at compile time. */
export const flowItemSchema = z.discriminatedUnion('template', [...PHOTO_PAGE_VARIANTS, textBlockPlanSchema]);
export type PhotoFlowItem = z.infer<typeof flowItemSchema>;

export function isTextItem(item: PhotoFlowItem): item is TextBlockPlan {
  return item.template === 'text';
}

/** The section's fixed photo pages, text runs filtered out — for consumers that only
 *  ever meant photo pages (pacing, print sizing, proof selection). */
export function photoPagesOf(section: PhotoSectionPlan): PhotoPagePlan[] {
  return section.pages.filter((p): p is PhotoPagePlan => !isTextItem(p));
}

const sectionPlanSchema = z.object({
  /** "Sommer in Italien" (AI, later PR) or a date-range fallback like "Juni 2025"
   *  (auto-layouter) — always non-empty, never blank white space in the TOC/divider. */
  title: z.string().min(1),
  dateLabel: z.string().optional(),
  /** When set, this section is a story chapter (unified-book plan): its `text` items
   *  slice that story's paragraphs, and the consistency check enforces exactly one
   *  section per book story with gap-free coverage. Absent for pure photo sections. */
  storyId: z.string().optional(),
  /** No `.min(1)` here on purpose — mirrors `chapterPlanSchema.blocks` (also
   *  unconstrained) in `lib/book-layout-plan.ts`: whether a section is allowed to be
   *  empty is a CONTENT question ("did culling remove every photo in it"), so it's
   *  `checkPhotoBookPlanConsistency`'s job, not the schema's. */
  pages: z.array(flowItemSchema),
});
export type PhotoSectionPlan = z.infer<typeof sectionPlanSchema>;

const coverPlanSchema = z.object({
  /** Optional, like the story plan's `coverPlanSchema.heroAssetId` — a brand new photo
   *  book with zero uploaded (or all-excluded) photos has no possible hero yet. */
  heroAssetId: z.string().optional(),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  /** 0-3 small photos for the back cover (docs/PHOTO_BOOK_PLAN.md §5). PR2's
   *  auto-layouter never populates this (see `lib/photo-book-autolayout.ts`'s header
   *  comment) — the style suite still renders a complete, photo-free back design — but
   *  the field exists now so PR3's AI pass and PR4's targeted edits have somewhere to
   *  write it without a schema migration. */
  backAssetIds: z.array(z.string()).max(3).optional(),
});
export type PhotoCoverPlan = z.infer<typeof coverPlanSchema>;

export const photoBookPlanSchema = z.object({
  /** Defensive self-tag — see the module header comment. Every photo-book plan is this
   *  literal; the real dispatch key is the owning `books.kind` row. */
  kind: z.literal('photo'),
  style: z.enum(PHOTO_BOOK_STYLES),
  cover: coverPlanSchema,
  sections: z.array(sectionPlanSchema),
});
export type PhotoBookPlan = z.infer<typeof photoBookPlanSchema>;

export interface PhotoBookPlanValidationError {
  ok: false;
  error: string;
}

/** Parses + validates a photo-book plan against the schema. Throws nothing; returns a
 *  Result — same contract as `validateLayoutPlan` in `lib/book-layout-plan.ts`. */
export function validatePhotoBookPlan(
  data: unknown,
): { ok: true; plan: PhotoBookPlan } | PhotoBookPlanValidationError {
  const result = photoBookPlanSchema.safeParse(data);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => i.message).join('; ') };
  }
  return { ok: true, plan: result.data };
}

/** Minimal shape of "what the photo book currently contains", for consistency checking —
 *  the photo-book counterpart of `PlanContent` in `lib/book-layout-plan.ts`. */
export interface PhotoPlanContent {
  /** Every photo asset id currently available to the layout (i.e. `book_photos.excluded
   *  = false`) — a plan may reference only these. */
  availableAssetIds: string[];
  /** Every photo asset id in the book at all, excluded or not — lets "references a photo
   *  that's excluded right now" read differently from "references a photo that was
   *  deleted / never belonged to this book". */
  allAssetIds: string[];
  /** The book's story chapters with TEXT included (`book_stories` where `include_text`),
   *  in order, with CURRENT paragraph counts — mirrors `PlanContent.chapters` of the
   *  retired story plan. When provided, the consistency check enforces the text rules
   *  (one section per story, gap-free in-order paragraph coverage). Optional so pure
   *  photo books — and pre-unification callers — change nothing. */
  stories?: Array<{ storyId: string; paragraphCount: number }>;
}

/**
 * Checks a plan against the book's current photo set: every referenced asset must exist
 * in the book and not be excluded, no photo may be placed twice anywhere in the book
 * (cover hero, cover back, or any section page), every template's `assetIds`/`captions`
 * arity must still match (defense in depth — the schema already enforces this for a plan
 * that came through `validatePhotoBookPlan`, but this function is also meant to be safe
 * to call on a plan mutated after validation, e.g. by a future targeted-edit op), and no
 * section may have zero pages. Mirrors `checkPlanConsistency`'s rigor in
 * `lib/book-layout-plan.ts`. Used to decide whether a stored plan is still usable or must
 * be regenerated (`books.layout_stale`).
 */
export function checkPhotoBookPlanConsistency(plan: PhotoBookPlan, content: PhotoPlanContent): string[] {
  const problems: string[] = [];
  const available = new Set(content.availableAssetIds);
  const all = new Set(content.allAssetIds);
  const usageCount = new Map<string, number>();

  function reference(id: string, where: string) {
    if (!all.has(id)) {
      problems.push(`${where} references a photo that is not in this book: ${id}`);
    } else if (!available.has(id)) {
      problems.push(`${where} references an excluded photo: ${id}`);
    }
    usageCount.set(id, (usageCount.get(id) ?? 0) + 1);
  }

  if (plan.cover.heroAssetId) reference(plan.cover.heroAssetId, 'Cover');
  for (const id of plan.cover.backAssetIds ?? []) reference(id, 'Cover back');

  // A book with actual PHOTO content must have a cover hero — a printed book can't
  // have a blank front cover when there are photos to pick from. A photo-less book
  // (freshly created, or text-only chapters) is legal without one: there is no photo a
  // hero could be.
  const hasPhotoContent = plan.sections.some((section) =>
    section.pages.some((page) => !isTextItem(page) && page.assetIds.length > 0),
  );
  if (hasPhotoContent && !plan.cover.heroAssetId) {
    problems.push('Cover has no heroAssetId, but the book has content');
  }

  const storyById = content.stories ? new Map(content.stories.map((s) => [s.storyId, s])) : null;
  const sectionsByStory = new Map<string, number>();

  for (const section of plan.sections) {
    if (section.pages.length === 0) {
      problems.push(`Section "${section.title}" has no pages`);
      continue;
    }
    for (const page of section.pages) {
      if (isTextItem(page)) {
        if (!section.storyId) {
          problems.push(`Section "${section.title}" has a text block but no storyId`);
        }
        continue;
      }
      const slots = PHOTO_PAGE_TEMPLATE_SLOTS[page.template];
      if (page.assetIds.length < slots.min || page.assetIds.length > slots.max) {
        const expected = slots.min === slots.max ? `${slots.min}` : `${slots.min}-${slots.max}`;
        problems.push(
          `Section "${section.title}": a ${page.template} page has ${page.assetIds.length} photo(s), expected ${expected}`,
        );
      }
      if (page.captions && page.captions.length !== page.assetIds.length) {
        problems.push(
          `Section "${section.title}": a ${page.template} page has ${page.captions.length} caption(s) for ${page.assetIds.length} photo(s)`,
        );
      }
      for (const id of page.assetIds) reference(id, `Section "${section.title}"`);
    }
    if (section.storyId) {
      sectionsByStory.set(section.storyId, (sectionsByStory.get(section.storyId) ?? 0) + 1);
    }
  }

  // Text rules — only enforced when the caller supplied the book's story chapters (a
  // pre-unification caller, or a pure photo book, passes none and skips all of this).
  if (storyById) {
    for (const story of storyById.values()) {
      const count = sectionsByStory.get(story.storyId) ?? 0;
      if (count === 0) problems.push(`Plan is missing a section for story ${story.storyId}`);
      if (count > 1) problems.push(`Story ${story.storyId} is split across ${count} sections`);
    }
    for (const section of plan.sections) {
      if (!section.storyId) continue;
      const story = storyById.get(section.storyId);
      if (!story) {
        problems.push(`Section "${section.title}" references unknown story ${section.storyId}`);
        continue;
      }
      // Walk text items in ARRAY order (stricter than the retired story checker, which
      // sorted first): every paragraph exactly once, in reading order, no gaps/overlaps.
      let expected = 0;
      let broken = false;
      for (const item of section.pages) {
        if (!isTextItem(item)) continue;
        if (item.from !== expected || item.from > item.to) {
          problems.push(
            `Section "${section.title}": text coverage gap/overlap at paragraph ${expected} (block covers ${item.from}-${item.to})`,
          );
          broken = true;
          break;
        }
        expected = item.to + 1;
      }
      if (!broken && expected !== story.paragraphCount) {
        problems.push(
          `Section "${section.title}": text covers paragraphs up to ${expected}, but the story has ${story.paragraphCount}`,
        );
      }
    }
  }

  for (const [id, count] of usageCount) {
    if (count > 1) problems.push(`Photo ${id} is placed ${count} times in the book`);
  }

  return problems;
}

/**
 * Whether a plan actually puts photos on pages — the difference between "a structurally
 * valid plan" and "a book". `checkPhotoBookPlanConsistency` deliberately accepts an empty
 * plan (a brand-new book with no photos yet is legal, and with no content there is nothing
 * for a cover hero to cover), so producers that must not persist an empty result — the AI
 * design pass, whose fallback to the auto-layouter is the whole point — need this separate
 * question answered.
 */
export function photoBookPlanHasContent(plan: PhotoBookPlan): boolean {
  return plan.sections.some((section) =>
    section.pages.some((page) => isTextItem(page) || page.assetIds.length > 0),
  );
}

export function isPhotoBookPlanConsistent(plan: PhotoBookPlan, content: PhotoPlanContent): boolean {
  return checkPhotoBookPlanConsistency(plan, content).length === 0;
}
