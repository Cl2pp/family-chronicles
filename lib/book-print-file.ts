import { PDFDocument } from 'pdf-lib';
import { MAX_PAGES, MIN_PAGES, type GelatoCoverArea, type GelatoCoverDimensions } from '@/lib/gelato';
import {
  birthdayCoverCollageHtml,
  esc,
  img,
  styleVarsCss,
  PHOTO_BOOK_COVER_PAGE_COUNT,
  type PhotoLayoutImage,
} from '@/lib/photo-book-layout';
import { PHOTO_STYLE_TOKENS } from '@/lib/photo-book-styles';
import { photoBookTemplate, type PhotoBookPlan } from '@/lib/photo-book-plan';

/**
 * The Gelato PRINT FILE — the one PDF a real print order is submitted with, as opposed to
 * the human-readable proofs (`preview.pdf`/`print.pdf`) `lib/book-render.ts` also produces.
 *
 * Gelato takes a photo book as a single file (`type: 'default'`) laid out like this:
 *
 *   page 1            wraparound cover SPREAD — back panel | spine | front panel on one
 *                     wide page, sized by Gelato's cover-dimensions endpoint for this
 *                     book's inner page count (`getGelatoCoverDimensions`)
 *   page 2            blank endpaper (not printed)
 *   pages 3 … n-1     the inner pages, single pages, trim + 3mm bleed
 *   page n            blank endpaper (not printed)
 *
 * and the `pageCount` submitted with the order (and used for the price quote) counts the
 * INNER pages only — 30-200, even. That is also what `books.page_count` means.
 *
 * Two halves, both pure (no I/O, no DB, no Chromium):
 *  - `renderCoverSpreadHtml` builds the spread's HTML document. The caller prints it to a
 *    one-page PDF through the same Chromium instance as the rest of the render.
 *  - `assembleGelatoPdf` stitches that spread page together with the inner pages of the
 *    UNPADDED `print` PDF (dropping its two cover pages, which the spread replaces) and
 *    the two blank endpapers, using pdf-lib only.
 *
 * Anything outside the content panels of the spread (the wraparound flap that folds over
 * the board, plus the joints/hinges next to the spine) is visible-but-unreliable area: it
 * gets background colour or a photo bleeding into it, never text.
 */

/** A spine narrower than this has no room for legible type (and binding tolerances make a
 *  thin spine's text drift onto the front or back board), so it stays blank. */
const SPINE_TEXT_MIN_WIDTH_MM = 5;

/** Type on the spine, in mm: as tall as the spine allows, within these bounds. */
const SPINE_FONT_MIN_MM = 2.1;
const SPINE_FONT_MAX_MM = 4.2;

/** Clear space kept at each end of the spine, so the type can't run into the head/tail. */
const SPINE_END_MARGIN_MM = 10;

/** How far the front cover's title block stays inside the front panel. Gelato's own safe
 *  area is smaller, but a hardcover's boards are wrapped by hand and the joint sits just
 *  outside this panel — 8mm keeps the title clear of both. */
const FRONT_TEXT_INSET_MM = 8;

const mm = (n: number) => `${n.toFixed(2)}mm`;

/** The number of inner pages a rendered inner block becomes once Gelato's rules are
 *  applied: at least MIN_PAGES, always even. Pure — `lib/books.ts`'s pre-render estimate
 *  uses the same rule so the quote a user sees before rendering matches the file. */
export function gelatoInnerPageCount(renderedInnerPages: number): number {
  return Math.max(MIN_PAGES, renderedInnerPages + (renderedInnerPages % 2));
}

/** Which pages of the `print` PDF are inner pages, and how many the finished Gelato file
 *  will have. Throws when the document has nothing but its two cover pages — a book with
 *  no inner pages has no orderable print file, and silently padding 30 blank sheets would
 *  be worse than having no Gelato file at all. */
function inspectPrintPdf(doc: PDFDocument): { innerIndices: number[]; innerPageCount: number } {
  const total = doc.getPageCount();
  const rendered = total - PHOTO_BOOK_COVER_PAGE_COUNT;
  if (rendered <= 0) {
    throw new Error(`print PDF has ${total} pages — no inner pages to print`);
  }
  const innerPageCount = gelatoInnerPageCount(rendered);
  if (innerPageCount > MAX_PAGES) {
    // Not fatal here; the order screen surfaces the limit to the user.
    console.warn(`[book-print-file] ${innerPageCount} inner pages exceeds Gelato max of ${MAX_PAGES}`);
  }
  return {
    innerIndices: Array.from({ length: rendered }, (_, i) => i + PHOTO_BOOK_COVER_PAGE_COUNT),
    innerPageCount,
  };
}

