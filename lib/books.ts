import { and, asc, desc, eq, inArray, isNotNull, lt, notInArray, sql } from 'drizzle-orm';
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
  enqueueDesignPhotoBook,
  enqueuePhotoMeta,
  enqueueRenderBook,
  enqueueThumbnail,
} from '@/lib/queue';
import { enqueuePendingPhotoVisionBatches } from '@/lib/photo-vision';
import { quoteBookPrice, type BookCoverType, type BookFormat, type BookQuote } from '@/lib/gelato';
import {
  buildAndPersistPhotoAutoPlan,
  countPhotoBookPages,
  loadOrBuildPhotoPlan,
  loadPhotoBook,
  referencedPhotoAssetIds,
} from '@/lib/photo-book-content';
import {
  checkPhotoBookPlanConsistency,
  isTextItem,
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
  sweepBlankPages,
  type PhotoLayoutOp,
} from '@/lib/photo-book-ops';
import type { PhotoAnalysis } from '@/lib/photo-analysis';
import { isDesignInFlight } from '@/lib/photo-book-design-stage';
import { parsePhotoGrouping, type PhotoBookGrouping } from '@/lib/photo-book-grouping';

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
  /** Whether this chapter's TEXT is part of the book (unified-book plan). */
  includeText: boolean;
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
  /** Hardcover vs softcover binding (`books.cover_type`) — see its own comment in
   *  db/schema.ts. Always 'hardcover' for story books (no config UI for it yet). */
  coverType: BookCoverType;
  status: BookStatus;
  errorMessage: string | null;
  pageCount: number | null;
  previewS3Key: string | null;
  printS3Key: string | null;
  /** Who last wrote the layout plan: the heuristic auto-layouter, an AI design pass, or a
   *  manual edit (manual edits are phase 4; the type already allows for them). */
  layoutSource: 'auto' | 'ai' | 'edited';
  /** The stored layout plan, untyped. Callers that need its contents validate it
   *  themselves (`validatePhotoBookPlan`). */
  layoutPlan: unknown;
  /** True when the book's content changed since `layoutPlan` was built (a photo was
   *  added/excluded, a chat op touched the plan) — the render/download flow uses this to
   *  decide whether a stored `preview_ready` PDF still matches the book's current content
   *  or must be re-rendered first (docs/PHOTO_BOOK_PLAN.md PR5, "Download PDF"). */
  layoutStale: boolean;
  /** Set while an AI design job is queued/running; null once it completes (success or
   *  fallback). Drives the builder's "Design my book" working state. */
  designRequestedAt: Date | null;
  /** How the user asked this photo book to be organised (`books.photo_grouping`) — see
   *  `lib/photo-book-grouping.ts`. Always chronological for story books. */
  photoGrouping: PhotoBookGrouping;
  /** How far the in-flight photo-book design pass has got (`books.design_stage`) — see
   *  `lib/photo-book-design-stage.ts`. Null when nothing is running (or for story books). */
  designStage: string | null;
  /** Set once a photo-book design job has completed at least once (success or
   *  auto-fallback) — the builder Step 2 gate for "has this book ever been generated".
   *  Always null for story books. See db/schema.ts's `books.generatedAt` comment. */
  generatedAt: Date | null;
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
      includeText: bookStories.includeText,
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
    coverType: row.book.coverType as BookCoverType,
    status: row.book.status as BookStatus,
    errorMessage: row.book.errorMessage,
    pageCount: row.book.pageCount,
    previewS3Key: row.book.previewS3Key,
    printS3Key: row.book.printS3Key,
    layoutSource: row.book.layoutSource as 'auto' | 'ai' | 'edited',
    layoutPlan: row.book.layoutPlan,
    layoutStale: row.book.layoutStale,
    designRequestedAt: row.book.designRequestedAt,
    designStage: row.book.designStage,
    photoGrouping: parsePhotoGrouping(row.book.photoGrouping),
    generatedAt: row.book.generatedAt,
    updatedAt: row.book.updatedAt,
    chapters: visibleChapters.map((c, i) => ({
      storyId: c.storyId,
      position: c.position ?? i,
      includePhotos: c.includePhotos,
      includeText: c.includeText,
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

  let freshMirrors: Array<{ assetId: string; s3Key: string }> = [];
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
    freshMirrors = await syncStoryPhotoMirrors(
      tx,
      created.id,
      storyIds.map((storyId, position) => ({ storyId, position, includePhotos: true })),
    );
    return created.id;
  });
  await enqueueMirrorAnalysis(freshMirrors);
  return { ok: true, value: { bookId } };
}

/** The slice of a drizzle transaction the mirror sync needs — also satisfied by `db`
 *  itself, so callers outside a transaction can pass that. */
type DbLike = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>;

