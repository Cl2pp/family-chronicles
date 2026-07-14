import puppeteer, { type Browser } from 'puppeteer';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { assets, books, bookStories, chronicles, stories } from '@/db/schema';
import { getObjectBuffer, putObjectBuffer } from '@/lib/s3';
import { MIN_PAGES, MAX_PAGES } from '@/lib/gelato';
import {
  renderBookHtml,
  type LayoutChapter,
  type LayoutPhoto,
  type LayoutVariant,
} from '@/lib/book-layout';
import { env } from '@/lib/env';

/**
 * The worker side of book rendering: load content, embed photos, print the
 * layout to two PDFs (low-res watermarked preview + print-ready with bleed),
 * pad to Gelato's page rules, store both in S3, and update the book row.
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

async function photoDataUri(
  buffer: Buffer,
  variant: LayoutVariant,
): Promise<{ src: string; landscape: boolean }> {
  const img = sharp(buffer, { failOn: 'none' }).rotate(); // apply EXIF orientation
  const meta = await img.metadata();
  const landscape = (meta.width ?? 1) >= (meta.height ?? 1);
  const out = await img
    .resize({ width: PHOTO_WIDTH[variant], withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY[variant], mozjpeg: true })
    .toBuffer();
  return { src: `data:image/jpeg;base64,${out.toString('base64')}`, landscape };
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

interface PhotoRef {
  id: string;
  s3Key: string;
  /** Downscaled WebP (lib/thumbnails.ts), when already generated. */
  thumbS3Key: string | null;
  caption: string | null;
}

interface LoadedBook {
  row: typeof books.$inferSelect;
  chronicleName: string;
  chapters: Array<{
    title: string;
    eventLabel: string | null;
    body: string;
    photoAssets: PhotoRef[];
  }>;
  cover: PhotoRef | null;
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
    })
    .from(assets)
    .where(and(inArray(assets.storyId, storyIds), eq(assets.kind, 'photo')))
    .orderBy(asc(assets.createdAt));
  const photosByStory = new Map<string, PhotoRef[]>();
  for (const p of photoRows) {
    const arr = photosByStory.get(p.storyId) ?? [];
    arr.push({ id: p.id, s3Key: p.s3Key, thumbS3Key: p.thumbS3Key, caption: p.caption });
    photosByStory.set(p.storyId, arr);
  }

  let cover: PhotoRef | null = null;
  if (row.coverAssetId) {
    const [c] = await db
      .select({
        id: assets.id,
        s3Key: assets.s3Key,
        thumbS3Key: assets.thumbS3Key,
        caption: assets.caption,
      })
      .from(assets)
      .where(eq(assets.id, row.coverAssetId))
      .limit(1);
    cover = c ?? null;
  }
  // Fall back to the first photo in the book so covers are never blank grey.
  if (!cover) cover = photoRows[0] ?? null;

  return {
    row,
    chronicleName: chron?.name ?? 'Family Chronicle',
    chapters: chapterRows.map((c) => ({
      title: c.title,
      eventLabel: eventLabel(c.eventDate, c.eventDatePrecision),
      body: c.bodyStyled ?? c.bodyOriginal ?? '',
      photoAssets: c.includePhotos ? (photosByStory.get(c.storyId) ?? []) : [],
    })),
    cover,
  };
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

async function renderVariant(
  browser: Browser,
  loaded: LoadedBook,
  variant: LayoutVariant,
): Promise<Buffer> {
  // Embed photos at the variant's resolution; failures skip the photo, not the book.
  //
  // Source selection: the preview targets 640px — exactly the thumbnail size — so
  // it reads the WebP thumbnail when one exists and skips downloading camera
  // originals. Print wants the original, but falls back to the thumbnail when the
  // original can't be decoded (e.g. HEIC, which sharp's prebuilt libvips can't
  // read) — a 640-1600px photo in print beats a missing one.
  const photoCache = new Map<string, { src: string; landscape: boolean }>();
  async function embed(photo: Pick<PhotoRef, 's3Key' | 'thumbS3Key'>) {
    const hit = photoCache.get(photo.s3Key);
    if (hit) return hit;
    const sources =
      variant === 'preview'
        ? [photo.thumbS3Key ?? photo.s3Key]
        : [photo.s3Key, ...(photo.thumbS3Key ? [photo.thumbS3Key] : [])];
    let lastError: unknown;
    for (const key of sources) {
      try {
        const data = await photoDataUri(await getObjectBuffer(key), variant);
        photoCache.set(photo.s3Key, data);
        return data;
      } catch (e) {
        lastError = e;
        if (key !== sources[sources.length - 1]) {
          console.warn(`[book-render] ${key} failed, trying thumbnail:`, e);
        }
      }
    }
    throw lastError;
  }

  const chapters: LayoutChapter[] = [];
  for (const c of loaded.chapters) {
    const photos: LayoutPhoto[] = [];
    for (const p of c.photoAssets) {
      try {
        const { src, landscape } = await embed(p);
        photos.push({ src, landscape, caption: p.caption });
      } catch (e) {
        console.error(`[book-render] skipping photo ${p.s3Key}:`, e);
      }
    }
    chapters.push({
      title: c.title,
      eventLabel: c.eventLabel,
      paragraphs: paragraphs(c.body),
      photos,
    });
  }

  let coverSrc: string | null = null;
  if (loaded.cover) {
    try {
      coverSrc = (await embed(loaded.cover)).src;
    } catch (e) {
      console.error(`[book-render] cover photo failed:`, e);
    }
  }

  const html = renderBookHtml({
    variant,
    title: loaded.row.title,
    subtitle: loaded.row.subtitle,
    dedication: loaded.row.dedication,
    chronicleName: loaded.chronicleName,
    coverSrc,
    trim: TRIM[loaded.row.format] ?? TRIM['hardcover-21x28'],
    chapters,
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

  const browser = await puppeteer.launch({
    executablePath: env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });
  let preview: Buffer;
  let print: Buffer;
  try {
    preview = await renderVariant(browser, loaded, 'preview');
    print = await renderVariant(browser, loaded, 'print');
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
