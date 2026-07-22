import { type Browser } from 'puppeteer';
import { withChromium } from '@/lib/chromium';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { books, chronicles } from '@/db/schema';
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
import { renderPhotoBookHtml, type PhotoLayoutImage } from '@/lib/photo-book-layout';
import {
  backfillPhotoBookDimensionsFromOriginals,
  loadOrBuildPhotoPlan,
  loadPhotoBook,
  photoAssetPrintTargetSizeMm,
  photoAssetRenditionNeeds,
  referencedPhotoAssetIds,
  type LoadedPhotoBook,
  type PhotoBookPhotoRef,
  type PhotoDimsById,
  type PrintTargetSizeMm,
} from '@/lib/photo-book-content';
import { embeddedFontFaceCss } from '@/lib/photo-book-fonts';
import type { PhotoBookPlan } from '@/lib/photo-book-plan';

/**
 * The worker side of book rendering: load content, build/refresh the layout plan,
 * embed photos, print the plan to two PDFs (low-res watermarked preview + print-ready
 * with bleed), pad to Gelato's page rules, store both in S3, and update the book row.
 *
 * Runs serially (see worker/index.ts) — Chromium plus large photos is the most
 * memory-hungry thing this app does. Content loading + layout-plan resolution live in
 * `lib/book-content.ts`/`lib/photo-book-content.ts`, shared with the web process's live
 * HTML preview.
 *
 * `renderBook` branches on `books.kind` right at the top (docs/PHOTO_BOOK_PLAN.md PR5):
 * the story path below this comment is UNCHANGED from before photo books existed; the
 * photo-book path lives in its own section further down, sharing only the low-level
 * Chromium/PDF-padding helpers (`htmlToPdf`, `padPdf`) — never the story-specific content
 * loading or HTML generation.
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

/** Sets `html` as a Chromium page's content and prints it to a PDF buffer — the one
 *  low-level step shared by every render, story or photo. All images (and, for photo
 *  books, fonts) are inline `data:`/embedded, so 'load' means the page is fully ready to
 *  print; nothing here waits on the network. */
