import { type Browser } from 'puppeteer';
import { withChromium } from '@/lib/chromium';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { books, chronicles } from '@/db/schema';
import { deleteObject, getObjectBuffer, putObjectBuffer } from '@/lib/s3';
import { env } from '@/lib/env';
import { MIN_PAGES, MAX_PAGES, getGelatoCoverDimensions, productUidForFormat } from '@/lib/gelato';
import { assembleGelatoPdf, countGelatoInnerPages, renderCoverSpreadHtml } from '@/lib/book-print-file';
import { TRIM } from '@/lib/book-content';
import { renderPhotoBookHtml, type PhotoLayoutImage } from '@/lib/photo-book-layout';
import {
  backfillPhotoBookDimensionsFromOriginals,
  loadOrBuildPhotoPlan,
  loadPhotoBook,
  photoAssetPrintTargetSizeMm,
  photoAssetRenditionNeeds,
  referencedPhotoAssetIds,
  storyParagraphMap,
  type LoadedPhotoBook,
  type PhotoBookPhotoRef,
  type PhotoDimsById,
  type PrintTargetSizeMm,
} from '@/lib/photo-book-content';
import { embeddedFontFaceCss } from '@/lib/photo-book-fonts';
import { photoBookTemplate, type PhotoBookPlan } from '@/lib/photo-book-plan';

/**
 * The worker side of book rendering: load content, build/refresh the layout plan,
 * embed photos, print the plan to two proof PDFs (low-res watermarked preview +
 * print-ready with bleed), pad both to Gelato's page rules, assemble the Gelato print
 * file the printer actually gets (`lib/book-print-file.ts`), store all three in S3, and
 * update the book row.
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
async function padPdf(pdf: Buffer): Promise<Buffer> {
  const doc = await PDFDocument.load(pdf);
  let count = doc.getPageCount();
  if (count > MAX_PAGES) {
    // Not fatal for a proof; the order screen surfaces the limit to the user.
    console.warn(`[book-render] ${count} pages exceeds Gelato max of ${MAX_PAGES}`);
  }
  const { width, height } = doc.getPage(count - 1).getSize();
  const target = Math.max(MIN_PAGES, count + (count % 2));
  while (count < target) {
    doc.addPage([width, height]);
    count++;
  }
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

/** Sets `html` as a Chromium page's content and prints it to a PDF buffer — the one
 *  low-level step shared by every render, story or photo. All images (and, for photo
 *  books, fonts) are inline `data:`/embedded, so 'load' means the page is fully ready to
 *  print; nothing here waits on the network.
 *
 * Birthday Books opt into the same bundled Paged.js engine used by the live preview.
 * Chromium's native printer treats `break-before: left` as a plain page break and does
 * not insert a parity sheet; Paged.js implements the paged-media rule and therefore
 * keeps every story on the promised verso page in both the proof and final print PDFs. */
async function htmlToPdf(browser: Browser, html: string, paginate: boolean = false): Promise<Buffer> {
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 120_000 });
    if (paginate) {
      await page.evaluate(() => {
        (window as typeof window & { PagedConfig?: { auto: boolean } }).PagedConfig = { auto: false };
      });
      await page.addScriptTag({
        path: join(process.cwd(), 'node_modules/pagedjs/dist/paged.polyfill.min.js'),
      });
      await page.evaluate(async () => {
        await (
          window as typeof window & { PagedPolyfill: { preview: () => Promise<unknown> } }
        ).PagedPolyfill.preview();
      });
    }
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

/** The `render-book` job: render, pad, store, and flip the book's status. One path for
 *  every book since the legacy story engine was retired — kept as a named export so the
 *  worker's queue registration reads by intent rather than by implementation. */
export async function renderBook(bookId: string): Promise<void> {
  await renderPhotoBook(bookId);
}

/* ──────────────────────────────────────────────────────────────────────────
 * The renderer: load the book's content and plan, embed its photos at the right
 * resolution for the variant, print two PDFs, pad to Gelato's page rules, store both.
 * ────────────────────────────────────────────────────────────────────────── */

// The low-res preview PDF uses `photoDataUri(.., 'preview')` — a flat 640px budget
// (`PHOTO_WIDTH.preview`) regardless of
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

/** Fetches the best available source for one photo and returns it as an embeddable `data:`
 *  URI, walking down the rendition chain (original → display → thumbnail) on a decode
 *  failure rather than dropping the photo. Split out of `renderPhotoBookVariant` below so
 *  the Gelato cover spread can re-embed the hero at ITS size (the wraparound is wider and
 *  taller than a single page) through exactly the same source selection.
 *  Returns null when every source failed. */
