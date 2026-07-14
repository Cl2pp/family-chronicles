import { z } from 'zod';
import {
  createBook,
  estimatePageCount,
  getBookForUser,
  listBooksForUser,
  quoteBook,
  requestAiDesign,
  requestPreview,
  setBookStories,
  updateBook,
  type BookDetail,
} from '@/lib/books';
import { FORMAT_LABELS } from '@/lib/gelato';
import { defineTool, type ToolContext } from './types';
import { ensureContributor } from './util';

/**
 * Book tools — the agent-facing wrapper over lib/books.ts, so a user can build
 * and edit a printable book from chat exactly like from the builder UI.
 * Deliberately absent: place_order. Ordering stays a human click on /books/[id]/order.
 */

/** Find one of the user's books by exact title (case-insensitive) or id. */
async function resolveBook(
  ctx: ToolContext,
  ref: string,
): Promise<{ book: BookDetail } | { error: string }> {
  const all = await listBooksForUser(ctx.userId);
  const wanted = ref.trim().toLowerCase();
  const matches = all.filter((b) => b.id === ref.trim() || b.title.toLowerCase() === wanted);
  if (matches.length === 0) return { error: `No book titled "${ref}" was found.` };
  if (matches.length > 1) return { error: `Several books match "${ref}" — be more specific.` };
  const book = await getBookForUser(matches[0].id, ctx.userId);
  if (!book) return { error: `No book titled "${ref}" was found.` };
  return { book };
}

function bookSummary(book: BookDetail) {
  return {
    id: book.id,
    title: book.title,
    subtitle: book.subtitle,
    dedication: book.dedication,
    format: book.format,
    formatLabel: FORMAT_LABELS[book.format],
    status: book.status,
    pageCount: book.pageCount ?? `~${estimatePageCount(book)} (estimated)`,
    chronicle: book.chronicleName,
    chapters: book.chapters.map((c, i) => ({
      position: i + 1,
      storyId: c.storyId,
      title: c.title,
      year: c.eventDate ? c.eventDate.getUTCFullYear() : null,
      photos: c.photoCount,
      includePhotos: c.includePhotos,
    })),
  };
}

export const listBooksTool = defineTool({
  name: 'list_books',
  description:
    "List the user's books across their chronicles (title, status, format, story count, id). " +
    'A book turns selected stories into a printable hardcover. Use this before editing a book.',
  schema: z.object({}),
  async execute(_args, ctx) {
    const books = await listBooksForUser(ctx.userId);
    return {
      ok: true,
      message: JSON.stringify(
        books.map((b) => ({
          id: b.id,
          title: b.title,
          status: b.status,
          format: b.format,
          stories: b.storyCount,
          pages: b.pageCount,
          chronicle: b.chronicleName,
        })),
      ),
    };
  },
});

export const getBookTool = defineTool({
  name: 'get_book',
  description:
    'Read one book in full: settings plus the ordered chapter list (each with storyId, title, ' +
    'year, photo count). Always call this before changing a book so edits start from its ' +
    'current state.',
  schema: z.object({
    book: z.string().min(1).describe('The book title (or id) to read.'),
  }),
  async execute(args, ctx) {
    const found = await resolveBook(ctx, args.book);
    if ('error' in found) return { ok: false, error: found.error };
    return { ok: true, message: JSON.stringify(bookSummary(found.book)) };
  },
});

export const createBookTool = defineTool({
  name: 'create_book',
  description:
    'Create a book from stories of the active chronicle. Without storyIds it includes ALL ready ' +
    'stories in chronological order — usually the right start; the user can prune afterwards. ' +
    'After creating, tell the user they can review it under Books and ask you for any changes.',
  schema: z.object({
    title: z.string().min(1).describe('The book title, e.g. the family or chronicle name.'),
    storyIds: z
      .array(z.string())
      .nullish()
      .describe('Story ids to include, in reading order. Omit to include all ready stories.'),
  }),
  async execute(args, ctx) {
    const gate = await ensureContributor(ctx);
    if ('error' in gate) return { ok: false, error: gate.error };
    const result = await createBook({
      chronicleId: gate.chronicleId,
      userId: ctx.userId,
      title: args.title,
      storyIds: args.storyIds ?? undefined,
    });
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      message: `Book created (id ${result.value.bookId}).`,
      receipt: { label: `Created book "${args.title}"`, href: `/books/${result.value.bookId}` },
    };
  },
});