async function htmlToPdf(browser: Browser, html: string): Promise<Buffer> {
  const page = await browser.newPage();
  try {
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

  return htmlToPdf(browser, html);
}

/** The `render-book` job: render, pad, store, and flip the book's status — branches on
 *  `books.kind` right away (docs/PHOTO_BOOK_PLAN.md PR5). The story path below is exactly
 *  what it was before photo books existed; `renderPhotoBook` (further down) is the new,
 *  entirely separate photo-book path — they share only `htmlToPdf`/`padPdf`. */
export async function renderBook(bookId: string): Promise<void> {
  const [row] = await db.select({ kind: books.kind }).from(books).where(eq(books.id, bookId)).limit(1);
  if (!row) throw new Error(`Book ${bookId} not found`);
  if (row.kind === 'photo') {
    await renderPhotoBook(bookId);
    return;
  }

  const loaded = await loadBook(bookId);
  await backfillDimensionsFromOriginals(loaded.allPhotosById);
  const plan = await loadOrBuildPlan(bookId, loaded);

  const { preview, print } = await withChromium(`render story book ${bookId}`, async (browser) => ({
    preview: await renderVariant(browser, loaded, plan, 'preview'),
    print: await renderVariant(browser, loaded, plan, 'print'),
  }));

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

/* ──────────────────────────────────────────────────────────────────────────
 * Photo books (docs/PHOTO_BOOK_PLAN.md PR5): the same two-PDF, pad-and-store shape as
 * the story path above, but content loading (`loadPhotoBook`/`loadOrBuildPhotoPlan`),
 * HTML generation (`renderPhotoBookHtml`), and image-embedding resolution are all
 * photo-book-specific. Nothing here touches a story book's row, tables, or code path.
 * ────────────────────────────────────────────────────────────────────────── */

// The photo book's low-res preview PDF reuses the story path's `photoDataUri(..,
// 'preview')` unchanged — same flat 640px budget (`PHOTO_WIDTH.preview`) regardless of
// slot, which is exactly right for a proof: no per-slot precision needed, and a flat
// budget bounds memory trivially no matter how many photos the book has.

/** 300 dpi is the standard print-quality target; converts a physical mm size (a plan
 *  slot's print target, `photoAssetPrintTargetSizeMm`) into the pixel bounding box sharp
 *  should downscale an original into. */
const PRINT_DPI = 300;
function mmToPx(mm: number): number {
  return Math.max(1, Math.round((mm / 25.4) * PRINT_DPI));
}

/** Print-quality embedding for a photo book: downscales to the EXACT pixel bounding box
 *  its slot needs at 300dpi (`targetMm`, from `photoAssetPrintTargetSizeMm`) rather than
 *  the story path's flat 2000px budget — a full-bleed cover hero and a 4-up collage tile
 *  need very different pixel budgets, and inlining every original at full camera
 *  resolution is exactly the memory blowup docs/PHOTO_BOOK_PLAN.md §8 warns against for a
 *  100+ photo book. */
async function photoBookPrintDataUri(buffer: Buffer, targetMm: PrintTargetSizeMm): Promise<string> {
  const out = await sharp(buffer, { failOn: 'none' })
    .rotate() // apply EXIF orientation
    .resize({ width: mmToPx(targetMm.w), height: mmToPx(targetMm.h), fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
  return `data:image/jpeg;base64,${out.toString('base64')}`;
}

async function renderPhotoBookVariant(
  browser: Browser,
  loaded: LoadedPhotoBook,
  plan: PhotoBookPlan,
  chronicleName: string,
  trim: { w: number; h: number },
  variant: 'preview' | 'print',
): Promise<Buffer> {
  // Source selection mirrors the story path's reasoning (`renderVariant` above): the
  // preview only ever needs a small, flat-budget image, so it prefers the thumbnail and
  // never touches the (possibly huge) original; print wants the best available source for
  // the slot's quality tier (`photoAssetRenditionNeeds` — width-aware since the justified
  // row stacks: any slot wider than the ~1600px display rendition serves at 300 dpi
  // prints from the original), falling back down the chain on a decode failure (e.g.
  // HEIC) rather than dropping the photo. Both the tier and the per-slot pixel budget
  // replay the renderer's exact row math via the photos' real dimensions.
  const dims: PhotoDimsById = new Map(
    loaded.photos
      .filter((p): p is typeof p & { width: number; height: number } => !!p.width && !!p.height)
      .map((p) => [p.assetId, { width: p.width, height: p.height }]),
  );
  const renditionNeeds = photoAssetRenditionNeeds(plan, trim, dims);
  const printTargets = variant === 'print' ? photoAssetPrintTargetSizeMm(plan, trim, dims) : null;

  const srcCache = new Map<string, string>();
  async function embed(photo: PhotoBookPhotoRef): Promise<PhotoLayoutImage | null> {
    if (!photo.width || !photo.height) return null;
    const cacheKey = `${photo.assetId}:${variant}`;
    let src = srcCache.get(cacheKey);
    if (!src) {
      const level = renditionNeeds.get(photo.assetId) ?? 'thumb';
      const sources =
        variant === 'preview'
          ? [photo.thumbS3Key ?? photo.s3Key]
          : level === 'display'
            ? [photo.s3Key, ...(photo.displayS3Key ? [photo.displayS3Key] : []), ...(photo.thumbS3Key ? [photo.thumbS3Key] : [])]
            : [photo.displayS3Key ?? photo.s3Key, ...(photo.thumbS3Key ? [photo.thumbS3Key] : [])];
      let lastError: unknown;
      for (const key of sources) {
        try {
          const buffer = await getObjectBuffer(key);
          src =
            variant === 'preview'
              ? await photoDataUri(buffer, 'preview')
              : await photoBookPrintDataUri(buffer, printTargets?.get(photo.assetId) ?? { w: trim.w, h: trim.h });
          break;
        } catch (e) {
          lastError = e;
          if (key !== sources[sources.length - 1]) {
            console.warn(`[book-render] ${key} failed, trying next source:`, e);
          }
        }
      }
      if (!src) {
        console.error(`[book-render] skipping photo ${photo.s3Key}:`, lastError);
        return null;
      }
      srcCache.set(cacheKey, src);
    }
    return { assetId: photo.assetId, src, width: photo.width, height: photo.height };
  }

  const byId = new Map(loaded.photos.map((p) => [p.assetId, p]));
  const needed = referencedPhotoAssetIds(plan);
  const resolved = new Map<string, PhotoLayoutImage>();
  for (const id of needed) {
    const photo = byId.get(id);
    if (!photo || photo.excluded) continue;
    const img = await embed(photo);
    if (img) resolved.set(id, img);
  }

  const html = renderPhotoBookHtml({
    variant,
    chronicleName,
    trim,
    plan,
    images: resolved,
    fontFaceCss: embeddedFontFaceCss(plan.style),
    createdLabel: new Date().toLocaleDateString('de-DE', { year: 'numeric', month: 'long' }),
    watermarkText: 'VORSCHAU · PREVIEW',
  });

  return htmlToPdf(browser, html);
}

/** The photo-book counterpart of the story path in `renderBook` above: rebuild the plan
 *  (backfilling any missing photo dimensions first, like the story path does), render
 *  `preview`/`print` through the SAME Chromium instance, pad both to Gelato's page-count
 *  rules, store, and flip status — identical shape and end state
 *  (`preview_ready`/`render_failed`, `pageCount`/`previewS3Key`/`printS3Key`) as a story
 *  book's render, so every other part of the app (order screen, status poll, download
 *  route) treats a rendered photo book exactly like a rendered story book. */
async function renderPhotoBook(bookId: string): Promise<void> {
  const loaded = await loadPhotoBook(bookId);
  await backfillPhotoBookDimensionsFromOriginals(loaded.photos);
  const plan = await loadOrBuildPhotoPlan(bookId, loaded);

  const [chron] = await db
    .select({ name: chronicles.name })
    .from(chronicles)
    .where(eq(chronicles.id, loaded.row.chronicleId))
    .limit(1);
  const chronicleName = chron?.name ?? 'Familienwerk';
  const trim = TRIM[loaded.row.format] ?? TRIM['hardcover-21x28'];

  const { preview, print } = await withChromium(`render photo book ${bookId}`, async (browser) => ({
    preview: await renderPhotoBookVariant(browser, loaded, plan, chronicleName, trim, 'preview'),
    print: await renderPhotoBookVariant(browser, loaded, plan, chronicleName, trim, 'print'),
  }));

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