/** How many inner pages the Gelato file built from this `print` PDF will have — the value
 *  that sizes the cover spread (the spine grows with the page count) and that goes into
 *  `books.page_count`, the quote and the order. Same number `assembleGelatoPdf` returns. */
export async function countGelatoInnerPages(printPdf: Buffer): Promise<number> {
  const doc = await PDFDocument.load(printPdf);
  return inspectPrintPdf(doc).innerPageCount;
}

/**
 * Builds the order-ready PDF: [cover spread] [blank endpaper] [inner pages, padded]
 * [blank endpaper]. `printPdf` is the UNPADDED `print` variant — its first
 * `PHOTO_BOOK_COVER_PAGE_COUNT` pages are the front and back cover, which the spread
 * replaces, and everything after them is inner content. Padding pages are blank and the
 * same size as the inner pages, and go at the END of the inner block (before the trailing
 * endpaper), where a real book's spare leaves are.
 */
export async function assembleGelatoPdf(input: {
  coverSpreadPdf: Buffer;
  printPdf: Buffer;
}): Promise<{ pdf: Buffer; innerPageCount: number }> {
  const printDoc = await PDFDocument.load(input.printPdf);
  const coverDoc = await PDFDocument.load(input.coverSpreadPdf);
  if (coverDoc.getPageCount() < 1) throw new Error('cover spread PDF has no pages');
  const { innerIndices, innerPageCount } = inspectPrintPdf(printDoc);

  const out = await PDFDocument.create();
  const [spread] = await out.copyPages(coverDoc, [0]);
  out.addPage(spread);

  const inner = await out.copyPages(printDoc, innerIndices);
  const { width, height } = inner[inner.length - 1].getSize();
  out.addPage([width, height]); // leading endpaper
  for (const page of inner) out.addPage(page);
  for (let i = inner.length; i < innerPageCount; i++) out.addPage([width, height]);
  out.addPage([width, height]); // trailing endpaper

  const bytes = await out.save();
  return { pdf: Buffer.from(bytes), innerPageCount };
}

/* ──────────────────────────────────────────────────────────────────────────
 * The cover spread
 * ────────────────────────────────────────────────────────────────────────── */

export interface CoverSpreadInput {
  /** Gelato's rectangles for THIS book at THIS inner page count, in mm, measured from the
   *  spread's top-left (`getGelatoCoverDimensions`). Back panel left, front panel right. */
  dims: GelatoCoverDimensions;
  plan: PhotoBookPlan;
  chronicleName: string;
  createdLabel: string;
  /** `@font-face` rules with the font bytes inlined — `embeddedFontFaceCss`, exactly like
   *  the print variant (Chromium renders this offline). */
  fontFaceCss: string;
  /** Resolved images for the cover's `heroAssetId`/`backAssetIds`; a missing entry renders
   *  as the same placeholder the page renderer uses. */
  images: Map<string, PhotoLayoutImage>;
  language?: string;
}

/** Spine type, or null when the spine is too thin for any. Kept separate from the HTML so
 *  the fitting rules are testable on their own. */
export function spineTextFor(input: {
  spine: GelatoCoverArea;
  title: string;
  chronicleName: string;
}): { text: string; fontMm: number } | null {
  const { spine } = input;
  if (spine.width < SPINE_TEXT_MIN_WIDTH_MM) return null;
  const title = input.title.trim();
  if (!title) return null;
  const fontMm = Math.min(SPINE_FONT_MAX_MM, Math.max(SPINE_FONT_MIN_MM, spine.width - 2.5));
  // Rough width-per-character for a mixed-case line at this size — enough to decide
  // whether the chronicle name still fits and where to truncate. Erring narrow would clip
  // (the spine box hides overflow), so this deliberately over-estimates a little.
  const perChar = fontMm * 0.55;
  const maxChars = Math.max(1, Math.floor((spine.height - SPINE_END_MARGIN_MM * 2) / perChar));
  const withChronicle = `${title} · ${input.chronicleName.trim()}`;
  if (input.chronicleName.trim() && withChronicle.length <= maxChars) {
    return { text: withChronicle, fontMm };
  }
  if (title.length <= maxChars) return { text: title, fontMm };
  return { text: `${title.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`, fontMm };
}

/** Absolutely positions a box on the spread from one of Gelato's rectangles. */
function areaStyle(a: GelatoCoverArea): string {
  return `left: ${mm(a.left)}; top: ${mm(a.top)}; width: ${mm(a.width)}; height: ${mm(a.height)};`;
}

/**
 * The wraparound cover as ONE page: back panel on the left, spine in the middle, front
 * panel on the right, all positioned at the exact mm rectangles Gelato returned.
 *
 * The two panel backgrounds deliberately extend PAST their rectangles to the spread's
 * outer edges (the back colour leftwards/up/down, the hero photo rightwards/up/down), so
 * the wrap that folds around the board carries the design instead of showing white paper —
 * while every piece of content (back-cover line, spine type, title block) stays inside its
 * panel, away from the joints.
 */
