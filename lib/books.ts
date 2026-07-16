import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import {
  assets,
  books,
  bookStories,
  chronicles,
  memberships,
  stories,
  storyChronicles,
  storyPeople,
  user,
} from '@/db/schema';
import { getMembership } from '@/lib/chronicles';
import {
  canReadStory,
  loadStoryAccessContext,
  type StoryAccessContext,
  type StoryAccessInput,
} from '@/lib/story-access';
import { canContribute, type AccessRole } from '@/lib/permissions';
import { deleteObject } from '@/lib/s3';
import { enqueueDesignBook, enqueueRenderBook } from '@/lib/queue';
import { quoteBookPrice, type BookFormat, type BookQuote } from '@/lib/gelato';
import {
  buildAndPersistAutoPlan,
  loadBook,
  loadOrBuildPlan,
  paragraphs,
  type LoadedBook,
} from '@/lib/book-content';
import {
  checkPlanConsistency,
  validateLayoutPlan,
  type Block,
  type CoverStyle,
  type FigureSize,
  type LayoutPlan,
  type LayoutTheme,
  type PlanContent,
} from '@/lib/book-layout-plan';

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

/* ──────────────────────────────────────────────────────────────────────────
 * Story read access for books (docs/STORY_ACCESS_PLAN.md, Books section).
 * Every story in a book is shared into the book's chronicle, so when the
 * acting user OWNS that chronicle or it's in 'open' mode, membership alone
 * grants every chapter — the fast path that skips loading per-story
 * people/chronicle facts (and, inside loadStoryAccessContext, the kinship
 * graph) entirely. Everything behaves exactly as before when all chronicles
 * are 'open' (the default).
 * ────────────────────────────────────────────────────────────────────────── */

/** Fast path: the user reads every story of this chronicle regardless of tagging. */
function readsWholeChronicle(ctx: StoryAccessContext, chronicleId: string): boolean {
  return ctx.ownerChronicleIds.has(chronicleId) || ctx.openChronicleIds.has(chronicleId);
}

/** The ids among `storyRows` the user may read, per the full three-clause rule
 *  (loads each story's chronicles + tagged people; no fast path — callers check that). */
async function readableStoryIds(
  ctx: StoryAccessContext,
  storyRows: Array<{ id: string; submittedBy: string }>,
): Promise<Set<string>> {
  const ids = storyRows.map((s) => s.id);
  if (ids.length === 0) return new Set();
  const [chronicleRows, personRows] = await Promise.all([
    db
      .select({ storyId: storyChronicles.storyId, chronicleId: storyChronicles.chronicleId })
      .from(storyChronicles)
      .where(inArray(storyChronicles.storyId, ids)),
    db
      .select({ storyId: storyPeople.storyId, personId: storyPeople.personId })
      .from(storyPeople)
      .where(inArray(storyPeople.storyId, ids)),
  ]);
  const facts = new Map<string, StoryAccessInput>(
    storyRows.map((s) => [s.id, { submittedBy: s.submittedBy, chronicleIds: [], personIds: [] }]),
  );
  for (const r of chronicleRows) facts.get(r.storyId)?.chronicleIds.push(r.chronicleId);
  for (const r of personRows) facts.get(r.storyId)?.personIds.push(r.personId);

  const out = new Set<string>();
  for (const row of storyRows) {
    const f = facts.get(row.id);
    if (f && canReadStory(ctx, f)) out.add(row.id);
  }
  return out;
}

/**
 * Shared validation for every path that puts stories into a book (create, replace —
 * the UI actions and the agent's tools all funnel here): each story must be ready,
 * shared into the book's chronicle, and readable by the ACTING user, so nobody can
 * put a story they can't read into a book (and thereby leak it via preview/PDF).
 */