/**
 * Keeps `book_photos` mirror rows (unified-book plan, PR A) in sync with a book's
 * attached stories: every photo asset of an attached story gets one `book_photos` row
 * with `story_id` provenance, so story-sourced photos flow through the same
 * analysis + layout pipeline as uploads; detaching a story removes its mirrors.
 *
 * Semantics:
 * - Insert is idempotent (`ON CONFLICT (book_id, asset_id) DO NOTHING` via the
 *   `book_photos_book_asset_uq` index) — a retried call never double-adds.
 * - New mirror rows copy `takenAt`/GPS/`phash`/`blurScore`/`analysis`/`analysisStatus`
 *   from any already-settled `book_photos` row for the same asset (the same story in
 *   another book, or a re-attach) — the metadata is asset-intrinsic, so the analysis
 *   pipeline never pays for the same photo twice. Rows with no donor stay `pending`;
 *   `ensureBookPhotoAnalysis` enqueues their jobs lazily when a builder needs them.
 * - A story attached with `includePhotos: false` mirrors as `excluded = true` with
 *   reason `'story-setting'`; flipping the toggle updates existing mirrors, always
 *   respecting an explicit per-photo `userDecision` (the user's own include/exclude
 *   choice outranks the story-level toggle in both directions).
 * - Positions append after whatever the book already holds, ordered by
 *   (chapter position, asset creation) — deliberately NOT capped by
 *   `MAX_PHOTOS_PER_BOOK`: attaching a story was never photo-capped, and silently
 *   dropping some of a chapter's photos would be worse than a large tray.
 */
async function syncStoryPhotoMirrors(
  tx: DbLike,
  bookId: string,
  storyRows: Array<{ storyId: string; position: number; includePhotos: boolean }>,
): Promise<Array<{ assetId: string; s3Key: string }>> {
  const attachedIds = storyRows.map((s) => s.storyId);
  const needsAnalysis: Array<{ assetId: string; s3Key: string }> = [];

  // Mirrors of stories that are no longer attached leave with their story.
  await tx
    .delete(bookPhotos)
    .where(
      and(
        eq(bookPhotos.bookId, bookId),
        isNotNull(bookPhotos.storyId),
        ...(attachedIds.length > 0 ? [notInArray(bookPhotos.storyId, attachedIds)] : []),
      ),
    );
  if (attachedIds.length === 0) return [];

  const storyPhotos = await tx
    .select({ id: assets.id, s3Key: assets.s3Key, storyId: assets.storyId, createdAt: assets.createdAt })
    .from(assets)
    .where(and(inArray(assets.storyId, attachedIds), eq(assets.kind, 'photo')));

  const existing = await tx
    .select({
      assetId: bookPhotos.assetId,
      storyId: bookPhotos.storyId,
      excluded: bookPhotos.excluded,
      position: bookPhotos.position,
    })
    .from(bookPhotos)
    .where(eq(bookPhotos.bookId, bookId));
  const existingIds = new Set(existing.map((e) => e.assetId));

  const byStory = new Map(storyRows.map((s) => [s.storyId, s]));
  const fresh = storyPhotos
    .filter((p) => !existingIds.has(p.id))
    .sort((a, b) => {
      const pa = byStory.get(a.storyId!)?.position ?? 0;
      const pb = byStory.get(b.storyId!)?.position ?? 0;
      return pa - pb || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
    });

  if (fresh.length > 0) {
    // Analysis reuse: one settled donor row per asset, from any book. `updatedAt`
    // ordering makes the pick deterministic-enough; any settled row's values are
    // asset-intrinsic and interchangeable.
    // Only 'done' donors: copying a 'failed' status would make a transient failure in
    // one book permanent in every book the photo is later mirrored into (nothing ever
    // re-enqueues a 'failed' row). A failed-elsewhere photo starts 'pending' here
    // instead, so `ensureBookPhotoAnalysis` gives it a fresh attempt.
    const donors = await tx
      .select()
      .from(bookPhotos)
      .where(
        and(
          inArray(bookPhotos.assetId, fresh.map((p) => p.id)),
          eq(bookPhotos.analysisStatus, 'done'),
        ),
      )
      .orderBy(desc(bookPhotos.updatedAt));
    const donorByAsset = new Map<string, (typeof donors)[number]>();
    for (const d of donors) if (!donorByAsset.has(d.assetId)) donorByAsset.set(d.assetId, d);

    // max(position) + 1, not a row COUNT: detaching a story deletes its mirrors and
    // leaves gaps, so a count would hand out positions that collide with rows already
    // there. Position is ordering-only (no unique constraint), but colliding values make
    // the tray and the layouter's fallback sort nondeterministic.
    const startPosition = existing.reduce((max, row) => Math.max(max, row.position + 1), 0);
    await tx
      .insert(bookPhotos)
      .values(
        fresh.map((p, i) => {
          const story = byStory.get(p.storyId!)!;
          const donor = donorByAsset.get(p.id);
          return {
            bookId,
            assetId: p.id,
            storyId: p.storyId,
            position: startPosition + i,
            excluded: !story.includePhotos,
            excludedReason: story.includePhotos ? null : 'story-setting',
            takenAt: donor?.takenAt ?? null,
            gpsLat: donor?.gpsLat ?? null,
            gpsLng: donor?.gpsLng ?? null,
            phash: donor?.phash ?? null,
            blurScore: donor?.blurScore ?? null,
            analysis: donor?.analysis ?? null,
            analysisStatus: donor?.analysisStatus ?? ('pending' as const),
          };
        }),
      )
      .onConflictDoNothing();
    // Rows that got a settled donor are already analyzed; the rest need the pipeline.
    // Reported to the caller so it can enqueue AFTER the transaction commits — the
    // lazy healer's age cutoff deliberately ignores brand-new rows, so without this a
    // freshly attached story's photos would sit unanalyzed for ten minutes.
    needsAnalysis.push(
      ...fresh.filter((p) => !donorByAsset.has(p.id)).map((p) => ({ assetId: p.id, s3Key: p.s3Key })),
    );
  }

  // Reconcile the story-level photo toggle on rows that already existed. The user's own
  // per-photo decision always wins: a force-included photo never gets story-excluded,
  // and re-enabling a story's photos never resurrects a force-excluded one.
  for (const story of storyRows) {
    if (story.includePhotos) {
      await tx
        .update(bookPhotos)
        .set({ excluded: false, excludedReason: null, updatedAt: new Date() })
        .where(
          and(
            eq(bookPhotos.bookId, bookId),
            eq(bookPhotos.storyId, story.storyId),
            eq(bookPhotos.excludedReason, 'story-setting'),
            sql`${bookPhotos.userDecision} IS DISTINCT FROM 'exclude'`,
          ),
        );
    } else {
      await tx
        .update(bookPhotos)
        .set({ excluded: true, excludedReason: 'story-setting', updatedAt: new Date() })
        .where(
          and(
            eq(bookPhotos.bookId, bookId),
            eq(bookPhotos.storyId, story.storyId),
            eq(bookPhotos.excluded, false),
            sql`${bookPhotos.userDecision} IS DISTINCT FROM 'include'`,
          ),
        );
    }
  }

  return needsAnalysis;
}