async function embedPhotoDataUri(
  photo: PhotoBookPhotoRef,
  variant: 'preview' | 'print',
  level: 'display' | 'thumb',
  targetMm: PrintTargetSizeMm,
): Promise<string | null> {
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
      return variant === 'preview'
        ? await photoDataUri(buffer, 'preview')
        : await photoBookPrintDataUri(buffer, targetMm);
    } catch (e) {
      lastError = e;
      if (key !== sources[sources.length - 1]) {
        console.warn(`[book-render] ${key} failed, trying next source:`, e);
      }
    }
  }
  console.error(`[book-render] skipping photo ${photo.s3Key}:`, lastError);
  return null;
}

/** The month-and-year line the cover/back cover prints ("März 2026"). */
function printCreatedLabel(): string {
  return new Date().toLocaleDateString('de-DE', { year: 'numeric', month: 'long' });
}

async function renderPhotoBookVariant(
  browser: Browser,
  loaded: LoadedPhotoBook,
  plan: PhotoBookPlan,
  chronicleName: string,
  trim: { w: number; h: number },
  variant: 'preview' | 'print',
): Promise<{ pdf: Buffer; images: Map<string, PhotoLayoutImage> }> {
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

  const byId = new Map(loaded.photos.map((p) => [p.assetId, p]));
  const needed = referencedPhotoAssetIds(plan);
  const resolved = new Map<string, PhotoLayoutImage>();
  for (const id of needed) {
    const photo = byId.get(id);
    if (!photo || photo.excluded || !photo.width || !photo.height) continue;
    const src = await embedPhotoDataUri(
      photo,
      variant,
      renditionNeeds.get(id) ?? 'thumb',
      printTargets?.get(id) ?? { w: trim.w, h: trim.h },
    );
    if (src) resolved.set(id, { assetId: id, src, width: photo.width, height: photo.height });
  }

  const html = renderPhotoBookHtml({
    variant,
    chronicleName,
    trim,
    plan,
    images: resolved,
    fontFaceCss: embeddedFontFaceCss(plan.style),
    storyParagraphs: storyParagraphMap(loaded),
    dedication: loaded.row.dedication,
    createdLabel: printCreatedLabel(),
    watermarkText: 'VORSCHAU · PREVIEW',
  });

  return {
    pdf: await htmlToPdf(browser, html, photoBookTemplate(plan) === 'birthday'),
    images: resolved,
  };
}

/**
 * The Gelato print file for this book (`lib/book-print-file.ts`): asks Gelato how big the
 * wraparound cover is at this inner page count, prints that spread through the same
 * browser as the rest of the render, and stitches it onto the inner pages of the UNPADDED
 * print PDF.
 *
 * Never throws and never fails the render: a book with no Gelato key, no product UID for
 * its (size, binding) combination, or a cover-dimensions call that errored simply has no
 * orderable file this time (`gelatoS3Key` = null) — the human proofs are unaffected.
 */
async function buildGelatoPrintFile(
  browser: Browser,
  input: {
    bookId: string;
    loaded: LoadedPhotoBook;
    plan: PhotoBookPlan;
    chronicleName: string;
    printPdf: Buffer;
    innerPageCount: number;
    /** The print variant's already-embedded photos — reused for the back cover, with the
     *  hero re-embedded at the (larger) wraparound size below. */
    printImages: Map<string, PhotoLayoutImage>;
  },
): Promise<Buffer | null> {
  const { bookId, loaded, plan } = input;
  const productUid = productUidForFormat(loaded.row.format, loaded.row.coverType);
  if (!env.GELATO_API_KEY || !productUid) {
    console.warn(
      `[book-render] ${bookId}: no Gelato ${!env.GELATO_API_KEY ? 'API key' : `product for ${loaded.row.format}/${loaded.row.coverType}`} — skipping the print file`,
    );
    return null;
  }
  if (input.innerPageCount > MAX_PAGES) {
    // Gelato only prints 30-200 inner pages, and their cover-dimensions endpoint rejects
    // anything outside that — asking would just be an error. No print file this render;
    // the order screen tells the user the book is too long.
    console.warn(
      `[book-render] ${bookId}: ${input.innerPageCount} inner pages exceeds Gelato's max of ${MAX_PAGES} — skipping the print file`,
    );
    return null;
  }
  try {
    const dims = await getGelatoCoverDimensions(productUid, input.innerPageCount);

    // A standard hero covers the whole front panel AND its wrap. Birthday photos each
    // occupy only one collage cell; sizing all six like full-panel heroes would make
    // Chromium decode hundreds of unnecessary megapixels on the worker.
    const images = new Map(input.printImages);
    const birthday = photoBookTemplate(plan) === 'birthday';
    const coverIds = plan.cover.assetIds?.length
      ? plan.cover.assetIds
      : plan.cover.heroAssetId
        ? [plan.cover.heroAssetId]
        : [];
    const birthdayCell = (() => {
      if (!birthday) return null;
      const count = Math.max(1, coverIds.length);
      const widthFraction = count === 1 ? 1 : count === 2 || count === 4 || count === 5 ? 0.55 : 0.38;
      const heightFraction = count <= 3 ? 0.8 : 0.5;
      return {
        w: (dims.spread.width - dims.contentFrontSize.left) * widthFraction,
        h: dims.spread.height * heightFraction,
      };
    })();
    for (const coverId of coverIds) {
      const photo = loaded.photos.find((p) => p.assetId === coverId);
      if (!photo?.width || !photo.height) continue;
      const src = await embedPhotoDataUri(
        photo,
        'print',
        'display',
        birthdayCell ?? {
          w: dims.spread.width - dims.contentFrontSize.left,
          h: dims.spread.height,
        },
      );
      if (src) images.set(coverId, { assetId: coverId, src, width: photo.width, height: photo.height });
    }

    const spreadPdf = await htmlToPdf(
      browser,
      renderCoverSpreadHtml({
        dims,
        plan,
        chronicleName: input.chronicleName,
        createdLabel: printCreatedLabel(),
        fontFaceCss: embeddedFontFaceCss(plan.style),
        images,
      }),
    );
    const { pdf } = await assembleGelatoPdf({ coverSpreadPdf: spreadPdf, printPdf: input.printPdf });
    return pdf;
  } catch (e) {
    console.error(`[book-render] ${bookId}: Gelato print file not built:`, e);
    return null;
  }
}

