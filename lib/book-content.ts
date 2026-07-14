import sharp from 'sharp';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { assets, books, bookStories, chronicles, stories } from '@/db/schema';
import { getObjectBuffer } from '@/lib/s3';
import { validateLayoutPlan, type LayoutPlan } from '@/lib/book-layout-plan';
import { buildLayoutPlan, type AutoLayoutChapter } from '@/lib/book-autolayout';

/**
 * Book content loading + layout-plan resolution, shared by the worker's PDF
 * render (`lib/book-render.ts`) and the web process's live HTML preview
 * (`app/api/books/[bookId]/preview-html/route.ts`). Both need the exact same
 * "what does this book currently contain, and what's its layout plan" answer
 * so the live preview and the eventual print PDF never disagree on content —
 * only on image resolution and whether Paged.js or Chromium does the
 * pagination.
 */

export const TRIM: Record<string, { w: number; h: number }> = {
  'hardcover-21x28': { w: 210, h: 280 },
  'hardcover-20x20': { w: 200, h: 200 },
};

export interface PhotoRef {
  id: string;
  s3Key: string;
  /** Downscaled WebP (lib/thumbnails.ts), when already generated. */
  thumbS3Key: string | null;
  mimeType: string;
  caption: string | null;
  width: number | null;
  height: number | null;
}

export interface LoadedBook {
  row: typeof books.$inferSelect;
  chronicleName: string;
  chapters: Array<{
    storyId: string;
    title: string;
    eventLabel: string | null;
    body: string;
    photoAssets: PhotoRef[];
  }>;
  /** Every photo of the book, regardless of a chapter's includePhotos flag — the
   *  plan's cover heroAssetId (and a user's explicit cover pick) may reference one
   *  even when its chapter excludes photos from the flowed text. */
  allPhotosById: Map<string, PhotoRef>;
}

export function eventLabel(date: Date | null, precision: string | null): string | null {
  if (!date) return null;
  const year = date.getUTCFullYear();
  if (precision === 'circa') return `ca. ${year}`;
  return String(year);
}

export function paragraphs(body: string): string[] {
  return body
    .split(/\n{2,}|\r\n{2,}/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
}

export function wordCount(paragraph: string): number {
  return paragraph.split(/\s+/).filter(Boolean).length;
}

/** EXIF-oriented pixel dimensions (width/height swapped for a 90°/270° orientation tag). */
export async function orientedDimensions(
  buffer: Buffer,
): Promise<{ width: number; height: number } | null> {
  const meta = await sharp(buffer, { failOn: 'none' }).metadata();
  if (!meta.width || !meta.height) return null;
  const swapped = meta.orientation != null && meta.orientation >= 5 && meta.orientation <= 8;
  return swapped ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height };
}

export async function loadBook(bookId: string): Promise<LoadedBook> {
  const [row] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
  if (!row) throw new Error(`Book ${bookId} not found`);
  const [chron] = await db
    .select({ name: chronicles.name })
    .from(chronicles)
    .where(eq(chronicles.id, row.chronicleId))
    .limit(1);

  const chapterRows = await db
    .select({
      storyId: bookStories.storyId,
      includePhotos: bookStories.includePhotos,
      title: stories.title,
      bodyStyled: stories.bodyStyled,
      bodyOriginal: stories.bodyOriginal,
      eventDate: stories.eventDate,
      eventDatePrecision: stories.eventDatePrecision,
    })
    .from(bookStories)
    .innerJoin(stories, eq(bookStories.storyId, stories.id))
    .where(eq(bookStories.bookId, bookId))
    .orderBy(asc(bookStories.position));
  if (chapterRows.length === 0) throw new Error('Book has no stories');

  const storyIds = chapterRows.map((c) => c.storyId);
  const photoRows = await db
    .select({
      id: assets.id,
      storyId: assets.storyId,
      s3Key: assets.s3Key,
      thumbS3Key: assets.thumbS3Key,
      mimeType: assets.mimeType,
      caption: assets.caption,
      width: assets.width,
      height: assets.height,
    })
    .from(assets)
    .where(and(inArray(assets.storyId, storyIds), eq(assets.kind, 'photo')))
    .orderBy(asc(assets.createdAt));

  const photosByStory = new Map<string, PhotoRef[]>();
  const allPhotosById = new Map<string, PhotoRef>();
  for (const p of photoRows) {
    const ref: PhotoRef = {
      id: p.id,
      s3Key: p.s3Key,
      thumbS3Key: p.thumbS3Key,
      mimeType: p.mimeType,
      caption: p.caption,
      width: p.width,
      height: p.height,
    };
    const arr = photosByStory.get(p.storyId) ?? [];
    arr.push(ref);
    photosByStory.set(p.storyId, arr);
    allPhotosById.set(p.id, ref);
  }

  return {
    row,
    chronicleName: chron?.name ?? 'Family Chronicle',
    chapters: chapterRows.map((c) => ({
      storyId: c.storyId,
      title: c.title,
      eventLabel: eventLabel(c.eventDate, c.eventDatePrecision),
      body: c.bodyStyled ?? c.bodyOriginal ?? '',
      photoAssets: c.includePhotos ? (photosByStory.get(c.storyId) ?? []) : [],
    })),
    allPhotosById,
  };
}