/** Enqueues the analysis pipeline for freshly inserted mirror rows — called by every
 *  caller of `syncStoryPhotoMirrors` AFTER its transaction commits, so a job can never
 *  race ahead of the rows it is about to read. */
async function enqueueMirrorAnalysis(fresh: Array<{ assetId: string; s3Key: string }>): Promise<void> {
  if (fresh.length === 0) return;
  for (const row of fresh) {
    await enqueueThumbnail({ s3Key: row.s3Key });
    await enqueuePhotoMeta({ assetId: row.assetId });
  }
  await enqueuePendingPhotoVisionBatches(fresh.map((f) => f.assetId));
}

/**
 * Mirrors a story's photos into every book that story is already attached to — the
 * "photos added AFTER the story was attached" path. Without it the mirror set would be
 * frozen at attach time: a photo contributed to a story later would never reach
 * `book_photos`, so it would get no display rendition, no analysis, and (once the
 * unified loader lands) would silently vanish from the book its story is in.
 *
 * Called by the story-photo write paths in `lib/stories.ts`. Idempotent: the insert
 * skips assets already mirrored.
 */
export async function mirrorStoryPhotosIntoBooks(storyId: string): Promise<void> {
  const targets = await db
    .select({ bookId: bookStories.bookId })
    .from(bookStories)
    .where(eq(bookStories.storyId, storyId));

  for (const { bookId } of targets) {
    const rows = await db
      .select({
        storyId: bookStories.storyId,
        position: bookStories.position,
        includePhotos: bookStories.includePhotos,
      })
      .from(bookStories)
      .where(eq(bookStories.bookId, bookId));
    const fresh = await db.transaction((tx) => syncStoryPhotoMirrors(tx, bookId, rows));
    await enqueueMirrorAnalysis(fresh);
    if (fresh.length > 0) {
      // New photos can change sectioning/pacing/cover pick — same staleness flag
      // `addBookPhotos` sets for an upload.
      await db.update(books).set({ layoutStale: true, updatedAt: new Date() }).where(eq(books.id, bookId));
    }
  }
}

/** How long an unsettled photo must have sat untouched before `ensureBookPhotoAnalysis`
 *  re-enqueues its jobs — long enough that a normally-progressing pipeline (upload →
 *  photo-meta → photo-vision, each bumping `updatedAt`) is never double-enqueued, short
 *  enough that a book whose jobs were lost (worker restart, backfilled mirror rows from
 *  the PR A migration) heals within one builder visit. */
const ANALYSIS_HEAL_MIN_AGE_MS = 10 * 60 * 1000;

/**
 * Lazily heals a book whose photos never got (or lost) their analysis jobs: enqueues
 * `thumbnail` + `photo-meta` + vision batches for every UNSETTLED row (`pending`, or
 * `analyzing` left stranded by a worker that died mid-job — nothing else ever clears
 * that state) older than `ANALYSIS_HEAL_MIN_AGE_MS`. Needed because the PR A migration
 * backfills mirror rows for existing story books but cannot enqueue pg-boss jobs itself
 * — the first builder visit does it instead. Also catches uploads whose enqueue was lost
 * to a crash.
 *
 * The claim is one atomic `UPDATE ... RETURNING`: two concurrent page loads would
 * otherwise both read the same stale rows before either bumped `updatedAt`, and each
 * would enqueue its own vision batch — duplicate model spend for the same photos. With
 * the bump inside the statement, exactly one caller sees each row.
 */
