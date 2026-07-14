import puppeteer, { type Browser } from 'puppeteer';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { books } from '@/db/schema';
import { getObjectBuffer, putObjectBuffer } from '@/lib/s3';
import { MIN_PAGES, MAX_PAGES } from '@/lib/gelato';
import { renderBookHtml, type LayoutChapterContent, type LayoutImage } from '@/lib/book-layout';
import type { LayoutPlan } from '@/lib/book-layout-plan';
import {
  TRIM,
  backfillDimensionsFromOriginals,
  loadBook,
  loadOrBuildPlan,
  paragraphs,
  referencedAssetIds,
  type LoadedBook,
  type PhotoRef,
} from '@/lib/book-content';
import { env } from '@/lib/env';

/**
 * The worker side of book rendering: load content, build/refresh the layout plan,
 * embed photos, print the plan to two PDFs (low-res watermarked preview + print-ready
 * with bleed), pad to Gelato's page rules, store both in S3, and update the book row.
 *
 * Runs serially (see worker/index.ts) — Chromium plus large photos is the most
 * memory-hungry thing this app does. Content loading + layout-plan resolution live in
 * `lib/book-content.ts`, shared with the web process's live HTML preview.
 */

/** Longest-edge pixel budgets per variant — preview stays small enough for mobile. */
const PHOTO_WIDTH = { preview: 640, print: 2000 } as const;
const JPEG_QUALITY = { preview: 55, print: 82 } as const;

async function photoDataUri(buffer: Buffer, variant: 'preview' | 'print'): Promise<string> {
  const img = sharp(buffer, { failOn: 'none' }).rotate(); // apply EXIF orientation
  const out = await img
    .resize({ width: PHOTO_WIDTH[variant], withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY[variant], mozjpeg: true })
    .toBuffer();
  return `data:image/jpeg;base64,${out.toString('base64')}`;
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
  plan: LayoutPlan,
  variant: 'preview' | 'print',
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
  await backfillDimensionsFromOriginals(loaded.allPhotosById);
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
