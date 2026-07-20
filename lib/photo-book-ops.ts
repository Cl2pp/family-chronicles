import {
  PHOTO_PAGE_TEMPLATE_SLOTS,
  type PhotoBookPlan,
  type PhotoBookStyle,
  type PhotoCoverPlan,
  type PhotoPagePlan,
  type PhotoPageTemplate,
} from './photo-book-plan';

/**
 * Targeted photo-book layout edits (docs/PHOTO_BOOK_PLAN.md §9's `update_photo_book_layout`
 * table) — the photo-book counterpart of `LayoutOp`/`applyLayoutOp` in `lib/books.ts`. Kept
 * in its own module, deliberately free of any `db`/`env` import (like `lib/photo-analysis.ts`
 * and `lib/photo-book-autolayout.ts`), so the plan-editing logic itself is unit-testable
 * without a database — `lib/books.ts`'s `updatePhotoBookLayout` is the thin, impure wrapper
 * that loads/persists plans and (for `exclude_photo`/`include_photo`) also flips
 * `book_photos.excluded`.
 *
 * Every op here is PURE: given a plan (and the current available-asset set), it returns
 * either a new plan or an error — never touches I/O. The caller re-validates the result
 * with `validatePhotoBookPlan` + `checkPhotoBookPlanConsistency` before persisting anything
 * (never persist an invalid plan — same contract as the story book's `updateBookLayout`).
 *
 * `exclude_photo`/`include_photo` are listed in the union (the tool/schema needs them), but
 * `applyPhotoLayoutOp` does NOT handle them — they need a DB write (`book_photos.excluded`)
 * interleaved with the plan edit, which only `updatePhotoBookLayout` can do atomically. Call
 * `removePhotoFromPlan` directly for the plan side of an exclude.
 */

/**
 * Optional fields are typed `T | null` (not just `T | undefined`) throughout — matching
 * every zod `.nullish()` field in `lib/ai/tools/photo-books.ts`'s `photoLayoutOpSchema`
 * exactly (models sometimes send an explicit `null` for "no value" instead of omitting
 * the key), so `Tool<A>`'s `schema: z.ZodType<A>` type-checks without a cast. `undefined`
 * (the key omitted) means "don't touch this field"; an explicit `null` means "clear it" —
 * same convention `updateBook`/`updateBookTool` already use for `subtitle`/`dedication`.
 */
export type PhotoLayoutOp =
  | { op: 'set_style'; style: PhotoBookStyle }
  | { op: 'set_cover'; heroAssetId: string }
  | { op: 'set_cover_title'; title?: string | null; subtitle?: string | null }
  | { op: 'set_section_title'; sectionIndex: number; title: string; dateLabel?: string | null }
  | { op: 'set_page_template'; sectionIndex: number; pageIndex: number; template: PhotoPageTemplate }
  | { op: 'move_photo'; assetId: string; toSectionIndex: number; toPageIndex?: number | null }
  | { op: 'swap_photos'; assetIdA: string; assetIdB: string }
  | { op: 'exclude_photo'; assetId: string }
  | { op: 'include_photo'; assetId: string }
  | { op: 'move_section'; fromIndex: number; toIndex: number }
  | { op: 'merge_sections'; sectionIndex: number; intoIndex: number }
  | { op: 'set_caption'; sectionIndex: number; pageIndex: number; assetId: string; caption: string | null };

/** The ops `applyPhotoLayoutOp` actually applies — `exclude_photo`/`include_photo` are
 *  handled by `updatePhotoBookLayout` itself (see module comment). */
export type PurePhotoLayoutOp = Exclude<PhotoLayoutOp, { op: 'exclude_photo' } | { op: 'include_photo' }>;

export interface PhotoLayoutOpContext {
  /** Every photo id currently usable by the plan — in this book and not excluded. Ops
   *  that reference a photo (set_cover, move_photo, swap_photos) are rejected if either
   *  side isn't in this set. Threaded through by the caller so it reflects any
   *  exclude_photo/include_photo ops already applied earlier in the same batch. */
  availableAssetIds: Set<string>;
}