export async function ensureBookPhotoAnalysis(bookId: string): Promise<void> {
  const cutoff = new Date(Date.now() - ANALYSIS_HEAL_MIN_AGE_MS);
  const claimed = await db
    .update(bookPhotos)
    .set({ updatedAt: new Date() })
    .where(
      and(
        eq(bookPhotos.bookId, bookId),
        inArray(bookPhotos.analysisStatus, ['pending', 'analyzing']),
        lt(bookPhotos.updatedAt, cutoff),
      ),
    )
    .returning({ assetId: bookPhotos.assetId });
  if (claimed.length === 0) return;

  const assetIds = claimed.map((c) => c.assetId);
  const keys = await db
    .select({ id: assets.id, s3Key: assets.s3Key })
    .from(assets)
    .where(inArray(assets.id, assetIds));

  for (const row of keys) {
    await enqueueThumbnail({ s3Key: row.s3Key });
    await enqueuePhotoMeta({ assetId: row.id });
  }
  await enqueuePendingPhotoVisionBatches(assetIds);
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
 *  by the batch presign action, which needs the same check before signing PUT URLs.
 *  Hands back the book's current `status` too, so mutations that need to know whether
 *  to invalidate an existing print PDF (`invalidatePhotoBookPrint` below) don't have to
 *  re-query for it. */
export async function editablePhotoBook(
  bookId: string,
  userId: string,
): Promise<{ ok: true; chronicleId: string; status: BookStatus } | { ok: false; error: string }> {
  const [row] = await db
    .select({ chronicleId: books.chronicleId, layoutPlan: books.layoutPlan, status: books.status })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);
  if (!row) return err('Book not found.');
  const gate = await ensureBookAccess(row.chronicleId, userId);
  if (!gate.ok) return gate;
  if (row.status === 'ordered') {
    return err('This book has been ordered and is locked. Create a new book to make changes.');
  }
  return { ok: true, chronicleId: row.chronicleId, status: row.status as BookStatus };
}

/**
 * Root-cause fix for "the order screen can serve a stale print PDF for photo books"
 * (docs/PHOTO_BOOK_PLAN.md PR5 review): a photo book's print PDF
 * (`previewS3Key`/`printS3Key`) is a Chromium render of a PLAN snapshot, so once
 * content or the plan itself changes, any `preview_ready` PDF may no longer match —
 * exactly the situation the story book's `invalidatePreview()` already handles by
 * downgrading `status` back to `draft`. This is the photo-book counterpart, called by
 * every mutation that can make an existing print PDF stale (`addBookPhotos`,
 * `setPhotoExcluded`, `updatePhotoBookLayout`): every reader of `books.status` — the
 * order screen, the builder's Download/Order gates, `requestPreview`'s "already fresh,
 * no-op" check — then treats the book as needing a fresh render again, with no extra
 * staleness check required at the READ side.
 *
 * Deliberately narrower than `invalidatePreview()`: it only downgrades `preview_ready`,
 * leaving `rendering`/`render_failed`/`draft` untouched. `rendering` in particular must
 * survive a concurrent mutation unclobbered — flipping it to `draft` here would let a
 * second `requestPreview` call race past its "a preview is already being rendered"
 * guard and enqueue a duplicate render job. (That race window — a mutation landing
 * mid-render — instead leaves `status: 'preview_ready'` with `layoutStale: true` once
 * the in-flight render completes; `lib/book-print-status.ts`'s `isBookPrintFresh` is
 * the read-side check that still catches that case.)
 *
 * Independent of `layoutStale`, which the caller manages separately and may leave
 * `false` (e.g. `updatePhotoBookLayout` — the plan it just persisted already reflects
 * the edit, so no rebuild is needed) even while this downgrades `status`: "does the
 * stored PLAN need rebuilding from the photo set" and "does the stored PRINT PDF need
 * re-rendering from the plan" are different questions.
 */
function invalidatePhotoBookPrint(currentStatus: BookStatus): Partial<typeof books.$inferInsert> {
  return currentStatus === 'preview_ready' ? { status: 'draft' as const } : {};
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
    // `layoutStale` when `layoutPlan` is already set). Also downgrades a `preview_ready`
    // book back to `draft` (`invalidatePhotoBookPrint`) — an existing print PDF was
    // rendered before these photos existed, so it can no longer be trusted (PR5 review:
    // "order screen can serve a stale print PDF for photo books").
    await db
      .update(books)
      .set({ layoutStale: true, updatedAt: new Date(), ...invalidatePhotoBookPrint(gate.status) })
      .where(eq(books.id, input.bookId));
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
  /** True when this photo carries EXIF GPS coordinates. Only the "organise by place"
   *  grouping needs it (`lib/photo-book-grouping.ts`), and it needs it badly enough that
   *  the builder warns before letting a user pick that mode for a set of photos that
   *  mostly has no location at all — phone screenshots, scans, and anything stripped by a
   *  messaging app arrive without it. */
  hasLocation: boolean;
  /** True once this photo has a vision score, which is what the "organise by topic"
   *  grouping clusters on. */
  hasAnalysis: boolean;
}

