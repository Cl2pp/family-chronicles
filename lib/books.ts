import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import {
  assets,
  bookOrders,
  books,
  bookStories,
  chronicles,
  memberships,
  stories,
  storyChronicles,
  user,
} from '@/db/schema';
import { getMembership } from '@/lib/chronicles';
import { canContribute, type AccessRole } from '@/lib/permissions';
import { enqueueRenderBook } from '@/lib/queue';
import { quoteBookPrice, type BookFormat, type BookQuote } from '@/lib/gelato';
import { sendEmail } from '@/lib/email';
import { env } from '@/lib/env';

/**
 * Book domain — the ONE place book state changes. The Books UI (server actions)
 * and the chat agent's tools (lib/ai/tools/books.ts) are both thin wrappers over
 * these functions, which is what lets a user say "reorder my book" in chat and
 * get exactly the same behavior as the builder UI.
 */

export type BookStatus = 'draft' | 'rendering' | 'preview_ready' | 'render_failed' | 'ordered';

export type Result<T = undefined> =
  | (T extends undefined ? { ok: true } : { ok: true; value: T })
  | { ok: false; error: string };

const err = (error: string) => ({ ok: false as const, error });

/** Membership + contributor gate for everything below. */
async function ensureBookAccess(
  chronicleId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const m = await getMembership(chronicleId, userId);
  if (!m) return err('You are not a member of this chronicle.');
  if (!canContribute(m.accessRole as AccessRole)) {
    return err('You need contributor access in this chronicle to work on books.');
  }
  return { ok: true };
}

export interface BookListItem {
  id: string;
  chronicleId: string;
  chronicleName: string;
  title: string;
  subtitle: string | null;
  status: BookStatus;
  format: BookFormat;
  pageCount: number | null;
  storyCount: number;
  updatedAt: Date;
}

/** Books across every chronicle the user belongs to. */
export async function listBooksForUser(userId: string): Promise<BookListItem[]> {
  const rows = await db
    .select({
      id: books.id,
      chronicleId: books.chronicleId,
      chronicleName: chronicles.name,
      title: books.title,
      subtitle: books.subtitle,
      status: books.status,
      format: books.format,
      pageCount: books.pageCount,
      updatedAt: books.updatedAt,
    })
    .from(books)
    .innerJoin(chronicles, eq(books.chronicleId, chronicles.id))
    .innerJoin(memberships, eq(memberships.chronicleId, books.chronicleId))
    .where(eq(memberships.userId, userId))
    .orderBy(desc(books.updatedAt));

  const ids = rows.map((r) => r.id);
  const counts = ids.length
    ? await db
        .select({ bookId: bookStories.bookId })
        .from(bookStories)
        .where(inArray(bookStories.bookId, ids))
    : [];
  const countByBook = new Map<string, number>();
  for (const c of counts) countByBook.set(c.bookId, (countByBook.get(c.bookId) ?? 0) + 1);

  return rows.map((r) => ({
    ...r,
    status: r.status as BookStatus,
    format: r.format as BookFormat,
    storyCount: countByBook.get(r.id) ?? 0,
  }));
}

export interface BookChapter {
  storyId: string;
  position: number;
  includePhotos: boolean;
  title: string;
  summary: string | null;
  eventDate: Date | null;
  status: string;
  photoCount: number;
}

export interface BookDetail {
  id: string;
  chronicleId: string;
  chronicleName: string;
  createdBy: string;
  title: string;
  subtitle: string | null;
  dedication: string | null;
  coverAssetId: string | null;
  format: BookFormat;
  status: BookStatus;
  errorMessage: string | null;
  pageCount: number | null;
  previewS3Key: string | null;
  printS3Key: string | null;
  updatedAt: Date;
  chapters: BookChapter[];
}