export type PhotoLayoutOpResult =
  | { plan: PhotoBookPlan; coverAssetId?: string }
  | { error: string };

/** Generic single-template pick for a page ending up with N photos after some op — used
 *  by `removePhotoFromPlan`'s shrink and `move_photo`'s "own new page" placement. 0 maps to
 *  `divider` (an empty section-opener is still a meaningful page, never deleted), 1-5 map to
 *  one representative fixed-arity template each. There's no principled way to guess whether
 *  a shrunk 3-photo page "wants" `three-column` or `three-mixed` — `three-mixed` (one
 *  dominant + two small) degrades more gracefully when the photos aren't matched aspect
 *  ratios, which is the common case right after an edit. */
const GENERIC_TEMPLATE_FOR_COUNT: Record<number, PhotoPageTemplate> = {
  0: 'divider',
  1: 'full-framed',
  2: 'two-horizontal',
  3: 'three-mixed',
  4: 'collage-4',
  5: 'collage-5',
};

function templateFits(template: PhotoPageTemplate, count: number): boolean {
  const slots = PHOTO_PAGE_TEMPLATE_SLOTS[template];
  return count >= slots.min && count <= slots.max;
}

/** One page with `assetId` (and its caption, if any) removed, re-templated if the removal
 *  no longer fits the page's current template's arity. Never returns fewer pages than it
 *  was given — a page that loses its last photo becomes an empty `divider` rather than
 *  disappearing, which is what keeps every OTHER op's section/page indices stable within
 *  the same batch (dropping pages/sections would shift every later index, a real footgun
 *  when several ops in one call address earlier-computed indices from a single
 *  `get_photo_book` read). */
function shrinkPage(page: PhotoPagePlan, assetId: string): PhotoPagePlan {
  const idx = page.assetIds.indexOf(assetId);
  if (idx === -1) return page;
  const assetIds = page.assetIds.filter((id) => id !== assetId);
  const captions = page.captions?.filter((_, i) => i !== idx);
  if (templateFits(page.template, assetIds.length)) {
    return { ...page, assetIds, captions } as PhotoPagePlan;
  }
  const template = GENERIC_TEMPLATE_FOR_COUNT[assetIds.length];
  return {
    template,
    assetIds,
    captions: assetIds.length ? captions : undefined,
  } as PhotoPagePlan;
}

/**
 * Removes `assetId` from wherever the plan currently places it — the cover hero, a cover
 * back slot, or a section page (shrinking/re-templating that page, see `shrinkPage`). A
 * no-op wherever the photo isn't referenced. Used both by `exclude_photo` (via
 * `updatePhotoBookLayout`, since excluding needs a DB write this pure function can't do)
 * and internally by `move_photo` (to vacate the photo's old spot before giving it a new
 * one). Never removes a page or a section — see `shrinkPage`'s doc comment.
 */
export function removePhotoFromPlan(plan: PhotoBookPlan, assetId: string): PhotoBookPlan {
  const cover: PhotoCoverPlan = { ...plan.cover };
  if (cover.heroAssetId === assetId) cover.heroAssetId = undefined;
  if (cover.backAssetIds?.includes(assetId)) {
    cover.backAssetIds = cover.backAssetIds.filter((id) => id !== assetId);
  }

  const sections = plan.sections.map((section) => ({
    ...section,
    pages: section.pages.map((page) => shrinkPage(page, assetId)),
  }));

  return { ...plan, cover, sections };
}

/** Swaps every occurrence of `a`/`b` in the plan (cover hero, cover back slots, and every
 *  page's `assetIds`) — pure id substitution, so unlike `move_photo` it never needs to
 *  re-template a page (the photo COUNT per page never changes). */