async function ensureUsableBookStories(
  chronicleId: string,
  storyIds: string[],
  ctx: StoryAccessContext,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const unique = [...new Set(storyIds)];
  const valid = await db
    .select({ id: stories.id, title: stories.title, submittedBy: stories.submittedBy })
    .from(storyChronicles)
    .innerJoin(stories, eq(storyChronicles.storyId, stories.id))
    .where(
      and(
        eq(storyChronicles.chronicleId, chronicleId),
        inArray(stories.id, unique),
        eq(stories.status, 'ready'),
      ),
    );
  const validIds = new Set(valid.map((v) => v.id));
  const missing = unique.filter((id) => !validIds.has(id));
  if (missing.length) {
    return err(`Not ready stories of this chronicle: ${missing.join(', ')}`);
  }
  if (!readsWholeChronicle(ctx, chronicleId)) {
    const readable = await readableStoryIds(ctx, valid);
    const offending = valid.filter((v) => !readable.has(v.id));
    if (offending.length) {
      return err(
        `You don't have access to these stories, so they can't go into your book: ${offending
          .map((v) => `"${v.title}"`)
          .join(', ')}`,
      );
    }
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
  /** Who last wrote the layout plan: the heuristic auto-layouter, an AI design pass, or a
   *  manual edit (manual edits are phase 4; the type already allows for them). */
  layoutSource: 'auto' | 'ai' | 'edited';
  /** Set while an AI design job is queued/running; null once it completes (success or
   *  fallback). Drives the builder's "Design my book" working state. */
  designRequestedAt: Date | null;
  updatedAt: Date;
  /** Only the chapters the VIEWING user can read (docs/STORY_ACCESS_PLAN.md). */
  chapters: BookChapter[];
  /** How many of the book's chapters are hidden from this viewer. 0 for owners and
   *  in 'open'-mode chronicles; > 0 blocks chapter mutations, PDFs, and ordering. */
  hiddenChapterCount: number;
}

/**
 * A book with its ordered chapters, gated to chronicle members. The chapter list is
 * per-viewer: stories the viewer can't read are filtered out (their count lands in
 * `hiddenChapterCount`), so every consumer — builder page, agent tools, routes —
 * only ever sees readable content. Pass `accessCtx` when the caller already loaded
 * the viewer's story-access context (one load per request).
 */
export async function getBookForUser(
  bookId: string,
  userId: string,
  accessCtx?: StoryAccessContext,
): Promise<BookDetail | null> {
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
      submittedBy: stories.submittedBy,
    })
    .from(bookStories)
    .innerJoin(stories, eq(bookStories.storyId, stories.id))
    .where(eq(bookStories.bookId, bookId))
    .orderBy(asc(bookStories.position));

  // Per-viewer read model: hide chapters the viewer can't read. Fast path when the
  // viewer owns the chronicle or it's 'open' — every book story is shared into the
  // book's chronicle, so membership alone grants everything (no extra queries).
  const ctx = accessCtx ?? (await loadStoryAccessContext(userId));
  let visibleChapters = chapterRows;
  if (!readsWholeChronicle(ctx, row.book.chronicleId)) {
    const readable = await readableStoryIds(
      ctx,
      chapterRows.map((c) => ({ id: c.storyId, submittedBy: c.submittedBy })),
    );
    visibleChapters = chapterRows.filter((c) => readable.has(c.storyId));
  }
  const hiddenChapterCount = chapterRows.length - visibleChapters.length;

  const storyIds = visibleChapters.map((c) => c.storyId);
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
    layoutSource: row.book.layoutSource as 'auto' | 'ai' | 'edited',
    designRequestedAt: row.book.designRequestedAt,
    updatedAt: row.book.updatedAt,
    chapters: visibleChapters.map((c, i) => ({
      storyId: c.storyId,
      position: c.position ?? i,
      includePhotos: c.includePhotos,
      title: c.title,
      summary: c.summary,
      eventDate: c.eventDate,
      status: c.status,
      photoCount: photosByStory.get(c.storyId) ?? 0,
    })),
    hiddenChapterCount,
  };
}

/**
 * Ready stories of a chronicle, in book order (event date, then created) —
 * restricted to what the ACTING user can read, so the story picker (and the
 * default all-stories selection of `createBook`) never offers a story that
 * couldn't legitimately go into the user's book.
 */