/** A book with its ordered chapters, gated to chronicle members. */
export async function getBookForUser(bookId: string, userId: string): Promise<BookDetail | null> {
  const rows = await db
    .select({
      book: books,
      chronicleName: chronicles.name,
    })
    .from(books)
    .innerJoin(chronicles, eq(books.chronicleId, chronicles.id))
    .where(eq(books.id, bookId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const m = await getMembership(row.book.chronicleId, userId);
  if (!m) return null;

  const chapterRows = await db
    .select({
      storyId: bookStories.storyId,
      position: bookStories.position,
      includePhotos: bookStories.includePhotos,
      title: stories.title,
      summary: stories.summary,
      eventDate: stories.eventDate,
      status: stories.status,
    })
    .from(bookStories)
    .innerJoin(stories, eq(bookStories.storyId, stories.id))
    .where(eq(bookStories.bookId, bookId))
    .orderBy(asc(bookStories.position));

  const storyIds = chapterRows.map((c) => c.storyId);
  const photoRows = storyIds.length
    ? await db
        .select({ storyId: assets.storyId })
        .from(assets)
        .where(and(inArray(assets.storyId, storyIds), eq(assets.kind, 'photo')))
    : [];
  const photosByStory = new Map<string, number>();
  for (const p of photoRows) photosByStory.set(p.storyId, (photosByStory.get(p.storyId) ?? 0) + 1);

  return {
    id: row.book.id,
    chronicleId: row.book.chronicleId,
    chronicleName: row.chronicleName,
    createdBy: row.book.createdBy,
    title: row.book.title,
    subtitle: row.book.subtitle,
    dedication: row.book.dedication,
    coverAssetId: row.book.coverAssetId,
    format: row.book.format as BookFormat,
    status: row.book.status as BookStatus,
    errorMessage: row.book.errorMessage,
    pageCount: row.book.pageCount,
    previewS3Key: row.book.previewS3Key,
    printS3Key: row.book.printS3Key,
    updatedAt: row.book.updatedAt,
    chapters: chapterRows.map((c, i) => ({
      ...c,
      position: c.position ?? i,
      photoCount: photosByStory.get(c.storyId) ?? 0,
    })),
  };
}

/** Ready stories of a chronicle, in book order (event date, then created). */
export async function readyStoriesForChronicle(chronicleId: string) {
  return db
    .select({
      id: stories.id,
      title: stories.title,
      summary: stories.summary,
      eventDate: stories.eventDate,
      createdAt: stories.createdAt,
      submitterName: user.name,
    })
    .from(storyChronicles)
    .innerJoin(stories, eq(storyChronicles.storyId, stories.id))
    .innerJoin(user, eq(stories.submittedBy, user.id))
    .where(and(eq(storyChronicles.chronicleId, chronicleId), eq(stories.status, 'ready')))
    .orderBy(asc(stories.eventDate), asc(stories.createdAt));
}

/**
 * Create a book. Defaults to ALL ready stories of the chronicle in chronological
 * order — starting from everything and pruning beats assembling from nothing.
 */
export async function createBook(input: {
  chronicleId: string;
  userId: string;
  title: string;
  storyIds?: string[];
}): Promise<Result<{ bookId: string }>> {
  const gate = await ensureBookAccess(input.chronicleId, input.userId);
  if (!gate.ok) return gate;

  let storyIds = input.storyIds;
  if (!storyIds) {
    storyIds = (await readyStoriesForChronicle(input.chronicleId)).map((s) => s.id);
  }
  if (storyIds.length === 0) {
    return err('This chronicle has no ready stories yet — a book needs at least one.');
  }

  const bookId = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(books)
      .values({
        chronicleId: input.chronicleId,
        createdBy: input.userId,
        title: input.title.trim() || 'Family Chronicle',
      })
      .returning();
    await tx
      .insert(bookStories)
      .values(storyIds.map((storyId, position) => ({ bookId: created.id, storyId, position })));
    return created.id;
  });
  return { ok: true, value: { bookId } };
}

