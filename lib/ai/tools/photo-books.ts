import { z } from 'zod';
import { isLegacyStoryPlan } from '@/lib/book-plan-kind';
import { getBookForUser, getPhotoBookSummary, requestPhotoBookAiDesign, updatePhotoBookLayout } from '@/lib/books';
import { PHOTO_BOOK_STYLES, PHOTO_PAGE_TEMPLATES } from '@/lib/photo-book-plan';
import type { PhotoLayoutOp } from '@/lib/photo-book-ops';
import { defineTool } from './types';

/**
 * Photo-book tools — the agent-facing wrapper over lib/books.ts's photo-book functions
 * (docs/PHOTO_BOOK_PLAN.md §9), mirroring lib/ai/tools/books.ts's story-book tools one
 * for one: `get_photo_book` ~ `get_book`, `update_photo_book_layout` ~ `update_book_layout`,
 * `redesign_photo_book` ~ `design_book_layout`. Registered ONLY in the photo-book agent's
 * own toolset (`photoBookTools` in lib/ai/tools/index.ts) — NOT part of the shared `tools`
 * catalog the general chat agent or the story-book chat use, so a story-book conversation
 * can never see (or call) these, and vice versa.
 *
 * Unlike the story tools, these don't need a `resolveBook`-by-title helper: the photo-book
 * chat is hard-scoped to ONE book by the caller (`runPhotoBookAgent`'s system prompt always
 * passes that book's id), so every tool here takes `bookId` directly rather than a
 * title-or-id string to search for.
 */

export const getBookLayoutTool = defineTool<{ bookId: string }>({
  name: 'get_book_layout',
  description:
    'Read the photo book in full: style, cover, every section with its pages and photos ' +
    '(assetId, template, caption), plus each photo\'s AI analysis summary (sharpness, ' +
    'eyesClosed, peopleCount, sceneTags, shortDescription, aestheticScore, coverCandidate) ' +
    'so you know which photo is blurry, has closed eyes, or shows what — this is how you ' +
    'find the right assetId for a request like "the blurry ones" or "the one with Oma". Also ' +
    'lists excluded photos (with why) and available-but-unplaced ones. Always call this ' +
    'before update_photo_book_layout, since every op needs ids/indices from here.',
  schema: z.object({ bookId: z.string().min(1) }),
  async execute(args, ctx) {
    const result = await getPhotoBookSummary(args.bookId, ctx.userId);
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, message: JSON.stringify(result.value) };
  },
});

/** Mirrors `PhotoLayoutOp` (lib/photo-book-ops.ts) as a zod-discriminated union, one tool
 *  with an op discriminator — same shape as the story book's `layoutOpSchema`. Section/page
 *  addressing is by INDEX (sectionIndex/pageIndex), exactly as get_photo_book reports them;
 *  those indices stay stable across a batch EXCEPT after merge_sections, which removes a
 *  section and shifts every later section index down by one — `updatePhotoBookLayout`
 *  (lib/books.ts) enforces this by rejecting the whole batch if any op after a
 *  merge_sections addresses a section/page by index (see merge_sections's own
 *  `.describe()` below), so always call get_photo_book again for fresh indices before
 *  issuing further indexed ops. */
const photoLayoutOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('set_style'),
    style: z.enum(PHOTO_BOOK_STYLES).describe('The book\'s style suite.'),
  }),
  z.object({
    op: z.literal('set_cover'),
    heroAssetId: z.string().min(1).describe('assetId of the photo to use as the cover (must be available, from get_photo_book).'),
  }),
  z.object({
    op: z.literal('set_cover_title'),
    title: z.string().min(1).nullish().describe('The cover title, if changing it.'),
    subtitle: z.string().nullish().describe('The cover subtitle. Pass an empty string to clear it.'),
  }),
  z.object({
    op: z.literal('set_section_title'),
    sectionIndex: z.int().nonnegative().describe('sectionIndex from get_photo_book.'),
    title: z.string().min(1).describe('The new section title, e.g. "Sommer in Italien".'),
    dateLabel: z.string().nullish().describe('An optional date-range label shown under the title.'),
  }),
  z.object({
    op: z.literal('set_page_template'),
    sectionIndex: z.int().nonnegative(),
    pageIndex: z.int().nonnegative().describe('pageIndex within that section, from get_photo_book.'),
    template: z
      .enum(PHOTO_PAGE_TEMPLATES)
      .describe(
        'The new template. Its photo-count requirement must match the page\'s current photo ' +
          'count exactly (e.g. two-horizontal/two-vertical both need 2) — this is rejected ' +
          'otherwise; use move_photo first to change how many photos are on the page.',
      ),
  }),
  z.object({
    op: z.literal('move_photo'),
    assetId: z.string().min(1).describe('assetId of the photo to move (must be available, from get_photo_book).'),
    toSectionIndex: z.int().nonnegative().describe('Destination sectionIndex, from get_photo_book.'),
    toPageIndex: z
      .int()
      .nonnegative()
      .nullish()
      .describe('Where in the destination section to insert its new page (0 = first). Omit to append at the end.'),
  }),
  z.object({
    op: z.literal('swap_photos'),
    assetIdA: z.string().min(1),
    assetIdB: z.string().min(1),
  }),
  z.object({
    op: z.literal('exclude_photo'),
    assetId: z.string().min(1).describe('assetId to exclude from the book (from get_photo_book). Removed from wherever it currently sits.'),
  }),
  z.object({
    op: z.literal('include_photo'),
    assetId: z.string().min(1).describe('assetId to bring back into the book (from get_photo_book\'s excludedPhotos). Does not place it anywhere — follow with move_photo/set_cover if it should appear on a page.'),
  }),
  z.object({
    op: z.literal('move_section'),
    fromIndex: z.int().nonnegative(),
    toIndex: z.int().nonnegative(),
  }),
  z.object({
    op: z.literal('merge_sections'),
    sectionIndex: z.int().nonnegative().describe('The section to merge away — its pages are appended to intoIndex\'s.'),
    intoIndex: z.int().nonnegative().describe('The section that keeps existing (and gains the other\'s pages).'),
  }).describe(
    'Removes sectionIndex and shifts every later section index down by one, so this MUST ' +
      'be the last op in the batch (or the only one) — never followed by another op that ' +
      'addresses a section or page by index (set_section_title, set_page_template, ' +
      'move_photo, move_section, set_caption, or another merge_sections); such a batch is ' +
      'rejected outright. Call get_photo_book again afterward to get fresh indices before ' +
      'any further indexed op.',
  ),
  z.object({
    op: z.literal('set_caption'),
    sectionIndex: z.int().nonnegative(),
    pageIndex: z.int().nonnegative(),
    assetId: z.string().min(1).describe('Which photo on that page the caption is for.'),
    caption: z.string().nullable().describe('The caption text, or null to clear it.'),
  }),
]);

