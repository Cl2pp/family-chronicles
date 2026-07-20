import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  assets,
  books,
  bookPhotos,
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
import { MAX_PHOTOS_PER_BOOK } from '@/lib/uploads';
import { deleteObject } from '@/lib/s3';
import {
  enqueueDesignBook,
  enqueueDesignPhotoBook,
  enqueuePhotoMeta,
  enqueueRenderBook,
  enqueueThumbnail,
} from '@/lib/queue';
import { enqueuePendingPhotoVisionBatches } from '@/lib/photo-vision';
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
import {
  buildAndPersistPhotoAutoPlan,
  countPhotoBookPages,
  loadOrBuildPhotoPlan,
  loadPhotoBook,
  referencedPhotoAssetIds,
} from '@/lib/photo-book-content';
import {
  checkPhotoBookPlanConsistency,
  validatePhotoBookPlan,
  type PhotoBookPlan,
  type PhotoBookStyle,
  type PhotoPageTemplate,
  type PhotoPlanContent,
} from '@/lib/photo-book-plan';
import {
  applyPhotoLayoutOp,
  findMergeSectionsIndexHazard,
  removePhotoFromPlan,
  type PhotoLayoutOp,
} from '@/lib/photo-book-ops';
import type { PhotoAnalysis } from '@/lib/photo-analysis';

/**
 * Book domain — the ONE place book state changes. The Books UI (server actions)
 * and the chat agent's tools (lib/ai/tools/books.ts) are both thin wrappers over
 * these functions, which is what lets a user say "reorder my book" in chat and
 * get exactly the same behavior as the builder UI.
 */