export async function readyStoriesForChronicle(
  chronicleId: string,
  userId: string,
  accessCtx?: StoryAccessContext,
) {
  const rows = await db
    .select({
      id: stories.id,
      title: stories.title,
      summary: stories.summary,
      eventDate: stories.eventDate,
      createdAt: stories.createdAt,
      submitterName: user.name,
      submittedBy: stories.submittedBy,
    })
    .from(storyChronicles)
    .innerJoin(stories, eq(storyChronicles.storyId, stories.id))
    .innerJoin(user, eq(stories.submittedBy, user.id))
    .where(and(eq(storyChronicles.chronicleId, chronicleId), eq(stories.status, 'ready')))
    .orderBy(asc(stories.eventDate), asc(stories.createdAt));

  const ctx = accessCtx ?? (await loadStoryAccessContext(userId));
  const visible = readsWholeChronicle(ctx, chronicleId)
    ? rows
    : await readableStoryIds(ctx, rows).then((readable) => rows.filter((r) => readable.has(r.id)));
  // `submittedBy` was only fetched for the access check — don't hand it out.
  return visible.map((r) => ({
    id: r.id,
    title: r.title,
    summary: r.summary,
    eventDate: r.eventDate,
    createdAt: r.createdAt,
    submitterName: r.submitterName,
  }));
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
  const ctx = await loadStoryAccessContext(input.userId);

  let storyIds = input.storyIds;
  if (!storyIds) {
    storyIds = (await readyStoriesForChronicle(input.chronicleId, input.userId, ctx)).map(
      (s) => s.id,
    );
  } else {
    const usable = await ensureUsableBookStories(input.chronicleId, storyIds, ctx);
    if (!usable.ok) return usable;
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
        title: input.title.trim() || 'Familienwerk',
      })
      .returning();
    await tx
      .insert(bookStories)
      .values(storyIds.map((storyId, position) => ({ bookId: created.id, storyId, position })));
    return created.id;
  });
  return { ok: true, value: { bookId } };
}

/** Guard shared by every mutation: member, contributor, and the book not locked.
 *  Also hands back the acting user's story-access context so mutations that need
 *  per-story checks don't load it a second time. */
async function editableBook(
  bookId: string,
  userId: string,
): Promise<
  { ok: true; book: BookDetail; ctx: StoryAccessContext } | { ok: false; error: string }
> {
  const ctx = await loadStoryAccessContext(userId);
  const book = await getBookForUser(bookId, userId, ctx);
  if (!book) return err('Book not found.');
  const gate = await ensureBookAccess(book.chronicleId, userId);
  if (!gate.ok) return gate;
  if (book.status === 'ordered') {
    return err('This book has been ordered and is locked. Create a new book to make changes.');
  }
  return { ok: true, book, ctx };
}

/**
 * Content changed → any existing preview no longer matches; drop back to draft.
 * Also flags the layout plan stale — it may reference stories/photos that were
 * just removed, or paragraph counts may have shifted — so the next render
 * rebuilds it (see lib/book-render.ts).
 */