/** Guard shared by every mutation: member, contributor, and the book not locked. */
async function editableBook(
  bookId: string,
  userId: string,
): Promise<{ ok: true; book: BookDetail } | { ok: false; error: string }> {
  const book = await getBookForUser(bookId, userId);
  if (!book) return err('Book not found.');
  const gate = await ensureBookAccess(book.chronicleId, userId);
  if (!gate.ok) return gate;
  if (book.status === 'ordered') {
    return err('This book has been ordered and is locked. Create a new book to make changes.');
  }
  return { ok: true, book };
}

/** Content changed → any existing preview no longer matches; drop back to draft. */
function invalidatePreview() {
  return {
    status: 'draft' as const,
    errorMessage: null,
    updatedAt: new Date(),
  };
}

export async function updateBook(input: {
  bookId: string;
  userId: string;
  title?: string;
  subtitle?: string | null;
  dedication?: string | null;
  coverAssetId?: string | null;
  format?: BookFormat;
}): Promise<Result> {
  const gate = await editableBook(input.bookId, input.userId);
  if (!gate.ok) return gate;

  if (input.coverAssetId) {
    // The cover must be a photo belonging to one of the book's stories.
    const storyIds = gate.book.chapters.map((c) => c.storyId);
    const rows = storyIds.length
      ? await db
          .select({ id: assets.id })
          .from(assets)
          .where(
            and(
              eq(assets.id, input.coverAssetId),
              eq(assets.kind, 'photo'),
              inArray(assets.storyId, storyIds),
            ),
          )
          .limit(1)
      : [];
    if (rows.length === 0) return err('The cover photo must belong to a story in this book.');
  }

  const set: Partial<typeof books.$inferInsert> = { ...invalidatePreview() };
  if (input.title !== undefined) set.title = input.title.trim() || gate.book.title;
  if (input.subtitle !== undefined) set.subtitle = input.subtitle?.trim() || null;
  if (input.dedication !== undefined) set.dedication = input.dedication?.trim() || null;
  if (input.coverAssetId !== undefined) set.coverAssetId = input.coverAssetId;
  if (input.format !== undefined) set.format = input.format;

  await db.update(books).set(set).where(eq(books.id, input.bookId));
  return { ok: true };
}

/**
 * Replace the book's story selection with `storyIds`, in that order. One idempotent
 * call covers add, remove, and reorder — much easier for the agent than move ops.
 */
export async function setBookStories(input: {
  bookId: string;
  userId: string;
  storyIds: string[];
}): Promise<Result> {
  const gate = await editableBook(input.bookId, input.userId);
  if (!gate.ok) return gate;
  const unique = [...new Set(input.storyIds)];
  if (unique.length === 0) return err('A book needs at least one story.');

  // Every story must be ready and shared into the book's chronicle.
  const valid = await db
    .select({ id: stories.id })
    .from(storyChronicles)
    .innerJoin(stories, eq(storyChronicles.storyId, stories.id))
    .where(
      and(
        eq(storyChronicles.chronicleId, gate.book.chronicleId),
        inArray(stories.id, unique),
        eq(stories.status, 'ready'),
      ),
    );
  const validIds = new Set(valid.map((v) => v.id));
  const missing = unique.filter((id) => !validIds.has(id));
  if (missing.length) {
    return err(`Not ready stories of this chronicle: ${missing.join(', ')}`);
  }

  await db.transaction(async (tx) => {
    await tx.delete(bookStories).where(eq(bookStories.bookId, input.bookId));
    await tx
      .insert(bookStories)
      .values(unique.map((storyId, position) => ({ bookId: input.bookId, storyId, position })));
    // Cover may have belonged to a story that just left the book.
    const cover = gate.book.coverAssetId;
    const set: Partial<typeof books.$inferInsert> = { ...invalidatePreview() };
    if (cover) {
      const still = await tx
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.id, cover), inArray(assets.storyId, unique)))
        .limit(1);
      if (still.length === 0) set.coverAssetId = null;
    }
    await tx.update(books).set(set).where(eq(books.id, input.bookId));
  });
  return { ok: true };
}