/**
 * Fills in `assets.width/height` for any photo missing them (older uploads, or
 * assets created before dimensions were tracked), persisting the result so this
 * only runs once per photo. Reads the true original from S3, so the persisted
 * dimensions are trustworthy. Worker-only (`lib/book-render.ts`) — it's the one
 * process allowed to write `assets.width/height`.
 */
export async function backfillDimensionsFromOriginals(allPhotosById: Map<string, PhotoRef>): Promise<void> {
  for (const photo of allPhotosById.values()) {
    if (photo.width && photo.height) continue;
    try {
      const buffer = await getObjectBuffer(photo.s3Key);
      const dims = await orientedDimensions(buffer);
      if (!dims) continue;
      photo.width = dims.width;
      photo.height = dims.height;
      await db.update(assets).set({ width: dims.width, height: dims.height }).where(eq(assets.id, photo.id));
    } catch (e) {
      console.error(`[book-content] failed to read original dimensions for ${photo.s3Key}:`, e);
    }
  }
}

/**
 * Web-process counterpart of `backfillDimensionsFromOriginals`: reads the
 * downscaled WebP thumbnail instead of the S3 original, because the web
 * process renders on every request (no worker job budget) and the
 * auto-layouter only needs aspect ratio, not true resolution. Crucially this
 * never persists — a thumbnail's pixel dimensions are NOT the photo's true
 * size, and writing them to `assets.width/height` would corrupt data the
 * worker relies on (e.g. picking the highest-resolution image for a
 * `photo-page`). Photos with no thumbnail yet (not processed by the worker's
 * `thumbnail` job) are simply skipped — they're excluded from the plan until
 * a dimension is known, same as today.
 */
export async function backfillDimensionsFromThumbnails(allPhotosById: Map<string, PhotoRef>): Promise<void> {
  for (const photo of allPhotosById.values()) {
    if (photo.width && photo.height) continue;
    if (!photo.thumbS3Key) continue;
    try {
      const buffer = await getObjectBuffer(photo.thumbS3Key);
      const dims = await orientedDimensions(buffer);
      if (!dims) continue;
      photo.width = dims.width;
      photo.height = dims.height;
    } catch (e) {
      console.error(`[book-content] failed to read thumbnail dimensions for ${photo.thumbS3Key}:`, e);
    }
  }
}

/**
 * Loads the book's stored layout plan, or builds a fresh one with the deterministic
 * auto-layouter when there isn't one yet, it's stale, or it fails validation. Shared
 * by the worker (after backfilling true dimensions) and the web preview route (after
 * backfilling thumbnail-derived aspect ratios) — same function, same persistence
 * rule, so a plan built by one process is reused by the other instead of re-rolled.
 *
 * `layout_source: 'edited'` (a future builder-UI/agent edit) is meant to require
 * explicit user consent before being overwritten by a regeneration — that consent
 * flow is phase 4. For now, an edited-but-stale plan is still rebuilt, same as auto.
 */
export async function loadOrBuildPlan(bookId: string, loaded: LoadedBook): Promise<LayoutPlan> {
  const { row } = loaded;

  if (row.layoutPlan && !row.layoutStale) {
    const validated = validateLayoutPlan(row.layoutPlan);
    if (validated.ok) return validated.plan;
    console.warn(`[book-content] stored layout plan for ${bookId} failed validation, rebuilding:`, validated.error);
  }

  return buildAndPersistAutoPlan(bookId, loaded);
}

/**
 * Always rebuilds the plan with the deterministic auto-layouter and persists it as
 * `layout_source: 'auto'`, regardless of any existing plan/staleness — the explicit
 * "regenerate" path (as opposed to `loadOrBuildPlan`'s "reuse unless stale"). Used by
 * `loadOrBuildPlan` itself, and by the `design-book` worker handler as the fallback
 * when the AI design pass fails.
 */
export async function buildAndPersistAutoPlan(bookId: string, loaded: LoadedBook): Promise<LayoutPlan> {
  const { row } = loaded;

  const autoLayoutChapters: AutoLayoutChapter[] = loaded.chapters.map((c) => ({
    storyId: c.storyId,
    paragraphWordCounts: paragraphs(c.body).map(wordCount),
    images: c.photoAssets
      .filter((p): p is PhotoRef & { width: number; height: number } => !!p.width && !!p.height)
      .map((p) => ({ assetId: p.id, width: p.width, height: p.height })),
  }));

  const plan = buildLayoutPlan({
    coverAssetId: row.coverAssetId,
    chapters: autoLayoutChapters,
  });

  await db
    .update(books)
    .set({ layoutPlan: plan, layoutSource: 'auto', layoutStale: false, updatedAt: new Date() })
    .where(eq(books.id, bookId));

  return plan;
}

/** Every assetId a plan actually renders — cover hero plus every block reference. */
export function referencedAssetIds(plan: LayoutPlan): Set<string> {
  const ids = new Set<string>();
  if (plan.cover.heroAssetId) ids.add(plan.cover.heroAssetId);
  for (const chapter of plan.chapters) {
    for (const block of chapter.blocks) {
      if (block.type === 'figure' || block.type === 'photo-page') ids.add(block.assetId);
      if (block.type === 'photo-row' || block.type === 'photo-grid') {
        for (const id of block.assetIds) ids.add(id);
      }
    }
  }
  return ids;
}