export function renderCoverSpreadHtml(input: CoverSpreadInput): string {
  const { dims, plan } = input;
  const style = PHOTO_STYLE_TOKENS[plan.style];
  const spread = dims.spread;
  const back = dims.contentBackSize;
  const front = dims.contentFrontSize;
  const birthday = photoBookTemplate(plan) === 'birthday';

  const hero = !birthday && plan.cover.heroAssetId ? input.images.get(plan.cover.heroAssetId) : undefined;
  const birthdayCoverIds = plan.cover.assetIds ?? (plan.cover.heroAssetId ? [plan.cover.heroAssetId] : []);
  const backImages = (plan.cover.backAssetIds ?? []).map((id) => input.images.get(id)).filter(Boolean);
  const spine = spineTextFor({ spine: dims.spineSize, title: plan.cover.title, chronicleName: input.chronicleName });

  // The back panel's colour owns everything to the LEFT of (and above/below) the back
  // panel; the front's hero owns everything to the RIGHT of the front panel's left edge.
  // Between them sit the joints and the spine, which keep the cover background colour.
  const backBleedWidth = back.left + back.width;
  const frontBleedWidth = spread.width - front.left;
  // The front half is ONE box (hero + title), sized to the bleed rather than to the panel,
  // so the title's dark scrim fades out past the spread's edges instead of ending in a
  // visible rectangle right where the board folds. The text is pushed back inside
  // `contentFrontSize` by padding: the wrap that lies outside the panel, plus the inset.
  const frontTextPad = {
    right: spread.width - (front.left + front.width) + FRONT_TEXT_INSET_MM,
    bottom: spread.height - (front.top + front.height) + FRONT_TEXT_INSET_MM + 4,
  };

  return `<!doctype html>
<html lang="${esc(input.language ?? 'de')}">
<head>
<meta charset="utf-8" />
<style>
${input.fontFaceCss}
${styleVarsCss(style)}
  @page {
    /* The spread is ONE page, exactly the size Gelato asked for — it already includes
       bleed/wraparound, so there is no margin to add here (same single unnamed
       margin-0 @page mechanism the inner pages use). */
    size: ${mm(spread.width)} ${mm(spread.height)};
    margin: 0;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: var(--pb-font-body); color: var(--pb-color-text); }
  .pb-spread {
    position: relative;
    width: ${mm(spread.width)};
    height: ${mm(spread.height)};
    overflow: hidden;
    background: var(--pb-cover-bg);
  }
  .pb-spread-layer { position: absolute; overflow: hidden; }

  /* Back half: the back-cover colour, run out to the left/top/bottom spread edges. */
  .pb-spread-back-bleed {
    left: 0; top: 0;
    width: ${mm(backBleedWidth)};
    height: ${mm(spread.height)};
    background: var(--pb-cover-back-bg);
  }
  .pb-spread-back {
    ${areaStyle(back)}
    color: var(--pb-cover-back-text-color);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8mm;
    padding: ${mm(FRONT_TEXT_INSET_MM)};
  }
  .pb-spread-back-photos { display: flex; gap: 6mm; }
  .pb-spread-back-photos .ph-frame {
    width: 40mm; height: 50mm;
    background: var(--pb-page-bg);
    padding: var(--pb-photo-mat);
    border: var(--pb-photo-frame-border);
    border-radius: var(--pb-photo-radius);
  }
  .pb-spread-back-text { font-size: 9pt; letter-spacing: 0.05em; margin: 0; text-align: center; }

  /* Front half: the hero photo covers the front panel and bleeds off the right/top/bottom
     spread edges; without a hero it is the cover background colour. */
  .pb-spread-front {
    left: ${mm(front.left)}; top: 0;
    width: ${mm(frontBleedWidth)};
    height: ${mm(spread.height)};
    background: var(--pb-cover-bg);
    display: flex;
    align-items: flex-end;
  }
  .pb-spread-hero { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .pb-spread-birthday-collage {
    position: absolute;
    left: ${mm(FRONT_TEXT_INSET_MM)};
    right: ${mm(frontTextPad.right)};
    top: ${mm(front.top + FRONT_TEXT_INSET_MM)};
    bottom: 45mm;
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    grid-auto-rows: minmax(0, 1fr);
    gap: 4mm;
  }
  .pb-birthday-cover-photo {
    grid-column: span 2;
    min-width: 0;
    min-height: 0;
    padding: 2.2mm;
    background: #fff;
    border: 0.3mm solid rgba(30, 36, 48, 0.18);
    box-shadow: 0 2mm 5mm rgba(20, 20, 20, 0.18);
    overflow: hidden;
  }
  .pb-spread-birthday-collage[data-count="1"] .pb-birthday-cover-photo { grid-column: span 6; }
  .pb-spread-birthday-collage[data-count="2"] .pb-birthday-cover-photo { grid-column: span 3; }
  .pb-spread-birthday-collage[data-count="4"] .pb-birthday-cover-photo { grid-column: span 3; }
  .pb-spread-birthday-collage[data-count="5"] .pb-birthday-cover-photo:nth-child(-n + 2) { grid-column: span 3; }
  .pb-birthday-cover-img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .pb-spread-front-text {
    position: relative;
    width: 100%;
    /* Right/bottom padding = the wrap outside the front panel + the safe inset, so every
       line sits inside contentFrontSize (${mm(front.width)} × ${mm(front.height)} at
       ${mm(front.left)}, ${mm(front.top)}) and clear of the joint on its left. */
    padding: 14mm ${mm(frontTextPad.right)} ${mm(frontTextPad.bottom)} ${mm(FRONT_TEXT_INSET_MM)};
    color: ${hero ? '#fff' : 'var(--pb-cover-heading-color)'};
    background: ${hero ? 'linear-gradient(transparent, rgba(0,0,0,0.55) 55%)' : 'none'};
  }
  .pb-spread-front-text h1 { font-family: var(--pb-font-heading); font-size: 26pt; margin: 0 0 3mm; font-weight: 700; }
  .pb-spread-subtitle { font-size: 12.5pt; margin: 0 0 3mm; opacity: 0.85; }
  .pb-spread-chronicle { font-size: 9.5pt; letter-spacing: 0.1em; font-variant: small-caps; margin: 0; opacity: 0.75; }
  .pb-spread-birthday-text {
    position: absolute;
    left: ${mm(FRONT_TEXT_INSET_MM)};
    right: ${mm(frontTextPad.right)};
    bottom: ${mm(frontTextPad.bottom)};
    width: auto;
    padding: 5mm 8mm;
    text-align: center;
    color: var(--pb-cover-heading-color);
    background: color-mix(in srgb, var(--pb-cover-bg) 92%, transparent);
  }
  .pb-spread-birthday-text .pb-spread-subtitle { margin-bottom: 0; color: var(--pb-cover-muted-color); }

  /* Spine: the cover colour with the title reading top-to-bottom (vertical-rl rotates
     Latin glyphs 90° clockwise, which is how European/US spines read on a shelf). */
  .pb-spread-spine {
    ${areaStyle(dims.spineSize)}
    background: var(--pb-cover-bg);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .pb-spread-spine span {
    writing-mode: vertical-rl;
    text-orientation: mixed;
    white-space: nowrap;
    font-family: var(--pb-font-heading);
    font-size: ${spine ? mm(spine.fontMm) : '0'};
    line-height: 1;
    letter-spacing: 0.02em;
    color: var(--pb-cover-heading-color);
  }
  .ph-frame-img { width: 100%; height: 100%; object-fit: contain; display: block; border-radius: var(--pb-photo-radius); }
  .ph-missing { background: repeating-linear-gradient(45deg, #eee, #eee 8px, #f6f6f6 8px, #f6f6f6 16px); }
</style>
</head>
<body>
<div class="pb-spread">
  <div class="pb-spread-layer pb-spread-back-bleed"></div>
  <div class="pb-spread-layer pb-spread-front">
    ${hero ? img(hero, 'pb-spread-hero') : ''}
    ${birthday ? birthdayCoverCollageHtml(birthdayCoverIds, input.images, 'pb-spread-birthday-collage') : ''}
    <div class="pb-spread-front-text${birthday ? ' pb-spread-birthday-text' : ''}">
      <h1>${esc(plan.cover.title)}</h1>
      ${
        birthday
          ? `<p class="pb-spread-subtitle">${esc(plan.cover.subtitle || input.createdLabel)}</p>`
          : `${plan.cover.subtitle ? `<p class="pb-spread-subtitle">${esc(plan.cover.subtitle)}</p>` : ''}
      <p class="pb-spread-chronicle">${esc(input.chronicleName)}</p>`
      }
    </div>
  </div>
  <div class="pb-spread-layer pb-spread-spine">
    ${spine ? `<span>${esc(spine.text)}</span>` : ''}
  </div>
  <div class="pb-spread-layer pb-spread-back">
    ${
      backImages.length > 0
        ? `<div class="pb-spread-back-photos">${backImages
            .map((image) => `<div class="ph-frame">${img(image, 'ph-frame-img')}</div>`)
            .join('\n')}</div>`
        : ''
    }
    <p class="pb-spread-back-text">${esc(input.chronicleName)} · ${esc(input.createdLabel)}</p>
  </div>
</div>
</body>
</html>`;
}