function invalidatePreview() {
  return {
    status: 'draft' as const,
    errorMessage: null,
    layoutStale: true,
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
 * Delete a book permanently: the row, its story selection (FK cascade), and its
 * rendered PDFs in storage. The stories and photos themselves are untouched — a
 * book is only a selection over them. Ordered books are locked (and `book_orders`
 * restricts their deletion at the DB level anyway).
 */
export async function deleteBook(input: { bookId: string; userId: string }): Promise<Result> {
  const gate = await editableBook(input.bookId, input.userId);
  if (!gate.ok) return gate;

  await db.delete(books).where(eq(books.id, input.bookId));

  // Storage cleanup AFTER the row is gone — a failed object delete must not leave a
  // half-deleted book behind; a stray PDF object is the cheaper failure.
  for (const key of [gate.book.previewS3Key, gate.book.printS3Key]) {
    if (!key) continue;
    try {
      await deleteObject(key);
    } catch (e) {
      console.error(`[books] failed to delete ${key} for removed book ${input.bookId}:`, e);
    }
  }
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
  // A viewer with hidden chapters only sees part of the chapter list — a full
  // replace from their view would silently drop the chapters they can't see.
  // Owners always see everything, so this never blocks them.
  if (gate.book.hiddenChapterCount > 0) {
    return err(
      "Some of this book's chapters are stories you don't have access to — only someone who can read every story can change the book's chapters.",
    );
  }
  const unique = [...new Set(input.storyIds)];
  if (unique.length === 0) return err('A book needs at least one story.');

  // Every story must be ready, shared into the book's chronicle, and readable
  // by the acting user.
  const usable = await ensureUsableBookStories(gate.book.chronicleId, unique, gate.ctx);
  if (!usable.ok) return usable;

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

/**
 * Queue the print-proof render: the worker's `render-book` job prints the layout
 * plan to two PDFs (a low-res preview + the full-resolution print PDF) via
 * Chromium. The builder's own preview pane no longer depends on this — it's live
 * HTML (app/api/books/[bookId]/preview-html) — so this is now only needed before
 * ordering (exact page count → quote) or when a PDF proof is explicitly wanted.
 */
export async function requestPreview(input: {
  bookId: string;
  userId: string;
}): Promise<Result> {
  const gate = await editableBook(input.bookId, input.userId);
  if (!gate.ok) return gate;
  // The rendered PDF physically contains EVERY chapter — all-or-nothing: only
  // someone who can read all of the book's stories may trigger (and later fetch) it.
  if (gate.book.hiddenChapterCount > 0) {
    return err(
      "Some of this book's chapters are stories you don't have access to — the print PDF contains every chapter, so only someone who can read all of them can render or order it.",
    );
  }
  if (gate.book.chapters.length === 0) return err('Add at least one story before rendering.');
  if (gate.book.status === 'rendering') return err('A preview is already being rendered.');

  await db
    .update(books)
    .set({ status: 'rendering', errorMessage: null, updatedAt: new Date() })
    .where(eq(books.id, input.bookId));
  await enqueueRenderBook({ bookId: input.bookId });
  return { ok: true };
}

/**
 * Queue the AI design pass (docs/BOOK_LAYOUT_PLAN.md §5, producer #2): a vision model
 * looks at the book's actual photos and proposes a new layout plan, replacing the
 * current one (AI's plan on success, a freshly-built auto plan on failure — see the
 * `design-book` worker handler, `lib/book-ai-layout.ts`). Does NOT touch `status` or
 * the print PDFs: the builder's own preview is live HTML and picks up the new plan on
 * its next request; the stored print proof is separately invalidated by the layout
 * change becoming visible (its `layoutStale`/content-changed handling already covers
 * this — a design pass doesn't remove or add stories, only rearranges existing ones).
 *
 * Consent guard: if the plan currently in place was a manual edit (`layoutSource ===
 * 'edited'` — see `updateBookLayout` below), the caller must pass
 * `overwriteEdits: true` to proceed.
 */
export async function requestAiDesign(input: {
  bookId: string;
  userId: string;
  overwriteEdits?: boolean;
}): Promise<Result> {
  const gate = await editableBook(input.bookId, input.userId);
  if (!gate.ok) return gate;
  if (gate.book.chapters.length === 0) return err('Add at least one story before designing.');
  if (gate.book.designRequestedAt) return err('An AI design pass is already running for this book.');
  if (gate.book.layoutSource === 'edited' && !input.overwriteEdits) {
    return err(
      'This book\'s layout has manual edits. Designing it again with AI would replace them — try again to confirm.',
    );
  }

  await db.update(books).set({ designRequestedAt: new Date() }).where(eq(books.id, input.bookId));
  await enqueueDesignBook({ bookId: input.bookId });
  return { ok: true };
}

/**
 * Rebuild the deterministic auto plan on demand — the "Reset layout" action. Same
 * consent guard as `requestAiDesign`: an `edited` plan requires `overwriteEdits: true`.
 * Theme/cover style/pinned hero still carry over (see `buildAndPersistAutoPlan`) — this
 * resets photo *placement* back to the heuristic default, not the user's design choices.
 */
export async function resetBookLayout(input: {
  bookId: string;
  userId: string;
  overwriteEdits?: boolean;
}): Promise<Result> {
  const gate = await editableBook(input.bookId, input.userId);
  if (!gate.ok) return gate;
  if (gate.book.chapters.length === 0) return err('Add at least one story before resetting the layout.');
  if (gate.book.layoutSource === 'edited' && !input.overwriteEdits) {
    return err(
      'This book\'s layout has manual edits. Resetting it would replace them — try again to confirm.',
    );
  }
  const loaded = await loadBook(input.bookId);
  await buildAndPersistAutoPlan(input.bookId, loaded);
  return { ok: true };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Layout editing — targeted, validated mutations of the stored plan
 * (docs/BOOK_LAYOUT_PLAN.md §6 phase 4). The builder UI and the chat agent's
 * `update_book_layout` tool are both thin wrappers over `updateBookLayout`.
 * ────────────────────────────────────────────────────────────────────────── */

export type LayoutOp =
  | { op: 'set_theme'; theme: LayoutTheme }
  | { op: 'set_cover_style'; style: CoverStyle }
  | { op: 'set_cover_hero'; assetId: string }
  | { op: 'set_figure_size'; assetId: string; size: FigureSize }
  | { op: 'promote_photo_page'; assetId: string }
  | { op: 'demote_photo_page'; assetId: string }
  | { op: 'move_block'; storyId: string; blockIndex: number; direction: 'up' | 'down' };

type ImageBlock = Extract<Block, { type: 'figure' | 'photo-page' | 'photo-row' | 'photo-grid' }>;

function isImageBlock(block: Block): block is ImageBlock {
  return block.type !== 'paragraphs';
}

/** Where `assetId` currently sits in a chapter's block list: alone (figure/photo-page) or
 *  as one member of a group (photo-row/photo-grid), which carries the group's full id list
 *  so the caller can compute what remains after extracting it. */
type ImageLocation =
  | { kind: 'single'; blockIndex: number }
  | { kind: 'group'; blockIndex: number; groupAssetIds: string[] };

function findImageLocation(blocks: Block[], assetId: string): ImageLocation | null {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if ((b.type === 'figure' || b.type === 'photo-page') && b.assetId === assetId) {
      return { kind: 'single', blockIndex: i };
    }
    if ((b.type === 'photo-row' || b.type === 'photo-grid') && b.assetIds.includes(assetId)) {
      return { kind: 'group', blockIndex: i, groupAssetIds: b.assetIds };
    }
  }
  return null;
}

/** The block the remaining images of a row/grid collapse into once one is extracted —
 *  1 left => a full figure, 2 left => a photo-row, 3+ left => a (still valid) photo-grid. */
function collapsedGroupBlock(remainingAssetIds: string[]): Block {
  if (remainingAssetIds.length === 1) {
    return { type: 'figure', assetId: remainingAssetIds[0], size: 'full' };
  }
  if (remainingAssetIds.length === 2) {
    return { type: 'photo-row', assetIds: remainingAssetIds };
  }
  return { type: 'photo-grid', assetIds: remainingAssetIds };
}

/**
 * Replaces wherever `assetId` currently sits in `blocks` with `newBlock`, extracting it
 * from a photo-row/photo-grid first when needed — the remaining images of that group
 * collapse into a smaller, still-valid group (or a single figure) in the same spot, and
 * the new block for `assetId` is inserted right after it. Used by `set_figure_size` and
 * `promote_photo_page`, which both mean "this image becomes exactly this one block,
 * wherever it was."
 */
function relocateImage(
  blocks: Block[],
  assetId: string,
  newBlock: Block,
): Block[] | { error: string } {
  const loc = findImageLocation(blocks, assetId);
  if (!loc) return { error: `That photo isn't currently placed in this book's layout.` };
  const out = blocks.slice();
  if (loc.kind === 'single') {
    out[loc.blockIndex] = newBlock;
    return out;
  }
  const remaining = loc.groupAssetIds.filter((id) => id !== assetId);
  out.splice(loc.blockIndex, 1, collapsedGroupBlock(remaining), newBlock);
  return out;
}

/** Swaps the image block at `blockIndex` with its neighbor among the chapter's OTHER
 *  image blocks — paragraph blocks never move, only the image blocks change slots
 *  around them (docs/BOOK_LAYOUT_PLAN.md §6 phase 4, `move_block`). */
function moveImageBlock(
  blocks: Block[],
  blockIndex: number,
  direction: 'up' | 'down',
): Block[] | { error: string } {
  if (blockIndex < 0 || blockIndex >= blocks.length || !isImageBlock(blocks[blockIndex])) {
    return { error: 'That is not a photo block in this chapter.' };
  }
  const imageIndices = blocks.map((_, i) => i).filter((i) => isImageBlock(blocks[i]));
  const pos = imageIndices.indexOf(blockIndex);
  const targetPos = direction === 'up' ? pos - 1 : pos + 1;
  if (targetPos < 0 || targetPos >= imageIndices.length) {
    return { error: `That photo is already ${direction === 'up' ? 'first' : 'last'} among this chapter's photos.` };
  }
  const otherIndex = imageIndices[targetPos];
  const out = blocks.slice();
  [out[blockIndex], out[otherIndex]] = [out[otherIndex], out[blockIndex]];
  return out;
}

/** Finds which chapter of the plan currently places `assetId` in an image block. */
function findChapterForAsset(plan: LayoutPlan, assetId: string): number {
  return plan.chapters.findIndex((c) => findImageLocation(c.blocks, assetId) != null);
}

/** Applies one `LayoutOp` to `plan`, returning the new plan or an error. Pure — no I/O,
 *  no DB access; `updateBookLayout` validates + persists the result once, after every op
 *  in the batch has applied cleanly. */
function applyLayoutOp(
  plan: LayoutPlan,
  loaded: LoadedBook,
  op: LayoutOp,
): { plan: LayoutPlan; markEdited: boolean; coverAssetId?: string } | { error: string } {
  switch (op.op) {
    case 'set_theme': {
      return { plan: { ...plan, theme: op.theme }, markEdited: false };
    }
    case 'set_cover_style': {
      return { plan: { ...plan, cover: { ...plan.cover, style: op.style } }, markEdited: true };
    }
    case 'set_cover_hero': {
      if (!loaded.allPhotosById.has(op.assetId)) {
        return { error: 'The cover photo must belong to a story in this book.' };
      }
      return {
        plan: { ...plan, cover: { ...plan.cover, heroAssetId: op.assetId } },
        markEdited: true,
        coverAssetId: op.assetId,
      };
    }
    case 'set_figure_size': {
      const chapterIdx = findChapterForAsset(plan, op.assetId);
      if (chapterIdx === -1) return { error: `That photo isn't currently placed in this book's layout.` };
      const result = relocateImage(plan.chapters[chapterIdx].blocks, op.assetId, {
        type: 'figure',
        assetId: op.assetId,
        size: op.size,
      });
      if ('error' in result) return result;
      const chapters = plan.chapters.slice();
      chapters[chapterIdx] = { ...chapters[chapterIdx], blocks: result };
      return { plan: { ...plan, chapters }, markEdited: true };
    }
    case 'promote_photo_page': {
      const chapterIdx = findChapterForAsset(plan, op.assetId);
      if (chapterIdx === -1) return { error: `That photo isn't currently placed in this book's layout.` };
      const result = relocateImage(plan.chapters[chapterIdx].blocks, op.assetId, {
        type: 'photo-page',
        assetId: op.assetId,
      });
      if ('error' in result) return result;
      const chapters = plan.chapters.slice();
      chapters[chapterIdx] = { ...chapters[chapterIdx], blocks: result };
      return { plan: { ...plan, chapters }, markEdited: true };
    }
    case 'demote_photo_page': {
      const chapterIdx = plan.chapters.findIndex((c) =>
        c.blocks.some((b) => b.type === 'photo-page' && b.assetId === op.assetId),
      );
      if (chapterIdx === -1) return { error: 'That photo does not currently have its own page.' };
      const blocks = plan.chapters[chapterIdx].blocks.map((b) =>
        b.type === 'photo-page' && b.assetId === op.assetId
          ? ({ type: 'figure', assetId: op.assetId, size: 'full' } satisfies Block)
          : b,
      );
      const chapters = plan.chapters.slice();
      chapters[chapterIdx] = { ...chapters[chapterIdx], blocks };
      return { plan: { ...plan, chapters }, markEdited: true };
    }
    case 'move_block': {
      const chapterIdx = plan.chapters.findIndex((c) => c.storyId === op.storyId);
      if (chapterIdx === -1) return { error: `No chapter with story id ${op.storyId} in this book.` };
      const result = moveImageBlock(plan.chapters[chapterIdx].blocks, op.blockIndex, op.direction);
      if ('error' in result) return result;
      const chapters = plan.chapters.slice();
      chapters[chapterIdx] = { ...chapters[chapterIdx], blocks: result };
      return { plan: { ...plan, chapters }, markEdited: true };
    }
  }
}

/**
 * Applies one or more targeted layout ops to a book's plan (§6 phase 4's producer #3:
 * explicit edits). Builds an auto plan first if none exists yet (`loadOrBuildPlan`, same
 * as the live preview), applies every op in order, then validates the result against both
 * the schema and the book's current content before persisting — an op that would leave
 * the plan invalid is rejected and NOTHING is written, including the other ops in the same
 * batch, so the stored plan is never left half-mutated.
 *
 * Every op except `set_theme` sets `layout_source: 'edited'` and clears `layout_stale`;
 * `set_theme` never marks the plan edited, so a saved theme survives both auto and AI
 * regeneration exactly like a saved cover style (see `buildLayoutPlan`/`applyPlanCarryOver`).
 * Locked (ordered) books are rejected by `editableBook`, same as every other mutation.
 */
export async function updateBookLayout(input: {
  bookId: string;
  userId: string;
  ops: LayoutOp[];
}): Promise<Result> {
  const gate = await editableBook(input.bookId, input.userId);
  if (!gate.ok) return gate;
  if (input.ops.length === 0) return { ok: true };

  const loaded = await loadBook(input.bookId);
  let plan = await loadOrBuildPlan(input.bookId, loaded);
  let markEdited = false;
  let coverAssetId: string | undefined;

  for (const op of input.ops) {
    const result = applyLayoutOp(plan, loaded, op);
    if ('error' in result) return err(result.error);
    plan = result.plan;
    if (result.markEdited) markEdited = true;
    if (result.coverAssetId !== undefined) coverAssetId = result.coverAssetId;
  }

  const validated = validateLayoutPlan(plan);
  if (!validated.ok) return err(`That change would leave the layout invalid: ${validated.error}`);

  const content: PlanContent = {
    chapters: loaded.chapters.map((c) => ({
      storyId: c.storyId,
      paragraphCount: paragraphs(c.body).length,
      assetIds: c.photoAssets.map((p) => p.id),
    })),
    allAssetIds: [...loaded.allPhotosById.keys()],
  };
  const problems = checkPlanConsistency(validated.plan, content);
  if (problems.length > 0) {
    return err(`That change would leave the layout invalid: ${problems.join('; ')}`);
  }

  const set: Partial<typeof books.$inferInsert> = {
    layoutPlan: validated.plan,
    updatedAt: new Date(),
  };
  if (markEdited) {
    set.layoutSource = 'edited';
    set.layoutStale = false;
  }
  if (coverAssetId !== undefined) set.coverAssetId = coverAssetId;

  await db.update(books).set(set).where(eq(books.id, input.bookId));
  return { ok: true };
}

export interface LayoutImageBlockSummary {
  /** Index into that chapter's plan.blocks — what `move_block` takes as `blockIndex`. */
  blockIndex: number;
  assetId: string;
  caption: string | null;
  type: 'figure' | 'photo-row' | 'photo-grid' | 'photo-page';
  /** Only set for `type: 'figure'`. */
  size?: FigureSize;
  /** Only set for `type: 'photo-row' | 'photo-grid'` — every assetId in that group,
   *  including this one, in plan order. */
  groupAssetIds?: string[];
}

export interface LayoutChapterSummary {
  storyId: string;
  images: LayoutImageBlockSummary[];
}

export interface BookLayoutSummary {
  theme: LayoutTheme;
  coverStyle: CoverStyle;
  coverHeroAssetId: string | null;
  chapters: LayoutChapterSummary[];
}

/**
 * The book's current layout plan, flattened into per-chapter image lists addressable by
 * the ops above — every image block's assetId, caption, current placement, and
 * `blockIndex`. Shared by the builder's Layout card (thumbnails + controls) and the
 * agent's `get_book` tool (so the model can address photos by id after just one read).
 * Read-only: does not build+persist a missing plan the way editing ops do, but still
 * needs SOME plan to summarize, so it reuses `loadOrBuildPlan` exactly like the live
 * preview route — a book with no stored plan yet gets a fresh auto plan, same as opening
 * the preview would.
 */
export async function getBookLayoutSummary(
  bookId: string,
  userId: string,
  accessCtx?: StoryAccessContext,
): Promise<Result<BookLayoutSummary>> {
  const book = await getBookForUser(bookId, userId, accessCtx);
  if (!book) return err('Book not found.');
  const loaded = await loadBook(bookId);
  const plan = await loadOrBuildPlan(bookId, loaded);

  // Per-viewer: chapters hidden from `book.chapters` are dropped here too, so the
  // summary never leaks a hidden chapter's photos or captions (builder Layout card
  // and the agent's get_book both read this).
  const visibleStories = new Set(book.chapters.map((c) => c.storyId));
  const visiblePlanChapters =
    book.hiddenChapterCount > 0
      ? plan.chapters.filter((c) => visibleStories.has(c.storyId))
      : plan.chapters;

  const chapters: LayoutChapterSummary[] = visiblePlanChapters.map((chapterPlan) => {
    const images: LayoutImageBlockSummary[] = [];
    chapterPlan.blocks.forEach((block, blockIndex) => {
      if (block.type === 'figure') {
        images.push({
          blockIndex,
          assetId: block.assetId,
          caption: loaded.allPhotosById.get(block.assetId)?.caption ?? null,
          type: 'figure',
          size: block.size,
        });
      } else if (block.type === 'photo-page') {
        images.push({
          blockIndex,
          assetId: block.assetId,
          caption: loaded.allPhotosById.get(block.assetId)?.caption ?? null,
          type: 'photo-page',
        });
      } else if (block.type === 'photo-row' || block.type === 'photo-grid') {
        for (const assetId of block.assetIds) {
          images.push({
            blockIndex,
            assetId,
            caption: loaded.allPhotosById.get(assetId)?.caption ?? null,
            type: block.type,
            groupAssetIds: block.assetIds,
          });
        }
      }
    });
    return { storyId: chapterPlan.storyId, images };
  });

  return {
    ok: true,
    value: {
      theme: plan.theme,
      coverStyle: plan.cover.style,
      coverHeroAssetId: plan.cover.heroAssetId ?? null,
      chapters,
    },
  };
}

/** Price the book as it currently stands (uses rendered page count or an estimate). */
export async function quoteBook(input: {
  bookId: string;
  userId: string;
}): Promise<Result<{ quote: BookQuote }>> {
  const book = await getBookForUser(input.bookId, input.userId);
  if (!book) return err('Book not found.');
  // Quoting is part of the order flow, which needs the all-chapters print PDF.
  if (book.hiddenChapterCount > 0) {
    return err(
      "Some of this book's chapters are stories you don't have access to — the printed book contains every chapter, so only someone who can read all of them can price or order it.",
    );
  }
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

/*
 * Ordering deliberately has no in-app write path right now: the order screen shows
 * the quote and asks the user to email BOOK_ORDER_CONTACT_EMAIL with the on-screen
 * details. The `book_orders` table and the `ordered` status stay in the schema for
 * the future payment flow (Stripe + automatic Gelato submission).
 */