export type BookStatus = 'draft' | 'rendering' | 'preview_ready' | 'render_failed' | 'ordered';
export type BookKind = 'story' | 'photo';

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
      // Ids, not titles: the actor can't read these stories, so even a title
      // in an error message would be a small oracle.
      return err(
        `You don't have access to these stories, so they can't go into your book: ${offending
          .map((v) => v.id)
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
  kind: BookKind;
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
      kind: books.kind,
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
    kind: r.kind as BookKind,
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
  kind: BookKind;
  format: BookFormat;
  status: BookStatus;
  errorMessage: string | null;
  pageCount: number | null;
  previewS3Key: string | null;
  printS3Key: string | null;
  /** Who last wrote the layout plan: the heuristic auto-layouter, an AI design pass, or a
   *  manual edit (manual edits are phase 4; the type already allows for them). */
  layoutSource: 'auto' | 'ai' | 'edited';
  /** True when the book's content changed since `layoutPlan` was built (a photo was
   *  added/excluded, a chat op touched the plan) — the render/download flow uses this to
   *  decide whether a stored `preview_ready` PDF still matches the book's current content
   *  or must be re-rendered first (docs/PHOTO_BOOK_PLAN.md PR5, "Download PDF"). */
  layoutStale: boolean;
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
  // `assets.storyId` is nullable (book-owned photos), but every row here came from a
  // query filtered to `storyId IN (storyIds)`, so it's never null in practice.
  for (const p of photoRows) {
    if (!p.storyId) continue;
    photosByStory.set(p.storyId, (photosByStory.get(p.storyId) ?? 0) + 1);
  }

  // Same boundary for the cover photo: if it belongs to a hidden chapter, the
  // viewer gets `null` rather than an asset id they couldn't otherwise see.
  let coverAssetId = row.book.coverAssetId;
  if (coverAssetId && hiddenChapterCount > 0) {
    const [cover] = await db
      .select({ storyId: assets.storyId })
      .from(assets)
      .where(eq(assets.id, coverAssetId))
      .limit(1);
    const visibleStoryIds = new Set(storyIds);
    if (cover && (!cover.storyId || !visibleStoryIds.has(cover.storyId))) coverAssetId = null;
  }

  return {
    id: row.book.id,
    chronicleId: row.book.chronicleId,
    chronicleName: row.chronicleName,
    createdBy: row.book.createdBy,
    title: row.book.title,
    subtitle: row.book.subtitle,
    dedication: row.book.dedication,
    coverAssetId,
    kind: row.book.kind as BookKind,
    format: row.book.format as BookFormat,
    status: row.book.status as BookStatus,
    errorMessage: row.book.errorMessage,
    pageCount: row.book.pageCount,
    previewS3Key: row.book.previewS3Key,
    printS3Key: row.book.printS3Key,
    layoutSource: row.book.layoutSource as 'auto' | 'ai' | 'edited',
    layoutStale: row.book.layoutStale,
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

/* ──────────────────────────────────────────────────────────────────────────
 * Photo books (docs/PHOTO_BOOK_PLAN.md PR 1): a second `books.kind`, built by
 * bulk-uploading photos rather than picking stories. `book_stories` stays empty;
 * photos live in `assets` (book_id set, story_id null) + `book_photos` (per-photo
 * state and the metadata the `photo-meta` worker job fills in).
 * ────────────────────────────────────────────────────────────────────────── */

/** Create an empty photo book — the bulk uploader adds photos to it afterwards. */
export async function createPhotoBook(input: {
  chronicleId: string;
  userId: string;
  title: string;
}): Promise<Result<{ bookId: string }>> {
  const gate = await ensureBookAccess(input.chronicleId, input.userId);
  if (!gate.ok) return gate;

  const [created] = await db
    .insert(books)
    .values({
      chronicleId: input.chronicleId,
      createdBy: input.userId,
      kind: 'photo',
      title: input.title.trim() || 'Fotobuch',
    })
    .returning();
  return { ok: true, value: { bookId: created.id } };
}

export interface AddBookPhotoInput {
  s3Key: string;
  mimeType: string;
  bytes: number;
  width?: number | null;
  height?: number | null;
  /** Client-read EXIF hints (§3) — the `photo-meta` job overwrites these with the
   *  authoritative, server-extracted values once it runs. */
  takenAt?: Date | null;
  gpsLat?: number | null;
  gpsLng?: number | null;
}

/** Access + lock gate shared by every photo-book mutation below — also used directly
 *  by the batch presign action, which needs the same check before signing PUT URLs. */
export async function editablePhotoBook(
  bookId: string,
  userId: string,
): Promise<{ ok: true; chronicleId: string } | { ok: false; error: string }> {
  const [row] = await db
    .select({ chronicleId: books.chronicleId, kind: books.kind, status: books.status })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);
  if (!row) return err('Book not found.');
  if (row.kind !== 'photo') return err('This is not a photo book.');
  const gate = await ensureBookAccess(row.chronicleId, userId);
  if (!gate.ok) return gate;
  if (row.status === 'ordered') {
    return err('This book has been ordered and is locked. Create a new book to make changes.');
  }
  return { ok: true, chronicleId: row.chronicleId };
}

/**
 * Attach already-uploaded photos (via the batch presign action) to a photo book:
 * one `assets` row + one `book_photos` row per photo, appended after whatever is
 * already in the book, then a `thumbnail` and a `photo-meta` job per photo — mirrors
 * `addStoryPhotoContribution`'s "insert, then enqueue" shape in spirit.
 *
 * Idempotent by `s3Key`: an `s3Key` this book already holds an asset for is skipped,
 * so a retried batch (e.g. after a flaky network response) never double-adds photos.
 *
 * The uploader flushes every 10 photos while up to 5 uploads run concurrently, so
 * more than one call can race for the same book — a `SELECT ... FOR UPDATE` on the
 * book row serializes the `position`-assignment count read and the `MAX_PHOTOS_PER_BOOK`
 * cap check within the transaction, so concurrent flushes neither overlap positions
 * nor jointly sneak the book over the cap.
 */
export async function addBookPhotos(input: {
  bookId: string;
  userId: string;
  photos: AddBookPhotoInput[];
}): Promise<Result<{ added: number }>> {
  if (input.photos.length === 0) return { ok: true, value: { added: 0 } };
  const gate = await editablePhotoBook(input.bookId, input.userId);
  if (!gate.ok) return gate;

  // The key must be one we signed for a book photo, not a guess at another object.
  if (input.photos.some((p) => !p.s3Key.startsWith('books/photos/'))) {
    return err('Invalid upload.');
  }

  const txResult = await db.transaction(async (tx) => {
    const keys = input.photos.map((p) => p.s3Key);
    const existing = await tx
      .select({ s3Key: assets.s3Key })
      .from(assets)
      .where(and(eq(assets.bookId, input.bookId), inArray(assets.s3Key, keys)));
    const existingKeys = new Set(existing.map((e) => e.s3Key));
    const fresh = input.photos.filter((p) => !existingKeys.has(p.s3Key));
    if (fresh.length === 0) return { ok: true as const, rows: [] };

    // Lock the book row for the rest of this transaction so concurrent flushes (the
    // uploader registers every 10 photos, 5 uploads running in parallel) serialize
    // here instead of both reading the same `count(*)` under READ COMMITTED and
    // assigning overlapping `position`s — see docs/PHOTO_BOOK_PLAN.md's ingestion
    // notes and the PR1 review that flagged this race.
    await tx.select({ id: books.id }).from(books).where(eq(books.id, input.bookId)).for('update');

    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(bookPhotos)
      .where(eq(bookPhotos.bookId, input.bookId));
    const startPosition = count ?? 0;

    // Same lock covers the cap check: without it, two concurrent transactions could
    // both read a count just under the cap and each insert a batch that pushes the
    // book over it.
    if (startPosition + fresh.length > MAX_PHOTOS_PER_BOOK) {
      return {
        ok: false as const,
        error: `This book can hold at most ${MAX_PHOTOS_PER_BOOK} photos (it already has ${startPosition}).`,
      };
    }

    const assetRows = await tx
      .insert(assets)
      .values(
        fresh.map((p) => ({
          storyId: null,
          bookId: input.bookId,
          kind: 'photo' as const,
          s3Key: p.s3Key,
          mimeType: p.mimeType,
          bytes: p.bytes,
          width: p.width ?? null,
          height: p.height ?? null,
        })),
      )
      .returning({ id: assets.id, s3Key: assets.s3Key });

    const bySource = new Map(fresh.map((p) => [p.s3Key, p]));
    await tx.insert(bookPhotos).values(
      assetRows.map((a, i) => {
        const source = bySource.get(a.s3Key);
        return {
          bookId: input.bookId,
          assetId: a.id,
          position: startPosition + i,
          takenAt: source?.takenAt ?? null,
          gpsLat: source?.gpsLat ?? null,
          gpsLng: source?.gpsLng ?? null,
        };
      }),
    );
    return { ok: true as const, rows: assetRows };
  });

  if (!txResult.ok) return err(txResult.error);
  const inserted = txResult.rows;

  if (inserted.length > 0) {
    // New photos may change sectioning/pacing/cover pick — flag the stored plan (if any)
    // stale so the next preview load rebuilds it (docs/PHOTO_BOOK_PLAN.md PR2, "Exclude/
    // include ... should mark the plan stale and rebuild" — the same applies to new
    // uploads). A no-op when there's no plan yet (`loadOrBuildPhotoPlan` only looks at
    // `layoutStale` when `layoutPlan` is already set).
    await db.update(books).set({ layoutStale: true, updatedAt: new Date() }).where(eq(books.id, input.bookId));
  }

  for (const a of inserted) {
    await enqueueThumbnail({ s3Key: a.s3Key });
    await enqueuePhotoMeta({ assetId: a.id });
  }
  // Vision scoring (docs/PHOTO_BOOK_PLAN.md §4) — batched separately from the per-photo
  // jobs above since it's one model request per ~10 photos, not one per photo. Only ever
  // called with assetIds this call just freshly inserted (never an id already in the
  // book — see the idempotent-by-s3Key dedup above), so a retried uploader flush can't
  // double-enqueue the same photo's scoring.
  if (inserted.length > 0) {
    await enqueuePendingPhotoVisionBatches(inserted.map((a) => a.id));
  }

  return { ok: true, value: { added: inserted.length } };
}

export interface BookPhotoItem {
  assetId: string;
  s3Key: string;
  thumbS3Key: string | null;
  mimeType: string;
  width: number | null;
  height: number | null;
  position: number;
  excluded: boolean;
  excludedReason: string | null;
  takenAt: Date | null;
  /** True once the `photo-vision` pass has *settled* for this photo — it either
   *  produced a score (`analysisStatus === 'done'`) or permanently gave up after
   *  exhausting its retries (`analysisStatus === 'failed'` — either the vision job's
   *  own retries, or the interim state `photo-meta` sets when IT gives up first, see
   *  `lib/photo-meta.ts`'s `markPhotoMetaFailed`). The builder's "X / Y analyzed"
   *  progress indicator counts these, so a genuinely unscoreable photo can't leave the
   *  poll spinning forever. */
  metaSettled: boolean;
  /** True when analysis permanently failed for this photo — the builder shows this
   *  distinctly from "still analyzing". */
  metaFailed: boolean;
}

/** Every photo of a photo book, in upload order, for the builder's grid. */
export async function listBookPhotos(
  bookId: string,
  userId: string,
): Promise<Result<{ photos: BookPhotoItem[] }>> {
  const [row] = await db
    .select({ chronicleId: books.chronicleId, kind: books.kind })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);
  if (!row) return err('Book not found.');
  if (row.kind !== 'photo') return err('This is not a photo book.');
  const m = await getMembership(row.chronicleId, userId);
  if (!m) return err('Book not found.');

  const rows = await db
    .select({
      assetId: assets.id,
      s3Key: assets.s3Key,
      thumbS3Key: assets.thumbS3Key,
      mimeType: assets.mimeType,
      width: assets.width,
      height: assets.height,
      position: bookPhotos.position,
      excluded: bookPhotos.excluded,
      excludedReason: bookPhotos.excludedReason,
      takenAt: bookPhotos.takenAt,
      analysisStatus: bookPhotos.analysisStatus,
    })
    .from(bookPhotos)
    .innerJoin(assets, eq(bookPhotos.assetId, assets.id))
    .where(eq(bookPhotos.bookId, bookId))
    .orderBy(asc(bookPhotos.position));

  return {
    ok: true,
    value: {
      photos: rows.map((r) => ({
        assetId: r.assetId,
        s3Key: r.s3Key,
        thumbS3Key: r.thumbS3Key,
        mimeType: r.mimeType,
        width: r.width,
        height: r.height,
        position: r.position,
        excluded: r.excluded,
        excludedReason: r.excludedReason,
        takenAt: r.takenAt,
        metaSettled: r.analysisStatus === 'done' || r.analysisStatus === 'failed',
        metaFailed: r.analysisStatus === 'failed',
      })),
    },
  };
}

/** Toggle one photo in/out of the layout (the builder's exclude/include control). */
export async function setPhotoExcluded(input: {
  bookId: string;
  assetId: string;
  excluded: boolean;
  userId: string;
}): Promise<Result> {
  const gate = await editablePhotoBook(input.bookId, input.userId);
  if (!gate.ok) return gate;

  const updated = await db
    .update(bookPhotos)
    .set({
      excluded: input.excluded,
      excludedReason: input.excluded ? 'user' : null,
      updatedAt: new Date(),
    })
    .where(and(eq(bookPhotos.bookId, input.bookId), eq(bookPhotos.assetId, input.assetId)))
    .returning({ id: bookPhotos.id });
  if (updated.length === 0) return err('Photo not found in this book.');

  // The available photo set changed — the stored plan (if any) may now reference an
  // excluded photo or be missing a re-included one; flag it stale so the next preview
  // load rebuilds it (docs/PHOTO_BOOK_PLAN.md PR2).
  await db.update(books).set({ layoutStale: true, updatedAt: new Date() }).where(eq(books.id, input.bookId));
  return { ok: true };
}

/**
 * The photo book's current style suite id — resolves/builds the plan if needed (same
 * "always have an answer" contract as `getBookLayoutSummary` for story books), so the
 * builder's style picker always has a value to highlight, and the live preview and the
 * picker never disagree about which suite is active.
 *
 * Cheap by default: the builder page (`app/(app)/books/[bookId]/page.tsx`) calls this
 * purely to seed the style picker, and its `<iframe>` immediately fires a second request
 * at `preview-html`, which resolves the SAME plan again (it needs the full content anyway
 * to render). A valid, non-stale stored plan answers this from the `books` row alone —
 * skipping `loadPhotoBook`'s full photo join and any rebuild — so the common case (every
 * request after the book's first) doesn't pay for that load twice. Only a book with no
 * usable plan yet takes the full build path, and it persists what it builds, so it's a
 * one-time cost.
 */
export async function getPhotoBookStyle(
  bookId: string,
  userId: string,
): Promise<Result<{ style: PhotoBookStyle }>> {
  const [row] = await db
    .select({ chronicleId: books.chronicleId, kind: books.kind, layoutPlan: books.layoutPlan, layoutStale: books.layoutStale })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);
  if (!row) return err('Book not found.');
  if (row.kind !== 'photo') return err('This is not a photo book.');
  const m = await getMembership(row.chronicleId, userId);
  if (!m) return err('Book not found.');

  if (row.layoutPlan && !row.layoutStale) {
    const validated = validatePhotoBookPlan(row.layoutPlan);
    if (validated.ok) return { ok: true, value: { style: validated.plan.style } };
    // Falls through to the full build below — same "rebuild on invalid stored plan"
    // behavior `loadOrBuildPhotoPlan` has, just reached via the cheap path's own check.
  }

  const loaded = await loadPhotoBook(bookId);
  const plan = await loadOrBuildPhotoPlan(bookId, loaded);
  return { ok: true, value: { style: plan.style } };
}

/**
 * Switch the photo book's style suite (the builder's swatch picker) — the photo-book
 * counterpart of the story `set_theme` layout op. Like `set_theme`, this never marks the
 * plan `edited` and never flips `layoutStale`: a style choice is a design preference that
 * survives regeneration, not structural content the auto-layouter would need to redo.
 */
export async function setPhotoBookStyle(input: {
  bookId: string;
  userId: string;
  style: PhotoBookStyle;
}): Promise<Result> {
  const gate = await editablePhotoBook(input.bookId, input.userId);
  if (!gate.ok) return gate;

  const loaded = await loadPhotoBook(input.bookId);
  const plan = await loadOrBuildPhotoPlan(input.bookId, loaded);
  const validated = validatePhotoBookPlan({ ...plan, style: input.style });
  if (!validated.ok) return err(`That change would leave the layout invalid: ${validated.error}`);

  await db
    .update(books)
    .set({ layoutPlan: validated.plan, layoutStale: false, updatedAt: new Date() })
    .where(eq(books.id, input.bookId));
  return { ok: true };
}

/**
 * Rebuild the photo book's plan from scratch with the deterministic auto-layouter — the
 * "Generate/Regenerate" button (docs/PHOTO_BOOK_PLAN.md PR2, builder wiring). Since PR4
 * (`updatePhotoBookLayout`) can leave `layoutSource: 'edited'`, this now guards like the
 * story book's `resetBookLayout`: an edited layout requires `overwriteEdits: true` to
 * confirm before it's silently discarded.
 */
export async function regeneratePhotoBookLayout(input: {
  bookId: string;
  userId: string;
  overwriteEdits?: boolean;
}): Promise<Result> {
  const gate = await editablePhotoBook(input.bookId, input.userId);
  if (!gate.ok) return gate;

  const [row] = await db
    .select({ layoutSource: books.layoutSource })
    .from(books)
    .where(eq(books.id, input.bookId))
    .limit(1);
  if (!row) return err('Book not found.');
  if (row.layoutSource === 'edited' && !input.overwriteEdits) {
    return err(
      "This book's layout has manual edits. Regenerating it would replace them — try again to confirm.",
    );
  }

  const loaded = await loadPhotoBook(input.bookId);
  await buildAndPersistPhotoAutoPlan(input.bookId, loaded);
  return { ok: true };
}

/**
 * Queue the photo-book AI design pass (docs/PHOTO_BOOK_PLAN.md §6, producer #2) — the
 * "Design my book" button, and the `redesign_photo_book` agent tool. Mirrors
 * `requestAiDesign` (the story-book counterpart): sets `design_requested_at` so the
 * builder's poll can show a working state, then enqueues `design-photo-book`, whose
 * worker handler (`handleDesignPhotoBook`, `worker/index.ts`) persists the AI's plan on
 * success or falls back to a freshly-built auto plan on failure — either way
 * `design_requested_at` is cleared when the job finishes.
 *
 * Manual-edit consent guard: since PR4 (`updatePhotoBookLayout`) can leave
 * `layoutSource: 'edited'`, a design pass over an edited layout requires
 * `overwriteEdits: true` to confirm, exactly like the story book's `requestAiDesign`.
 */
export async function requestPhotoBookAiDesign(input: {
  bookId: string;
  userId: string;
  overwriteEdits?: boolean;
}): Promise<Result> {
  const gate = await editablePhotoBook(input.bookId, input.userId);
  if (!gate.ok) return gate;

  const [row] = await db
    .select({ designRequestedAt: books.designRequestedAt, layoutSource: books.layoutSource })
    .from(books)
    .where(eq(books.id, input.bookId))
    .limit(1);
  if (!row) return err('Book not found.');
  if (row.designRequestedAt) return err('An AI design pass is already running for this book.');
  if (row.layoutSource === 'edited' && !input.overwriteEdits) {
    return err(
      "This book's layout has manual edits. Designing it again with AI would replace them — try again to confirm.",
    );
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(bookPhotos)
    .where(and(eq(bookPhotos.bookId, input.bookId), eq(bookPhotos.excluded, false)));
  if (!count) return err('Add at least one photo before designing.');

  await db.update(books).set({ designRequestedAt: new Date() }).where(eq(books.id, input.bookId));
  await enqueueDesignPhotoBook({ bookId: input.bookId });
  return { ok: true };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Photo-book chat/agent surface (docs/PHOTO_BOOK_PLAN.md PR4 / §9): a read
 * (`getPhotoBookSummary`, backing the `get_photo_book` agent tool) and a targeted-edit
 * entry point (`updatePhotoBookLayout`, backing `update_photo_book_layout`) — the "all
 * mutations in lib/books.ts, tools+UI are thin wrappers" rule holds for photo books too.
 * The pure per-op plan transforms live in `lib/photo-book-ops.ts` (kept free of db/env
 * imports so they're unit-testable without a database); this is the impure shell that
 * loads/persists plans and does the one op pair (`exclude_photo`/`include_photo`) that
 * needs a DB write interleaved with the plan edit.
 * ────────────────────────────────────────────────────────────────────────── */

/** One photo as the agent sees it: enough to reason about "which one is blurry / who's
 *  in it / does it deserve the cover" without a separate lookup. `analysis` is `null`
 *  until the `photo-vision` pass has scored this photo (or if scoring permanently
 *  failed) — the agent should treat those as "no opinion available", not "bad photo". */
export interface PhotoBookAgentPhoto {
  assetId: string;
  excluded: boolean;
  excludedReason: string | null;
  caption: string | null;
  analysis: PhotoAnalysis | null;
}

export interface PhotoBookAgentPage {
  pageIndex: number;
  template: PhotoPageTemplate;
  photos: PhotoBookAgentPhoto[];
}

export interface PhotoBookAgentSection {
  sectionIndex: number;
  title: string;
  dateLabel?: string;
  pages: PhotoBookAgentPage[];
}

export interface PhotoBookSummary {
  id: string;
  title: string;
  status: BookStatus;
  style: PhotoBookStyle;
  layoutSource: 'auto' | 'ai' | 'edited';
  cover: { heroAssetId: string | null; title: string; subtitle: string | null; backAssetIds: string[] };
  sections: PhotoBookAgentSection[];
  /** Photos excluded from the layout (auto-culled or user-excluded) — visible in the
   *  builder's tray; `include_photo` brings one back. */
  excludedPhotos: PhotoBookAgentPhoto[];
  /** Photos that ARE available but the current plan doesn't place anywhere yet — legal
   *  (no rule requires every available photo to be placed), and exactly what
   *  `move_photo`/`set_cover`/`swap_photos` can pull from. */
  unplacedPhotos: PhotoBookAgentPhoto[];
}

/**
 * The photo book's full current state for the chat agent (`get_photo_book`): every
 * section/page/photo the live plan places, plus each photo's vision-analysis summary —
 * this is what lets "die verschwommenen raus" ("blurry ones out") or "the one with Oma"
 * work, since the model can read `sharpness`/`shortDescription`/`sceneTags` per photo
 * instead of guessing from a bare id. Read-only: any chronicle member can call this
 * (membership gate only, like `listBookPhotos`), same as the story book's `get_book`.
 */
export async function getPhotoBookSummary(bookId: string, userId: string): Promise<Result<PhotoBookSummary>> {
  const [row] = await db
    .select({ chronicleId: books.chronicleId, kind: books.kind, title: books.title, status: books.status, layoutSource: books.layoutSource })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);
  if (!row) return err('Book not found.');
  if (row.kind !== 'photo') return err('This is not a photo book.');
  const m = await getMembership(row.chronicleId, userId);
  if (!m) return err('Book not found.');

  const loaded = await loadPhotoBook(bookId);
  const plan = await loadOrBuildPhotoPlan(bookId, loaded);
  const byId = new Map(loaded.photos.map((p) => [p.assetId, p]));

  function toAgentPhoto(assetId: string, caption: string | null): PhotoBookAgentPhoto {
    const p = byId.get(assetId);
    return {
      assetId,
      excluded: p?.excluded ?? true,
      excludedReason: p?.excludedReason ?? null,
      caption,
      analysis: p?.analysis ?? null,
    };
  }

  const sections: PhotoBookAgentSection[] = plan.sections.map((section, sectionIndex) => ({
    sectionIndex,
    title: section.title,
    dateLabel: section.dateLabel,
    pages: section.pages.map((page, pageIndex) => ({
      pageIndex,
      template: page.template,
      photos: page.assetIds.map((id, i) => toAgentPhoto(id, page.captions?.[i] ?? null)),
    })),
  }));

  const referenced = referencedPhotoAssetIds(plan);
  const excludedPhotos = loaded.photos.filter((p) => p.excluded).map((p) => toAgentPhoto(p.assetId, null));
  const unplacedPhotos = loaded.photos
    .filter((p) => !p.excluded && !referenced.has(p.assetId))
    .map((p) => toAgentPhoto(p.assetId, null));

  return {
    ok: true,
    value: {
      id: bookId,
      title: row.title,
      status: row.status as BookStatus,
      style: plan.style,
      layoutSource: row.layoutSource as 'auto' | 'ai' | 'edited',
      cover: {
        heroAssetId: plan.cover.heroAssetId ?? null,
        title: plan.cover.title,
        subtitle: plan.cover.subtitle ?? null,
        backAssetIds: plan.cover.backAssetIds ?? [],
      },
      sections,
      excludedPhotos,
      unplacedPhotos,
    },
  };
}

/**
 * Apply one or more targeted layout ops to a photo book's plan — the photo-book
 * counterpart of `updateBookLayout` above (see its doc comment for the shared shape:
 * build/load the plan, fold every op over it, validate once, persist once — an op that
 * would leave the plan invalid rejects the WHOLE batch, nothing written).
 *
 * Three differences from the story path:
 *  - `exclude_photo`/`include_photo` need a `book_photos.excluded` write alongside the
 *    plan edit. That write is intentionally NOT done eagerly per-op (unlike the
 *    builder's plain exclude/include toggle, `setPhotoExcluded`, which writes
 *    immediately and unconditionally marks the plan stale for a full rebuild on next
 *    load): this function is the "never persist an invalid plan" entry point, so every
 *    `book_photos.excluded` change from this batch is staged in memory and committed in
 *    the SAME transaction as the final plan write — if a later op in the batch (or the
 *    final consistency check) fails, NOTHING from this call is written, including the
 *    exclude/include flips. Excluding a currently-placed photo patches the plan in place
 *    (`removePhotoFromPlan` shrinks/re-templates its page rather than rebuilding the
 *    whole book) so a chat edit like "die verschwommenen raus" doesn't also discard
 *    unrelated manual edits (captions, section titles, style) the way a full
 *    regenerate/AI-design pass would. Including a photo needs no plan patch — an
 *    available-but-unplaced photo is a legal, consistent plan state (see
 *    `PhotoBookSummary.unplacedPhotos`); it simply becomes available for a follow-up
 *    `move_photo`/`set_cover`/`swap_photos`.
 *  - Every successful call sets `layout_source: 'edited'` unconditionally (including
 *    `set_style`, unlike the story book's `set_theme`/`setPhotoBookStyle`, which never
 *    mark the plan edited) — any chat edit, however small, is treated as a manual edit
 *    from here on, so a later `redesign_photo_book`/regenerate asks for confirmation
 *    before discarding it.
 *  - The read-modify-write below runs inside a transaction that locks the book row
 *    (`FOR UPDATE`) BEFORE reading the current plan, mirroring `addBookPhotos`'s lock
 *    above — the chat surface makes concurrent writers to `layout_plan` realistic (a
 *    chat op racing "Design my book"/regenerate, or two tabs), and without the lock the
 *    second writer could read the same pre-edit plan and silently clobber the first
 *    writer's change on save.
 */
export async function updatePhotoBookLayout(input: {
  bookId: string;
  userId: string;
  ops: PhotoLayoutOp[];
}): Promise<Result> {
  const gate = await editablePhotoBook(input.bookId, input.userId);
  if (!gate.ok) return gate;
  if (input.ops.length === 0) return { ok: true };

  // merge_sections shifts every later section index down by one — a model that doesn't
  // re-fetch get_photo_book in between would silently retarget any following
  // index-addressed op at the wrong (but still valid) section. Reject the whole batch
  // up front, before any read/write, rather than let it apply a wrong mutation.
  const mergeHazard = findMergeSectionsIndexHazard(input.ops);
  if (mergeHazard) return err(mergeHazard);

  // The whole read-modify-write below runs in one transaction, locked on the book row
  // first (`FOR UPDATE`, mirroring `addBookPhotos`'s same-purpose lock above): PR4's chat
  // surface makes concurrent writers to `books.layout_plan` realistic (a chat op racing
  // "Design my book"/"Regenerate", or two tabs open on the same book), and without a lock
  // a classic lost update is possible — both read the same pre-edit plan, both validate
  // fine independently, and whichever writes last silently discards the other's edit. A
  // second call's `FOR UPDATE` blocks here until the first call's transaction commits (or
  // rolls back), and its subsequent plan read — a fresh query, not reused from before the
  // lock — then sees that committed change instead of clobbering it.
  return db.transaction(async (tx) => {
    await tx.select({ id: books.id }).from(books).where(eq(books.id, input.bookId)).for('update');

    const loaded = await loadPhotoBook(input.bookId);
    let plan: PhotoBookPlan = await loadOrBuildPhotoPlan(input.bookId, loaded);

    const allIds = new Set(loaded.photos.map((p) => p.assetId));
    const availableIds = new Set(loaded.photos.filter((p) => !p.excluded).map((p) => p.assetId));
    const exclusionChanges = new Map<string, boolean>();
    let coverAssetId: string | undefined;

    for (const op of input.ops) {
      if (op.op === 'exclude_photo' || op.op === 'include_photo') {
        if (!allIds.has(op.assetId)) return err('That photo is not in this book.');
        const excluded = op.op === 'exclude_photo';
        exclusionChanges.set(op.assetId, excluded);
        if (excluded) {
          availableIds.delete(op.assetId);
          plan = removePhotoFromPlan(plan, op.assetId);
        } else {
          availableIds.add(op.assetId);
        }
        continue;
      }
      const result = applyPhotoLayoutOp(plan, op, { availableAssetIds: availableIds });
      if ('error' in result) return err(result.error);
      plan = result.plan;
      if (result.coverAssetId !== undefined) coverAssetId = result.coverAssetId;
    }

    const validated = validatePhotoBookPlan(plan);
    if (!validated.ok) return err(`That change would leave the layout invalid: ${validated.error}`);

    const content: PhotoPlanContent = {
      availableAssetIds: [...availableIds],
      allAssetIds: [...allIds],
    };
    const problems = checkPhotoBookPlanConsistency(validated.plan, content);
    if (problems.length > 0) {
      return err(`That change would leave the layout invalid: ${problems.join('; ')}`);
    }

    for (const [assetId, excluded] of exclusionChanges) {
      await tx
        .update(bookPhotos)
        .set({ excluded, excludedReason: excluded ? 'user' : null, updatedAt: new Date() })
        .where(and(eq(bookPhotos.bookId, input.bookId), eq(bookPhotos.assetId, assetId)));
    }
    const set: Partial<typeof books.$inferInsert> = {
      layoutPlan: validated.plan,
      layoutSource: 'edited',
      layoutStale: false,
      updatedAt: new Date(),
    };
    if (coverAssetId !== undefined) set.coverAssetId = coverAssetId;
    await tx.update(books).set(set).where(eq(books.id, input.bookId));

    return { ok: true };
  });
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
 * Guard for mutations that operate on the FULL layout plan (targeted ops, AI
 * design, reset): a viewer with hidden chapters would restyle — or rebuild —
 * chapters they can't read. Owners see everything, so this never blocks them.
 */
function hiddenChaptersError(book: BookDetail): Result | null {
  if (book.hiddenChapterCount === 0) return null;
  return err(
    "Some of this book's chapters are stories you don't have access to — only someone who can read every story can change the book's layout.",
  );
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

  // Photo books (docs/PHOTO_BOOK_PLAN.md PR5): a separate branch, not a rewrite of the
  // story checks below — a photo book has no `chapters`/`hiddenChapterCount` (book_stories
  // stays empty for it) and, unlike a story book, is never opened by a viewer with partial
  // access (§2: "every chronicle member with access to the book sees them"), so neither of
  // the story-only checks below applies.
  if (gate.book.kind === 'photo') {
    // Already fresh — nothing to (re-)render. Lets the "Download PDF" flow call this
    // unconditionally before serving the PDF without forcing a wasteful Chromium re-run
    // on a book whose print PDF already matches its current content.
    if (gate.book.status === 'preview_ready' && !gate.book.layoutStale) return { ok: true };
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(bookPhotos)
      .where(and(eq(bookPhotos.bookId, input.bookId), eq(bookPhotos.excluded, false)));
    if (!count) return err('Add at least one photo before rendering.');
    if (gate.book.status === 'rendering') return err('A preview is already being rendered.');

    await db
      .update(books)
      .set({ status: 'rendering', errorMessage: null, updatedAt: new Date() })
      .where(eq(books.id, input.bookId));
    await enqueueRenderBook({ bookId: input.bookId });
    return { ok: true };
  }

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
  const hidden = hiddenChaptersError(gate.book);
  if (hidden) return hidden;
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
  const hidden = hiddenChaptersError(gate.book);
  if (hidden) return hidden;
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
  const hidden = hiddenChaptersError(gate.book);
  if (hidden) return hidden;
  // Photo books have no layout plan yet (docs/PHOTO_BOOK_PLAN.md PR 2+) — `loadBook`
  // below assumes a story book (>= 1 chapter) and throws otherwise.
  if (gate.book.kind !== 'story') return err('This book has no layout plan yet.');
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
  // Photo books have no layout plan yet (docs/PHOTO_BOOK_PLAN.md PR 2+) — `loadBook`
  // below assumes a story book (>= 1 chapter) and throws otherwise.
  if (book.kind !== 'story') return err('This book has no layout plan yet.');
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

  // The hero photo may belong to a hidden chapter — don't hand its asset id
  // to a viewer who can't see that chapter (it would let targeted layout ops
  // address it, and ids should not leak across the access boundary at all).
  const heroAssetId = plan.cover.heroAssetId ?? null;
  const heroStoryId = heroAssetId ? loaded.allPhotosById.get(heroAssetId)?.storyId : null;
  const heroHidden =
    book.hiddenChapterCount > 0 && heroStoryId != null && !visibleStories.has(heroStoryId);

  return {
    ok: true,
    value: {
      theme: plan.theme,
      coverStyle: plan.cover.style,
      coverHeroAssetId: heroHidden ? null : heroAssetId,
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
  // Quoting is part of the order flow, which needs the all-chapters print PDF. Photo
  // books have no hidden-chapter concept (§2: every chronicle member with book access
  // sees every photo), so this never blocks them — `hiddenChapterCount` is always 0.
  if (book.hiddenChapterCount > 0) {
    return err(
      "Some of this book's chapters are stories you don't have access to — the printed book contains every chapter, so only someone who can read all of them can price or order it.",
    );
  }
  const pageCount = book.pageCount ?? (await estimatePageCount(book));
  const quote = await quoteBookPrice({ format: book.format, pageCount });
  return { ok: true, value: { quote } };
}

/**
 * Rough page estimate before a render exists. Story books: ~2.5 pages of prose per story
 * plus a page per two photos, front matter, and chapter starts on right-hand pages — pure
 * arithmetic over `book.chapters`, already loaded. Photo books: no `chapters` to estimate
 * from (`book_stories` stays empty for them), so this loads/resolves the book's actual
 * layout plan (`loadOrBuildPhotoPlan` — builds one if there isn't a usable one yet, same
 * as the live preview) and counts its real pages (`countPhotoBookPages`,
 * `lib/photo-book-content.ts`) — a photo book's page count is far more layout-dependent
 * than a story book's (page templates hold 1-5 photos each), so a flat per-photo formula
 * would be a much rougher guess than just resolving the plan, which the preview route
 * does on every request anyway.
 */
export async function estimatePageCount(book: Pick<BookDetail, 'id' | 'kind' | 'chapters'>): Promise<number> {
  if (book.kind === 'photo') {
    const loaded = await loadPhotoBook(book.id);
    const plan = await loadOrBuildPhotoPlan(book.id, loaded);
    return countPhotoBookPages(plan);
  }
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