/** Every photo of a photo book, in upload order, for the builder's grid. */
export async function listBookPhotos(
  bookId: string,
  userId: string,
): Promise<Result<{ photos: BookPhotoItem[] }>> {
  const [row] = await db
    .select({ chronicleId: books.chronicleId, layoutPlan: books.layoutPlan })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);
  if (!row) return err('Book not found.');
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
      gpsLat: bookPhotos.gpsLat,
      analysis: bookPhotos.analysis,
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
        hasLocation: r.gpsLat != null,
        hasAnalysis: r.analysis != null,
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
      // Root-cause fix for "excluding then re-including a photo doesn't stick": this is
      // the USER's own explicit decision, recorded independently of `excluded` itself, so
      // the next auto-layout rebuild (`buildAndPersistPhotoAutoPlan`) knows a re-included
      // duplicate/blurry photo must survive culling rather than being silently excluded
      // again (see `lib/photo-book-autolayout.ts`'s module header).
      userDecision: input.excluded ? 'exclude' : 'include',
      updatedAt: new Date(),
    })
    .where(and(eq(bookPhotos.bookId, input.bookId), eq(bookPhotos.assetId, input.assetId)))
    .returning({ id: bookPhotos.id });
  if (updated.length === 0) return err('Photo not found in this book.');

  // The available photo set changed — the stored plan (if any) may now reference an
  // excluded photo or be missing a re-included one; flag it stale so the next preview
  // load rebuilds it (docs/PHOTO_BOOK_PLAN.md PR2). Also downgrades a `preview_ready`
  // book back to `draft` (`invalidatePhotoBookPrint`) — see `addBookPhotos` above.
  await db
    .update(books)
    .set({ layoutStale: true, updatedAt: new Date(), ...invalidatePhotoBookPrint(gate.status) })
    .where(eq(books.id, input.bookId));
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
    .select({ chronicleId: books.chronicleId, layoutPlan: books.layoutPlan, layoutStale: books.layoutStale })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);
  if (!row) return err('Book not found.');
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
 * The builder Step 2 config panel's title/subtitle/size/cover-type settings — a scoped
 * counterpart of the story book's `updateBook` for photo books, kept separate rather than
 * folded into it: `updateBook` is gated by `editableBook` (loads the full per-viewer
 * chapter list, hidden-chapter checks, a `coverAssetId`-belongs-to-an-included-story
 * validation) — none of which applies to photo books, which have no chapters at all — and
 * unconditionally flips `layoutStale`/`status` back to draft on every call
 * (`invalidatePreview()`), which for a photo book would force the NEXT plan build back
 * through the deterministic auto-layouter, silently discarding an AI-designed
 * (`layoutSource: 'ai'`) or hand-edited (`'edited'`) plan's sections/pacing just from a
 * title tweak.
 *
 * Instead: `format`/`coverType` are pure preferences (quote input only, don't touch the
 * plan) so they're just persisted. `title`/`subtitle` ARE part of the rendered cover, so
 * when a plan already exists this also patches its `cover.title`/`cover.subtitle` in
 * place — same "patch the stored plan directly" approach `setPhotoBookStyle` above uses
 * for `style` — so the change is visible immediately without a full rebuild, and without
 * downgrading `layoutSource`. A later full (re)build (`buildAndPersistPhotoAutoPlan` /
 * the AI pass's `applyPhotoPlanCarryOver`) reads `books.title`/`books.subtitle` fresh
 * regardless, so the two stay in agreement either way.
 */
export async function updatePhotoBookSettings(input: {
  bookId: string;
  userId: string;
  title?: string;
  subtitle?: string | null;
  /** Printed on the title page — only meaningful for a book with chapters, which is
   *  why the unified builder shows the field only then (PR D). */
  dedication?: string | null;
  format?: BookFormat;
  coverType?: BookCoverType;
  photoGrouping?: PhotoBookGrouping;
}): Promise<Result<UpdatePhotoBookSettingsOutcome>> {
  const gate = await editablePhotoBook(input.bookId, input.userId);
  if (!gate.ok) return gate;

  const [row] = await db
    .select({
      title: books.title,
      subtitle: books.subtitle,
      layoutPlan: books.layoutPlan,
      photoGrouping: books.photoGrouping,
      layoutSource: books.layoutSource,
      generatedAt: books.generatedAt,
      designRequestedAt: books.designRequestedAt,
    })
    .from(books)
    .where(eq(books.id, input.bookId))
    .limit(1);
  if (!row) return err('Book not found.');

  const nextTitle = input.title !== undefined ? input.title.trim() || row.title : row.title;
  const nextSubtitle = input.subtitle !== undefined ? input.subtitle?.trim() || null : row.subtitle;

  const set: Partial<typeof books.$inferInsert> = {
    updatedAt: new Date(),
    // A title/subtitle/format/cover-type change can make an existing print PDF stale
    // (the cover text or the Gelato quote it feeds no longer matches) — downgrade
    // `preview_ready` back to `draft` like every other photo-book mutation does, WITHOUT
    // touching `layoutStale` (see the doc comment above for why the plan itself is
    // patched in place instead of invalidated).
    ...invalidatePhotoBookPrint(gate.status),
  };
  if (input.title !== undefined) set.title = nextTitle;
  if (input.subtitle !== undefined) set.subtitle = nextSubtitle;
  if (input.dedication !== undefined) set.dedication = input.dedication?.trim() || null;
  if (input.format !== undefined) set.format = input.format;
  if (input.coverType !== undefined) set.coverType = input.coverType;
  // Deliberately does NOT flip `layoutStale`: that would make the next page load rebuild
  // the book behind the user's back (and for an AI-designed book only REPAIR it, which
  // never re-sections). Re-sectioning needs a real design pass, queued below.
  const groupingChanged =
    input.photoGrouping !== undefined && input.photoGrouping !== parsePhotoGrouping(row.photoGrouping);
  if (input.photoGrouping !== undefined) set.photoGrouping = input.photoGrouping;

  const coverTextChanged =
    (input.title !== undefined && nextTitle !== row.title) ||
    (input.subtitle !== undefined && nextSubtitle !== row.subtitle);
  if (coverTextChanged && row.layoutPlan) {
    const validated = validatePhotoBookPlan(row.layoutPlan);
    if (validated.ok) {
      // Reuse the chat agent's own `set_cover_title` op (`lib/photo-book-ops.ts`) rather
      // than re-deriving "how to patch a plan's cover text" here — same pure, tested
      // transform either way. It never reads `ctx` for this op, so an empty one is fine.
      const result = applyPhotoLayoutOp(
        validated.plan,
        { op: 'set_cover_title', title: nextTitle, subtitle: nextSubtitle },
        { availableAssetIds: new Set() },
      );
      if ('plan' in result) {
        const revalidated = validatePhotoBookPlan(result.plan);
        // Cover text alone can never make a previously-consistent plan inconsistent (it
        // doesn't touch heroAssetId/sections/assetIds — the invariant
        // `checkPhotoBookPlanConsistency` and the cover-hero guard protect), so
        // `revalidated.ok` should always hold; the check is defense in depth, same spirit
        // as `setPhotoBookStyle`'s own validation.
        if (revalidated.ok) set.layoutPlan = revalidated.plan;
      }
    }
  }

  await db.update(books).set(set).where(eq(books.id, input.bookId));

  // Changing how the book is ORGANISED changes what a section is, which no in-place patch
  // can express — the book has to be designed again. That rule lives here, with the
  // mutation, rather than in the builder: `lib/books.ts` is the one place book state
  // changes (AGENTS.md), so every caller — the config panel, the chat agent, anything
  // later — gets the same behaviour instead of the UI having to remember to re-trigger it.
  // A book that has never been generated needs nothing: the first "Buch erstellen" will
  // read the new setting. A hand-edited layout is left alone, because auto-designing over
  // manual edits is exactly what the consent prompt exists to prevent.
  if (groupingChanged && row.generatedAt) {
    if (row.layoutSource === 'edited') {
      return { ok: true, value: { redesign: 'skipped-edited' } };
    }
    if (isDesignInFlight(row.designRequestedAt)) {
      return { ok: true, value: { redesign: 'already-running' } };
    }
    await db
      .update(books)
      .set({ designRequestedAt: new Date(), designStage: 'preparing' })
      .where(eq(books.id, input.bookId));
    await enqueueDesignPhotoBook({ bookId: input.bookId });
    return { ok: true, value: { redesign: 'queued' } };
  }

  return { ok: true, value: { redesign: 'not-needed' } };
}

/** What `updatePhotoBookSettings` did about re-designing the book, so the UI can say so
 *  without re-deriving the rule (see the end of that function). */
export interface UpdatePhotoBookSettingsOutcome {
  redesign: 'not-needed' | 'queued' | 'skipped-edited' | 'already-running';
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
 * "Design my book" button, and the `redesign_book` agent tool. Mirrors
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
  // `isDesignInFlight`, not a bare null check: a worker that died mid-pass leaves
  // `design_requested_at` set forever, and a bare check would then refuse to ever design
  // this book again. After the cutoff the stale flag is simply overwritten below.
  if (isDesignInFlight(row.designRequestedAt)) {
    return err('An AI design pass is already running for this book.');
  }
  if (row.layoutSource === 'edited' && !input.overwriteEdits) {
    return err(
      "This book's layout has manual edits. Designing it again with AI would replace them — try again to confirm.",
    );
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(bookPhotos)
    .where(and(eq(bookPhotos.bookId, input.bookId), eq(bookPhotos.excluded, false)));
  if (!count) {
    // A text-only book (chapters with `include_text`, no photos) is a legitimate book —
    // the unified engine lays out its prose. Only a book with neither is refused.
    const [{ count: textChapterCount }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(bookStories)
      .where(and(eq(bookStories.bookId, input.bookId), eq(bookStories.includeText, true)));
    if (!textChapterCount) return err('Add at least one photo or story before designing.');
  }

  // `designStage: 'preparing'` is set here, not by the worker, so the builder's checklist
  // has a first step to show from the moment the button is clicked — a queued job can sit
  // for a few seconds before the worker picks it up, and "nothing has started" is exactly
  // the impression this whole progress display exists to avoid.
  await db
    .update(books)
    .set({ designRequestedAt: new Date(), designStage: 'preparing' })
    .where(eq(books.id, input.bookId));
  await enqueueDesignPhotoBook({ bookId: input.bookId });
  return { ok: true };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Photo-book chat/agent surface (docs/PHOTO_BOOK_PLAN.md PR4 / §9): a read
 * (`getPhotoBookSummary`, backing the `get_book_layout` agent tool) and a targeted-edit
 * entry point (`updatePhotoBookLayout`, backing `update_book_layout`) — the "all
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
  /** `'text'` marks a flowing story-text run (unified-book plan) — `photos` is then
   *  empty and `paragraphs` carries the inclusive range. The agent addresses entries by
   *  `pageIndex` either way; photo ops on a text entry are rejected with a clear error. */
  template: PhotoPageTemplate | 'text';
  photos: PhotoBookAgentPhoto[];
  paragraphs?: { from: number; to: number };
}

export interface PhotoBookAgentSection {
  sectionIndex: number;
  title: string;
  dateLabel?: string;
  storyId?: string;
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
 * The photo book's full current state for the chat agent (`get_book_layout`): every
 * section/page/photo the live plan places, plus each photo's vision-analysis summary —
 * this is what lets "die verschwommenen raus" ("blurry ones out") or "the one with Oma"
 * work, since the model can read `sharpness`/`shortDescription`/`sceneTags` per photo
 * instead of guessing from a bare id. Read-only: any chronicle member can call this
 * (membership gate only, like `listBookPhotos`), same as the story book's `get_book`.
 */
export async function getPhotoBookSummary(bookId: string, userId: string): Promise<Result<PhotoBookSummary>> {
  const [row] = await db
    .select({ chronicleId: books.chronicleId, layoutPlan: books.layoutPlan, title: books.title, status: books.status, layoutSource: books.layoutSource })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);
  if (!row) return err('Book not found.');
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
    ...(section.storyId ? { storyId: section.storyId } : {}),
    pages: section.pages.map((page, pageIndex): PhotoBookAgentPage => {
      if (isTextItem(page)) {
        return { pageIndex, template: 'text', photos: [], paragraphs: { from: page.from, to: page.to } };
      }
      return {
        pageIndex,
        template: page.template,
        photos: page.assetIds.map((id, i) => toAgentPhoto(id, page.captions?.[i] ?? null)),
      };
    }),
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
 *    from here on, so a later `redesign_book`/regenerate asks for confirmation
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
  // re-fetch get_book_layout in between would silently retarget any following
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
    // Also grabs `status` under the same lock (rather than reusing `gate.status` from
    // the pre-lock read above): a render could start between that read and here, and
    // downgrading a `rendering` book back to `draft` would let a second `requestPreview`
    // call race past its "already rendering" guard and enqueue a duplicate render job.
    const [locked] = await tx
      .select({ id: books.id, status: books.status })
      .from(books)
      .where(eq(books.id, input.bookId))
      .for('update');
    if (!locked) return err('Book not found.');

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

    // Emptied pages survive as photo-less dividers DURING the batch (index stability —
    // see `shrinkPage`), but a photo-less divider renders as a blank page, and the book
    // must never contain blank pages — drop them before the plan is persisted.
    plan = sweepBlankPages(plan);

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
        .set({
          excluded,
          excludedReason: excluded ? 'user' : null,
          // Same user-decision marker as `setPhotoExcluded` above — a chat
          // exclude_photo/include_photo op is just as much the user's own explicit
          // choice as the builder's toggle, and must survive a later regenerate/AI
          // design pass the same way.
          userDecision: excluded ? 'exclude' : 'include',
          updatedAt: new Date(),
        })
        .where(and(eq(bookPhotos.bookId, input.bookId), eq(bookPhotos.assetId, assetId)));
    }
    const set: Partial<typeof books.$inferInsert> = {
      layoutPlan: validated.plan,
      layoutSource: 'edited',
      // The freshly-persisted plan above already reflects this edit, so it doesn't need
      // rebuilding from the photo set (`layoutStale` stays false) — but any EXISTING
      // print PDF was rendered from the plan as it was BEFORE this edit, so it can no
      // longer be trusted; `invalidatePhotoBookPrint` downgrades a `preview_ready` book
      // back to `draft` to force a fresh render (PR5 review: "order screen can serve a
      // stale print PDF for photo books" — this is the one of the three flagged
      // mutations that does NOT also set `layoutStale: true`, since a chat edit doesn't
      // invalidate the plan itself, only any already-rendered PDF of it).
      layoutStale: false,
      updatedAt: new Date(),
      ...invalidatePhotoBookPrint(locked.status as BookStatus),
    };
    if (coverAssetId !== undefined) set.coverAssetId = coverAssetId;
    await tx.update(books).set(set).where(eq(books.id, input.bookId));

    return { ok: true };
  });
}

