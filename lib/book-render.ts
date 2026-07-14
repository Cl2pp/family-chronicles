import puppeteer, { type Browser } from 'puppeteer';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { assets, books, bookStories, chronicles, stories } from '@/db/schema';
import { getObjectBuffer, putObjectBuffer } from '@/lib/s3';
import { MIN_PAGES, MAX_PAGES } from '@/lib/gelato';
import { renderBookHtml, type LayoutChapterContent, type LayoutImage, type LayoutVariant } from '@/lib/book-layout';
import { validateLayoutPlan, type LayoutPlan } from '@/lib/book-layout-plan';
import { buildLayoutPlan, type AutoLayoutChapter } from '@/lib/book-autolayout';
import { env } from '@/lib/env';

/**
 * The worker side of book rendering: load content, build/refresh the layout plan,
 * embed photos, print the plan to two PDFs (low-res watermarked preview + print-ready
 * with bleed), pad to Gelato's page rules, store both in S3, and update the book row.
 *
 * Runs serially (see worker/index.ts) — Chromium plus large photos is the most
 * memory-hungry thing this app does.
 */

const TRIM: Record<string, { w: number; h: number }> = {
  'hardcover-21x28': { w: 210, h: 280 },
  'hardcover-20x20': { w: 200, h: 200 },
};

/** Longest-edge pixel budgets per variant — preview stays small enough for mobile. */
const PHOTO_WIDTH = { preview: 640, print: 2000 } as const;
const JPEG_QUALITY = { preview: 55, print: 82 } as const;

async function photoDataUri(buffer: Buffer, variant: LayoutVariant): Promise<string> {
  const img = sharp(buffer, { failOn: 'none' }).rotate(); // apply EXIF orientation
  const out = await img
    .resize({ width: PHOTO_WIDTH[variant], withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY[variant], mozjpeg: true })
    .toBuffer();
  return `data:image/jpeg;base64,${out.toString('base64')}`;
}

/** EXIF-oriented pixel dimensions (width/height swapped for a 90°/270° orientation tag). */
async function orientedDimensions(buffer: Buffer): Promise<{ width: number; height: number } | null> {
  const meta = await sharp(buffer, { failOn: 'none' }).metadata();
  if (!meta.width || !meta.height) return null;
  const swapped = meta.orientation != null && meta.orientation >= 5 && meta.orientation <= 8;
  return swapped ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height };
}

function eventLabel(date: Date | null, precision: string | null): string | null {
  if (!date) return null;
  const year = date.getUTCFullYear();
  if (precision === 'circa') return `ca. ${year}`;
  return String(year);
}