export const updateBookLayoutTool = defineTool<{ bookId: string; ops: PhotoLayoutOp[] }>({
  name: 'update_book_layout',
  description:
    'Make targeted edits to the photo book\'s layout: change the style, the cover photo or ' +
    'title, a section\'s title, a page\'s template, move or swap photos, exclude/include a ' +
    'photo, reorder or merge sections, or set a photo\'s caption. Call get_photo_book first — ' +
    'every op needs an assetId and/or a sectionIndex/pageIndex from there. You can pass ' +
    'several ops in one call; they apply in order, and the WHOLE batch is rejected (nothing ' +
    'changes) if any op — or the result as a whole — would leave the layout invalid, e.g. ' +
    'excluding the current cover photo without picking a new one. Applies instantly to the ' +
    'live preview; never queues a job or needs confirmation.',
  schema: z.object({
    bookId: z.string().min(1).describe('The photo book\'s id — always the one this chat is scoped to.'),
    ops: z.array(photoLayoutOpSchema).min(1).describe('One or more layout operations to apply, in order.'),
  }),
  async execute(args, ctx) {
    const book = await getBookForUser(args.bookId, ctx.userId);
    // Engine gate, not a kind gate — these tools drive the unified builder's chat,
    // which serves every book except one still on a legacy story-book plan.
    if (!book || isLegacyStoryPlan(book.layoutPlan)) {
      return { ok: false, error: 'This book still uses the old layout — switch it to the new layout first.' };
    }
    const result = await updatePhotoBookLayout({ bookId: args.bookId, userId: ctx.userId, ops: args.ops });
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      message: 'Layout updated.',
      receipt: { label: `Edited the layout of "${book.title}"`, href: `/books/${args.bookId}` },
    };
  },
});

export const redesignBookTool = defineTool<{ bookId: string; overwriteEdits?: boolean | null }>({
  name: 'redesign_book',
  description:
    'Queue an AI redesign of the WHOLE photo book: a vision model looks at the actual photos ' +
    'and proposes fresh section boundaries and titles, hero picks, page templates, and ' +
    'captions — a real design pass, not the mechanical auto-layout. Takes about half a ' +
    'minute; you cannot wait for it — tell the user it\'s running and they\'ll see it in the ' +
    'live preview once it finishes, then end your turn. If the layout has manual edits (chat ' +
    'edits from this or an earlier turn), this fails asking for confirmation — set ' +
    'overwriteEdits to true only once the user has explicitly confirmed replacing them.',
  schema: z.object({
    bookId: z.string().min(1).describe('The photo book\'s id — always the one this chat is scoped to.'),
    overwriteEdits: z
      .boolean()
      .nullish()
      .describe('Pass true only after the user confirms replacing existing manual layout edits.'),
  }),
  async execute(args, ctx) {
    const book = await getBookForUser(args.bookId, ctx.userId);
    // Engine gate, not a kind gate — these tools drive the unified builder's chat,
    // which serves every book except one still on a legacy story-book plan.
    if (!book || isLegacyStoryPlan(book.layoutPlan)) {
      return { ok: false, error: 'This book still uses the old layout — switch it to the new layout first.' };
    }
    const result = await requestPhotoBookAiDesign({
      bookId: args.bookId,
      userId: ctx.userId,
      overwriteEdits: args.overwriteEdits ?? undefined,
    });
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      message: 'AI redesign queued.',
      receipt: { label: `Redesigning "${book.title}" with AI`, href: `/books/${args.bookId}` },
    };
  },
});