function swapIdEverywhere(plan: PhotoBookPlan, a: string, b: string): PhotoBookPlan {
  const swap = (id: string) => (id === a ? b : id === b ? a : id);
  const cover: PhotoCoverPlan = {
    ...plan.cover,
    heroAssetId: plan.cover.heroAssetId ? swap(plan.cover.heroAssetId) : plan.cover.heroAssetId,
    backAssetIds: plan.cover.backAssetIds?.map(swap),
  };
  const sections = plan.sections.map((section) => ({
    ...section,
    pages: section.pages.map((page) => ({ ...page, assetIds: page.assetIds.map(swap) }) as PhotoPagePlan),
  }));
  return { ...plan, cover, sections };
}

/** Applies one targeted op to `plan`. Pure — see the module comment. `ctx.availableAssetIds`
 *  gates every op that references a photo by id, so a caller folding several ops from one
 *  batch can thread the SAME (mutable) set through and see earlier exclude/include ops
 *  reflected in later ones. */
export function applyPhotoLayoutOp(
  plan: PhotoBookPlan,
  op: PurePhotoLayoutOp,
  ctx: PhotoLayoutOpContext,
): PhotoLayoutOpResult {
  switch (op.op) {
    case 'set_style': {
      return { plan: { ...plan, style: op.style } };
    }

    case 'set_cover': {
      if (!ctx.availableAssetIds.has(op.heroAssetId)) {
        return { error: 'That photo is not available in this book (missing or excluded).' };
      }
      return {
        plan: { ...plan, cover: { ...plan.cover, heroAssetId: op.heroAssetId } },
        coverAssetId: op.heroAssetId,
      };
    }

    case 'set_cover_title': {
      const title = op.title?.trim();
      if (op.title !== undefined && !title) return { error: 'The cover title cannot be empty.' };
      const subtitle = op.subtitle?.trim();
      return {
        plan: {
          ...plan,
          cover: {
            ...plan.cover,
            ...(title ? { title } : {}),
            ...(op.subtitle !== undefined ? { subtitle: subtitle || undefined } : {}),
          },
        },
      };
    }

    case 'set_section_title': {
      const section = plan.sections[op.sectionIndex];
      if (!section) return { error: `No section at index ${op.sectionIndex}.` };
      const title = op.title.trim();
      if (!title) return { error: 'The section title cannot be empty.' };
      const sections = plan.sections.slice();
      sections[op.sectionIndex] = {
        ...section,
        title,
        ...(op.dateLabel !== undefined ? { dateLabel: op.dateLabel?.trim() || undefined } : {}),
      };
      return { plan: { ...plan, sections } };
    }

    case 'set_page_template': {
      const section = plan.sections[op.sectionIndex];
      if (!section) return { error: `No section at index ${op.sectionIndex}.` };
      const page = section.pages[op.pageIndex];
      if (!page) return { error: `No page at index ${op.pageIndex} in section "${section.title}".` };
      if (!templateFits(op.template, page.assetIds.length)) {
        const slots = PHOTO_PAGE_TEMPLATE_SLOTS[op.template];
        const expected = slots.min === slots.max ? `${slots.min}` : `${slots.min}-${slots.max}`;
        return {
          error: `"${op.template}" needs ${expected} photo(s), but this page has ${page.assetIds.length}.`,
        };
      }
      const sections = plan.sections.slice();
      const pages = section.pages.slice();
      pages[op.pageIndex] = { ...page, template: op.template } as PhotoPagePlan;
      sections[op.sectionIndex] = { ...section, pages };
      return { plan: { ...plan, sections } };
    }

    case 'move_photo': {
      if (!ctx.availableAssetIds.has(op.assetId)) {
        return { error: 'That photo is not available in this book (missing or excluded).' };
      }
      const target = plan.sections[op.toSectionIndex];
      if (!target) return { error: `No section at index ${op.toSectionIndex}.` };
      // Always lands on its own new full-framed page, rather than trying to slot into an
      // existing multi-photo page — growing that page's template (e.g. two-horizontal ->
      // three-mixed) would change what OTHER photos on it look like, which is more
      // surprising than "the moved photo gets its own page". A follow-up
      // set_page_template (once the destination page holds the photos the user wants
      // together) covers the "combine into one page" case explicitly.
      const working = removePhotoFromPlan(plan, op.assetId);
      const sections = working.sections.slice();
      const destination = sections[op.toSectionIndex];
      const pages = destination.pages.slice();
      const newPage: PhotoPagePlan = { template: 'full-framed', assetIds: [op.assetId] };
      const insertAt =
        op.toPageIndex != null && op.toPageIndex >= 0 && op.toPageIndex <= pages.length
          ? op.toPageIndex
          : pages.length;
      pages.splice(insertAt, 0, newPage);
      sections[op.toSectionIndex] = { ...destination, pages };
      return { plan: { ...working, sections } };
    }

    case 'swap_photos': {
      if (op.assetIdA === op.assetIdB) return { error: 'Both photos are the same.' };
      if (!ctx.availableAssetIds.has(op.assetIdA) || !ctx.availableAssetIds.has(op.assetIdB)) {
        return { error: 'Both photos must be available in this book.' };
      }
      return { plan: swapIdEverywhere(plan, op.assetIdA, op.assetIdB) };
    }

    case 'move_section': {
      const { fromIndex, toIndex } = op;
      if (fromIndex < 0 || fromIndex >= plan.sections.length) {
        return { error: `No section at index ${fromIndex}.` };
      }
      if (toIndex < 0 || toIndex >= plan.sections.length) {
        return { error: `No section at index ${toIndex}.` };
      }
      if (fromIndex === toIndex) return { plan };
      const sections = plan.sections.slice();
      const [moved] = sections.splice(fromIndex, 1);
      sections.splice(toIndex, 0, moved);
      return { plan: { ...plan, sections } };
    }

    case 'merge_sections': {
      const { sectionIndex, intoIndex } = op;
      if (sectionIndex < 0 || sectionIndex >= plan.sections.length) {
        return { error: `No section at index ${sectionIndex}.` };
      }
      if (intoIndex < 0 || intoIndex >= plan.sections.length) {
        return { error: `No section at index ${intoIndex}.` };
      }
      if (sectionIndex === intoIndex) return { error: 'Cannot merge a section into itself.' };
      const sections = plan.sections.slice();
      const [removed] = sections.splice(sectionIndex, 1);
      // Merging REMOVES a section (unlike every other op here), so every section index
      // from sectionIndex onward shifts by one — including intoIndex, if it pointed past
      // the removed one. Combine merge_sections with other index-addressed ops in the
      // same batch with care; this is the one op that isn't index-stable.
      const adjustedInto = sectionIndex < intoIndex ? intoIndex - 1 : intoIndex;
      sections[adjustedInto] = {
        ...sections[adjustedInto],
        pages: [...sections[adjustedInto].pages, ...removed.pages],
      };
      return { plan: { ...plan, sections } };
    }

    case 'set_caption': {
      const section = plan.sections[op.sectionIndex];
      if (!section) return { error: `No section at index ${op.sectionIndex}.` };
      const page = section.pages[op.pageIndex];
      if (!page) return { error: `No page at index ${op.pageIndex} in section "${section.title}".` };
      const idx = page.assetIds.indexOf(op.assetId);
      if (idx === -1) return { error: 'That photo is not on this page.' };
      const captions = page.captions ? page.captions.slice() : page.assetIds.map(() => null);
      captions[idx] = op.caption?.trim() || null;
      const sections = plan.sections.slice();
      const pages = section.pages.slice();
      pages[op.pageIndex] = { ...page, captions } as PhotoPagePlan;
      sections[op.sectionIndex] = { ...section, pages };
      return { plan: { ...plan, sections } };
    }
  }
}