function paragraphs(body: string): string[] {
  return body
    .split(/\n{2,}|\r\n{2,}/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
}

function wordCount(paragraph: string): number {
  return paragraph.split(/\s+/).filter(Boolean).length;
}

interface PhotoRef {
  id: string;
  s3Key: string;
  /** Downscaled WebP (lib/thumbnails.ts), when already generated. */
  thumbS3Key: string | null;
  caption: string | null;
  width: number | null;
  height: number | null;
}

interface LoadedBook {
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

async function loadBook(bookId: string): Promise<LoadedBook> {
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
 * only runs once per photo. The auto-layouter needs real geometry to reason about
 * aspect ratio and resolution.
 */
async function backfillDimensions(allPhotosById: Map<string, PhotoRef>): Promise<void> {
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
      console.error(`[book-render] failed to read dimensions for ${photo.s3Key}:`, e);
    }
  }
}

/**
 * Loads the book's stored layout plan, or builds a fresh one with the deterministic
 * auto-layouter when there isn't one yet, it's stale, or it fails validation.
 *
 * `layout_source: 'edited'` (a future builder-UI/agent edit) is meant to require
 * explicit user consent before being overwritten by a regeneration — that consent
 * flow is phase 4. For now, an edited-but-stale plan is still rebuilt, same as auto.
 */
async function loadOrBuildPlan(bookId: string, loaded: LoadedBook): Promise<LayoutPlan> {
  const { row } = loaded;

  if (row.layoutPlan && !row.layoutStale) {
    const validated = validateLayoutPlan(row.layoutPlan);
    if (validated.ok) return validated.plan;
    console.warn(`[book-render] stored layout plan for ${bookId} failed validation, rebuilding:`, validated.error);
  }

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

/** Pad with blank pages to Gelato's rules: at least MIN_PAGES and an even count. */
async function padPdf(pdf: Buffer): Promise<{ padded: Buffer; pageCount: number }> {
  const doc = await PDFDocument.load(pdf);
  let count = doc.getPageCount();
  if (count > MAX_PAGES) {
    // Not fatal for a preview; the order screen surfaces the limit to the user.
    console.warn(`[book-render] ${count} pages exceeds Gelato max of ${MAX_PAGES}`);
  }
  const { width, height } = doc.getPage(count - 1).getSize();
  const target = Math.max(MIN_PAGES, count + (count % 2));
  while (count < target) {
    doc.addPage([width, height]);
    count++;
  }
  const bytes = await doc.save();
  return { padded: Buffer.from(bytes), pageCount: count };
}

/** Every assetId the plan actually renders — cover hero plus every block reference. */
function referencedAssetIds(plan: LayoutPlan): Set<string> {
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

async function renderVariant(
  browser: Browser,
  loaded: LoadedBook,
  plan: LayoutPlan,
  variant: LayoutVariant,
): Promise<Buffer> {
  // Embed only photos the plan references, at the variant's resolution. Failures
  // skip the photo, not the book.
  //
  // Source selection: the preview targets 640px — exactly the thumbnail size — so
  // it reads the WebP thumbnail when one exists and skips downloading camera
  // originals. Print wants the original, but falls back to the thumbnail when the
  // original can't be decoded (e.g. HEIC, which sharp's prebuilt libvips can't
  // read) — a 640-1600px photo in print beats a missing one.
  const srcCache = new Map<string, string>();
  async function embed(photo: PhotoRef): Promise<LayoutImage | null> {
    if (!photo.width || !photo.height) return null;
    let src = srcCache.get(photo.s3Key);
    if (!src) {
      const sources =
        variant === 'preview'
          ? [photo.thumbS3Key ?? photo.s3Key]
          : [photo.s3Key, ...(photo.thumbS3Key ? [photo.thumbS3Key] : [])];
      let lastError: unknown;
      for (const key of sources) {
        try {
          src = await photoDataUri(await getObjectBuffer(key), variant);
          break;
        } catch (e) {
          lastError = e;
          if (key !== sources[sources.length - 1]) {
            console.warn(`[book-render] ${key} failed, trying thumbnail:`, e);
          }
        }
      }
      if (!src) {
        console.error(`[book-render] skipping photo ${photo.s3Key}:`, lastError);
        return null;
      }
      srcCache.set(photo.s3Key, src);
    }
    return { assetId: photo.id, src, caption: photo.caption, width: photo.width, height: photo.height };
  }

  const needed = referencedAssetIds(plan);
  const resolved = new Map<string, LayoutImage>();
  for (const id of needed) {
    const photo = loaded.allPhotosById.get(id);
    if (!photo) continue;
    const img = await embed(photo);
    if (img) resolved.set(id, img);
  }

  const chapters: LayoutChapterContent[] = loaded.chapters.map((c) => ({
    storyId: c.storyId,
    title: c.title,
    eventLabel: c.eventLabel,
    paragraphs: paragraphs(c.body),
    images: c.photoAssets.map((p) => resolved.get(p.id)).filter((i): i is LayoutImage => !!i),
  }));

  const coverImage =
    plan.cover.heroAssetId != null ? (resolved.get(plan.cover.heroAssetId) ?? null) : null;

  const html = renderBookHtml({
    variant,
    title: loaded.row.title,
    subtitle: loaded.row.subtitle,
    dedication: loaded.row.dedication,
    chronicleName: loaded.chronicleName,
    trim: TRIM[loaded.row.format] ?? TRIM['hardcover-21x28'],
    plan,
    chapters,
    coverImage,
    createdLabel: new Date().toLocaleDateString('de-DE', { year: 'numeric', month: 'long' }),
    watermarkText: 'VORSCHAU · PREVIEW',
  });

  const page = await browser.newPage();
  try {
    // All images are inline data: URIs, so 'load' means fully loaded.
    await page.setContent(html, { waitUntil: 'load', timeout: 120_000 });
    const pdf = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      timeout: 120_000,
    });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}

/** The `render-book` job: render, pad, store, and flip the book's status. */
export async function renderBook(bookId: string): Promise<void> {
  const loaded = await loadBook(bookId);
  await backfillDimensions(loaded.allPhotosById);
  const plan = await loadOrBuildPlan(bookId, loaded);

  const browser = await puppeteer.launch({
    executablePath: env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });
  let preview: Buffer;
  let print: Buffer;
  try {
    preview = await renderVariant(browser, loaded, plan, 'preview');
    print = await renderVariant(browser, loaded, plan, 'print');
  } finally {
    await browser.close();
  }

  const printPadded = await padPdf(print);
  const previewPadded = await padPdf(preview);

  const previewKey = `books/${bookId}/preview.pdf`;
  const printKey = `books/${bookId}/print.pdf`;
  await putObjectBuffer(previewKey, previewPadded.padded, 'application/pdf');
  await putObjectBuffer(printKey, printPadded.padded, 'application/pdf');

  await db
    .update(books)
    .set({
      status: 'preview_ready',
      errorMessage: null,
      pageCount: printPadded.pageCount,
      previewS3Key: previewKey,
      printS3Key: printKey,
      updatedAt: new Date(),
    })
    .where(eq(books.id, bookId));
}

/** Mark a failed render so the UI can offer a retry. */
export async function markRenderFailed(bookId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db
    .update(books)
    .set({ status: 'render_failed', errorMessage: message, updatedAt: new Date() })
    .where(eq(books.id, bookId));
}