export const updateBookTool = defineTool({
  name: 'update_book',
  description:
    'Change a book\'s settings: title, subtitle, dedication, or format ("hardcover-21x28" ' +
    'portrait / "hardcover-20x20" square). Only pass the fields that change. Content edits ' +
    'invalidate an existing preview — mention that a new preview is needed.',
  schema: z.object({
    book: z.string().min(1).describe('The book title (or id) to update.'),
    title: z.string().nullish(),
    subtitle: z.string().nullish().describe('Pass an empty string to clear.'),
    dedication: z.string().nullish().describe('Pass an empty string to clear.'),
    format: z.enum(['hardcover-21x28', 'hardcover-20x20']).nullish(),
  }),
  async execute(args, ctx) {
    const found = await resolveBook(ctx, args.book);
    if ('error' in found) return { ok: false, error: found.error };
    const result = await updateBook({
      bookId: found.book.id,
      userId: ctx.userId,
      title: args.title ?? undefined,
      subtitle: args.subtitle === undefined ? undefined : args.subtitle,
      dedication: args.dedication === undefined ? undefined : args.dedication,
      format: args.format ?? undefined,
    });
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      message: 'Book updated.',
      receipt: { label: `Updated book "${args.title ?? found.book.title}"`, href: `/books/${found.book.id}` },
    };
  },
});

export const setBookStoriesTool = defineTool({
  name: 'set_book_stories',
  description:
    'Replace a book\'s chapters with the given story ids IN READING ORDER — one call covers ' +
    'adding, removing, and reordering. Call get_book first and build the new full list from its ' +
    'chapters (never guess ids; find new ones via list_stories). Invalidates an existing preview.',
  schema: z.object({
    book: z.string().min(1).describe('The book title (or id) to change.'),
    storyIds: z
      .array(z.string().min(1))
      .min(1)
      .describe('The COMPLETE new chapter list: every story id, in reading order.'),
  }),
  async execute(args, ctx) {
    const found = await resolveBook(ctx, args.book);
    if ('error' in found) return { ok: false, error: found.error };
    const result = await setBookStories({
      bookId: found.book.id,
      userId: ctx.userId,
      storyIds: args.storyIds,
    });
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      message: `Chapters updated (${args.storyIds.length} stories).`,
      receipt: {
        label: `Rearranged "${found.book.title}" (${args.storyIds.length} chapters)`,
        href: `/books/${found.book.id}`,
      },
    };
  },
});

export const renderBookPreviewTool = defineTool({
  name: 'render_book_preview',
  description:
    'Queue the book\'s print proof — a full-resolution, print-ready PDF (takes a minute or two). ' +
    'The builder page itself already shows a live HTML preview that updates instantly on every ' +
    'edit, so you do NOT need this tool just to let the user see their changes — only call it ' +
    'when they want the official print-quality PDF, or are getting ready to order (ordering ' +
    'requires this render to have completed). Tell the user the print proof will be ready on the ' +
    'book\'s order page shortly — you cannot wait for it or view it yourself.',
  schema: z.object({
    book: z.string().min(1).describe('The book title (or id) to render.'),
  }),
  async execute(args, ctx) {
    const found = await resolveBook(ctx, args.book);
    if ('error' in found) return { ok: false, error: found.error };
    const result = await requestPreview({ bookId: found.book.id, userId: ctx.userId });
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      message: 'Print proof render queued.',
      receipt: { label: `Rendering print proof of "${found.book.title}"`, href: `/books/${found.book.id}/order` },
    };
  },
});

export const designBookLayoutTool = defineTool({
  name: 'design_book_layout',
  description:
    'Queue an AI redesign of the book\'s photo layout: a vision model looks at the book\'s ' +
    'actual chapters and photos and proposes which photo is the cover, which photos sit side ' +
    'by side or in a grid, which gets a full page, and how photos are placed among the text — ' +
    'a real design pass, not just the mechanical default layout every book starts with. Takes ' +
    'about a minute; you cannot wait for it. The user sees the result in the book\'s live ' +
    'preview once it finishes. If the book\'s layout has manual edits, this fails asking for ' +
    'confirmation — set overwriteEdits to true only if the user has confirmed they want to ' +
    'replace those edits.',
  schema: z.object({
    book: z.string().min(1).describe('The book title (or id) to design.'),
    overwriteEdits: z
      .boolean()
      .nullish()
      .describe('Pass true only after the user confirms replacing existing manual layout edits.'),
  }),
  async execute(args, ctx) {
    const found = await resolveBook(ctx, args.book);
    if ('error' in found) return { ok: false, error: found.error };
    const result = await requestAiDesign({
      bookId: found.book.id,
      userId: ctx.userId,
      overwriteEdits: args.overwriteEdits ?? undefined,
    });
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      message: 'AI design pass queued.',
      receipt: { label: `Designing "${found.book.title}" with AI`, href: `/books/${found.book.id}` },
    };
  },
});

export const quoteBookPriceTool = defineTool({
  name: 'quote_book_price',
  description:
    'Get the current print price of a book (product + shipping within Germany + margin, EUR). ' +
    'Use when the user asks what their book would cost. If unpriced, say the price will be ' +
    'confirmed personally after ordering. Ordering itself happens on the book page, not in chat.',
  schema: z.object({
    book: z.string().min(1).describe('The book title (or id) to price.'),
  }),
  async execute(args, ctx) {
    const found = await resolveBook(ctx, args.book);
    if ('error' in found) return { ok: false, error: found.error };
    const result = await quoteBook({ bookId: found.book.id, userId: ctx.userId });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, message: JSON.stringify(result.value.quote) };
  },
});