/** Queue a preview render. */
export async function requestPreview(input: {
  bookId: string;
  userId: string;
}): Promise<Result> {
  const gate = await editableBook(input.bookId, input.userId);
  if (!gate.ok) return gate;
  if (gate.book.chapters.length === 0) return err('Add at least one story before rendering.');
  if (gate.book.status === 'rendering') return err('A preview is already being rendered.');

  await db
    .update(books)
    .set({ status: 'rendering', errorMessage: null, updatedAt: new Date() })
    .where(eq(books.id, input.bookId));
  await enqueueRenderBook({ bookId: input.bookId });
  return { ok: true };
}

/** Price the book as it currently stands (uses rendered page count or an estimate). */
export async function quoteBook(input: {
  bookId: string;
  userId: string;
}): Promise<Result<{ quote: BookQuote }>> {
  const book = await getBookForUser(input.bookId, input.userId);
  if (!book) return err('Book not found.');
  const pageCount = book.pageCount ?? estimatePageCount(book);
  const quote = await quoteBookPrice({ format: book.format, pageCount });
  return { ok: true, value: { quote } };
}

/**
 * Rough page estimate before a render exists: ~2.5 pages of prose per story plus
 * a page per two photos, front matter, and chapter starts on right-hand pages.
 */
export function estimatePageCount(book: Pick<BookDetail, 'chapters'>): number {
  const front = 4; // cover sheet, title page, TOC, blank
  const perStory = book.chapters.reduce(
    (sum, c) => sum + 3 + Math.ceil(c.photoCount / 2),
    0,
  );
  return front + perStory;
}

/**
 * Place the v1 order: snapshot the quote, lock the book, notify the admin.
 * No payment, no Gelato submission — the admin follows up personally.
 */
export async function placeOrder(input: {
  bookId: string;
  userId: string;
}): Promise<Result<{ orderId: string }>> {
  const gate = await editableBook(input.bookId, input.userId);
  if (!gate.ok) return gate;
  const book = gate.book;
  if (book.status !== 'preview_ready') {
    return err('Render and review a preview before ordering.');
  }

  const pageCount = book.pageCount ?? estimatePageCount(book);
  const quote = await quoteBookPrice({ format: book.format, pageCount });

  const orderId = await db.transaction(async (tx) => {
    const [order] = await tx
      .insert(bookOrders)
      .values({ bookId: input.bookId, orderedBy: input.userId, quote })
      .returning();
    await tx
      .update(books)
      .set({ status: 'ordered', updatedAt: new Date() })
      .where(eq(books.id, input.bookId));
    return order.id;
  });

  // Best-effort notification — the order row is the source of truth.
  const [orderer] = await db.select().from(user).where(eq(user.id, input.userId)).limit(1);
  const to = env.BOOK_ORDER_NOTIFY_EMAIL;
  const priceLine = quote.priced
    ? `${quote.total?.toFixed(2)} EUR (product ${quote.productCost?.toFixed(2)} + shipping ${quote.shippingCost?.toFixed(2)} + margin ${quote.margin.toFixed(2)})`
    : 'price on request (Gelato quote unavailable)';
  const text = [
    `A book was ordered in Family Chronicle.`,
    ``,
    `Order id:   ${orderId}`,
    `Book:       "${book.title}" (${book.format}, ${pageCount} pages, ${book.chapters.length} stories)`,
    `Chronicle:  ${book.chronicleName}`,
    `Ordered by: ${orderer?.name ?? 'unknown'} <${orderer?.email ?? 'unknown'}>`,
    `Quoted:     ${priceLine}`,
    ``,
    `Print PDF (S3 key): ${book.printS3Key ?? '—'}`,
    `Preview:    ${env.BETTER_AUTH_URL}/books/${book.id}`,
    ``,
    `Reach out to the user for payment and shipping details.`,
  ].join('\n');
  try {
    if (to) await sendEmail({ to, subject: `📖 Book order: "${book.title}"`, text });
    else console.log(`[books] BOOK_ORDER_NOTIFY_EMAIL not set — order notification:\n${text}`);
  } catch (e) {
    console.error('[books] order notification failed:', e);
  }

  return { ok: true, value: { orderId } };
}