/**
 * Marks every book containing this story as needing a fresh print render — its prose is
 * printed content, so an edit to it makes any rendered PDF wrong. Deliberately does NOT
 * set `layoutStale`: the layout still matches the book's structure, only the words
 * changed, and flagging the plan stale would make an AI-designed book fall back to a
 * repair pass it doesn't need. Best-effort; never fails the caller's own write.
 */
export async function invalidateBooksForStory(storyId: string): Promise<void> {
  try {
    await db
      .update(books)
      .set({ status: 'draft', updatedAt: new Date() })
      .where(
        and(
          eq(books.status, 'preview_ready'),
          inArray(
            books.id,
            db.select({ id: bookStories.bookId }).from(bookStories).where(eq(bookStories.storyId, storyId)),
          ),
        ),
      );
  } catch (e) {
    console.error(`[books] could not invalidate books for story ${storyId}:`, e);
  }
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
  // Photo books have no chapters. This gate was never needed while attaching a story
  // only touched `book_stories` (which nothing in the photo pipeline reads), but a
  // story now mirrors its photos into `book_photos` — so without it, attaching stories
  // to a photo book would inject photos into its grid, count them against the upload
  // cap, and race `addBookPhotos` for positions.
  // No kind gate: attaching stories to ANY book is the point of the unified builder.
  // A story's photos mirror into `book_photos` and join the same tray/layout as uploads
  // (`syncStoryPhotoMirrors`), which is the intended behaviour, not a leak.
  // A viewer with hidden chapters only sees part of the chapter list — a full
  // replace from their view would silently drop the chapters they can't see.
  // Owners always see everything, so this never blocks them.
  if (gate.book.hiddenChapterCount > 0) {
    return err(
      "Some of this book's chapters are stories you don't have access to — only someone who can read every story can change the book's chapters.",
    );
  }
  const unique = [...new Set(input.storyIds)];
  if (unique.length === 0) {
    // Legal for a book that still has uploaded photos — removing the last chapter from
    // a hybrid book just turns it back into a photo book. Only a book left with nothing
    // at all is refused.
    const [{ count: photoCount }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(bookPhotos)
      .where(and(eq(bookPhotos.bookId, input.bookId), eq(bookPhotos.excluded, false)));
    if (!photoCount) {
      return err('A book needs at least one story or one photo.');
    }
  }

  // Every story must be ready, shared into the book's chronicle, and readable
  // by the acting user.
  const usable = await ensureUsableBookStories(gate.book.chronicleId, unique, gate.ctx);
  if (!usable.ok) return usable;

  let freshMirrors: Array<{ assetId: string; s3Key: string }> = [];
  await db.transaction(async (tx) => {
    // Preserve each retained story's include flags across the replace — a plain
    // delete+reinsert silently reset `includePhotos` (and would reset `includeText`)
    // back to their defaults on every reorder.
    const previous = await tx
      .select({
        storyId: bookStories.storyId,
        includePhotos: bookStories.includePhotos,
        includeText: bookStories.includeText,
      })
      .from(bookStories)
      .where(eq(bookStories.bookId, input.bookId));
    const flagsByStory = new Map(previous.map((p) => [p.storyId, p]));

    await tx.delete(bookStories).where(eq(bookStories.bookId, input.bookId));
    const rows = unique.map((storyId, position) => ({
      bookId: input.bookId,
      storyId,
      position,
      includePhotos: flagsByStory.get(storyId)?.includePhotos ?? true,
      includeText: flagsByStory.get(storyId)?.includeText ?? true,
    }));
    await tx.insert(bookStories).values(rows);
    freshMirrors = await syncStoryPhotoMirrors(tx, input.bookId, rows);
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
  await enqueueMirrorAnalysis(freshMirrors);
  return { ok: true };
}


/**
 * Toggles one attached story's text/photos flags (unified builder, PR D). The photo
 * toggle is not just a display flag — it flips that story's mirrored `book_photos` rows
 * between excluded and available (`syncStoryPhotoMirrors`), so the layout, the tray and
 * the analysis pipeline all agree. Turning both off is refused: a chapter contributing
 * neither text nor photos should be detached instead, which `setBookStories` does.
 */
export async function setBookStoryFlags(input: {
  bookId: string;
  userId: string;
  storyId: string;
  includeText?: boolean;
  includePhotos?: boolean;
}): Promise<Result> {
  const gate = await editableBook(input.bookId, input.userId);
  if (!gate.ok) return gate;
  const hidden = hiddenChaptersError(gate.book);
  if (hidden) return hidden;

  const [current] = await db
    .select({ includeText: bookStories.includeText, includePhotos: bookStories.includePhotos })
    .from(bookStories)
    .where(and(eq(bookStories.bookId, input.bookId), eq(bookStories.storyId, input.storyId)))
    .limit(1);
  if (!current) return err('That story is not in this book.');

  const includeText = input.includeText ?? current.includeText;
  const includePhotos = input.includePhotos ?? current.includePhotos;
  if (!includeText && !includePhotos) {
    return err('A chapter needs its text or its photos — remove it from the book instead.');
  }

  let freshMirrors: Array<{ assetId: string; s3Key: string }> = [];
  await db.transaction(async (tx) => {
    await tx
      .update(bookStories)
      .set({ includeText, includePhotos })
      .where(and(eq(bookStories.bookId, input.bookId), eq(bookStories.storyId, input.storyId)));
    const rows = await tx
      .select({
        storyId: bookStories.storyId,
        position: bookStories.position,
        includePhotos: bookStories.includePhotos,
      })
      .from(bookStories)
      .where(eq(bookStories.bookId, input.bookId));
    freshMirrors = await syncStoryPhotoMirrors(tx, input.bookId, rows);
    await tx
      .update(books)
      .set({ layoutStale: true, updatedAt: new Date(), ...invalidatePhotoBookPrint(gate.book.status) })
      .where(eq(books.id, input.bookId));
  });
  await enqueueMirrorAnalysis(freshMirrors);
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

  // Already fresh — nothing to (re-)render. Lets the "Download PDF" flow call this
  // unconditionally before serving the PDF without forcing a wasteful Chromium re-run
  // on a book whose print PDF already matches its current content.
  if (gate.book.status === 'preview_ready' && !gate.book.layoutStale) return { ok: true };

  // The rendered PDF physically contains EVERY chapter — all-or-nothing: only someone
  // who can read all of the book's stories may trigger (and later fetch) it. Vacuous for
  // a book built purely from uploads, which has no chapters to hide.
  if (gate.book.hiddenChapterCount > 0) {
    return err(
      "Some of this book's chapters are stories you don't have access to — the print PDF contains every chapter, so only someone who can read all of them can render or order it.",
    );
  }

  const [{ count: photoCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(bookPhotos)
    .where(and(eq(bookPhotos.bookId, input.bookId), eq(bookPhotos.excluded, false)));
  if (!photoCount && gate.book.chapters.length === 0) {
    return err('Add at least one photo or story before rendering.');
  }
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
  // Quoting is part of the order flow, which needs the all-chapters print PDF. Photo
  // books have no hidden-chapter concept (§2: every chronicle member with book access
  // sees every photo), so this never blocks them — `hiddenChapterCount` is always 0.
  if (book.hiddenChapterCount > 0) {
    return err(
      "Some of this book's chapters are stories you don't have access to — the printed book contains every chapter, so only someone who can read all of them can price or order it.",
    );
  }
  const pageCount = book.pageCount ?? (await estimatePageCount(book));
  const quote = await quoteBookPrice({ format: book.format, coverType: book.coverType, pageCount });
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
export async function estimatePageCount(
  book: Pick<BookDetail, 'id' | 'kind' | 'chapters' | 'layoutPlan'>,
): Promise<number> {
  {
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