/** Rebuild the plan (backfilling any missing photo dimensions first), render
 *  `preview`/`print` through the SAME Chromium instance, pad both to Gelato's page-count
 *  rules, build the Gelato print file on top of the print render, store all three, and
 *  flip status.
 *
 *  Three files come out of one render:
 *   - `preview.pdf` — low-res, watermarked proof for the builder.
 *   - `print.pdf` — full-resolution proof a human can flip through: front cover, back
 *     cover, then the inner pages.
 *   - `gelato.pdf` — the actual order file (`lib/book-print-file.ts`): wraparound cover
 *     spread, blank endpaper, inner pages, blank endpaper. Absent when it couldn't be
 *     built (no Gelato key/product, or their cover-dimensions call failed) — that never
 *     fails the render, it only means the book can't be ordered until the next one.
 *
 *  `books.page_count` is the Gelato file's INNER page count (no covers, no endpapers) —
 *  the number Gelato prices and prints. */
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

  // All three renders share ONE browser session (see `withChromium`: acquisitions are
  // serialized process-wide, so opening a second session here would just queue behind
  // this one and pay another launch).
  const rendered = await withChromium(`render photo book ${bookId}`, async (browser) => {
    const preview = await renderPhotoBookVariant(browser, loaded, plan, chronicleName, trim, 'preview');
    const print = await renderPhotoBookVariant(browser, loaded, plan, chronicleName, trim, 'print');
    // The inner page count — everything except the two cover pages, padded to Gelato's
    // ≥30/even rule. It sizes the cover spread (the spine grows with it), so it has to be
    // known before the cover-dimensions call.
    let innerPageCount: number | null = null;
    try {
      innerPageCount = await countGelatoInnerPages(print.pdf);
    } catch (e) {
      console.error(`[book-render] ${bookId}: no inner page count:`, e);
    }
    const gelato =
      innerPageCount == null
        ? null
        : await buildGelatoPrintFile(browser, {
            bookId,
            loaded,
            plan,
            chronicleName,
            printPdf: print.pdf,
            innerPageCount,
            printImages: print.images,
          });
    return { preview: preview.pdf, print: print.pdf, innerPageCount, gelato };
  });

  const printPadded = await padPdf(rendered.print);
  const previewPadded = await padPdf(rendered.preview);

  const previewKey = `books/${bookId}/preview.pdf`;
  const printKey = `books/${bookId}/print.pdf`;
  const gelatoKey = `books/${bookId}/gelato.pdf`;
  await putObjectBuffer(previewKey, previewPadded, 'application/pdf');
  await putObjectBuffer(printKey, printPadded, 'application/pdf');
  if (rendered.gelato) {
    await putObjectBuffer(gelatoKey, rendered.gelato, 'application/pdf');
  } else {
    // `gelatoS3Key` is cleared below, but the OBJECT from an earlier render would still be
    // sitting there, laid out for a different page count. Nothing should be able to reach
    // it — drop it so a stale print file can't be printed by accident.
    try {
      await deleteObject(gelatoKey);
    } catch (e) {
      console.warn(`[book-render] ${bookId}: could not remove the stale Gelato file:`, e);
    }
  }

  await db
    .update(books)
    .set({
      status: 'preview_ready',
      errorMessage: null,
      // The INNER page count of the Gelato file — what pricing and ordering use. Known
      // even when the Gelato file itself couldn't be built (it comes from our own print
      // PDF), so the order screen still quotes the right number of pages.
      pageCount: rendered.innerPageCount,
      previewS3Key: previewKey,
      printS3Key: printKey,
      // Null when this render couldn't build one: a key from an EARLIER render would
      // point at a file laid out for a different page count, which Gelato would happily
      // print wrong.
      gelatoS3Key: rendered.gelato ? gelatoKey : null,
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
