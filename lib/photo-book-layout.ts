import type { PhotoBookPlan, PhotoPagePlan } from '@/lib/photo-book-plan';
import { PHOTO_STYLE_TOKENS, type PhotoStyleTokens } from '@/lib/photo-book-styles';
import { PAGEDJS_POLYFILL_URL } from '@/lib/pagedjs';

/**
 * Photo-book typesetting: pure HTML/CSS generation, the photo-book counterpart of
 * `lib/book-layout.ts`'s `renderBookHtml`. Three variants, mirroring the story-book
 * renderer's split:
 *  - `screen` — the live builder preview (`app/api/books/[bookId]/preview-html/route.ts`),
 *    served straight to the browser and paginated client-side by Paged.js. No bleed, no
 *    watermark (an auth-gated editing surface, not a distributable file).
 *  - `preview` — the low-res, watermarked PDF the worker's `render-book` photo branch
 *    produces (`lib/book-render.ts`). No bleed (same reasoning as `screen`: it's a proof,
 *    not a print file).
 *  - `print` — the full-resolution, print-ready PDF: `BLEED_MM` of bleed on every edge,
 *    `@page` sized to trim + bleed, no watermark.
 *
 * All three variants use the SAME element-box bleed mechanism: a single unnamed
 * `@page { margin: 0 }` for the whole document, with every page element carrying its own
 * explicit `width`/`height` (and, for content-box pages, its own `padding`) — see the
 * `@page` rule and the `.photo-page:not(.pb-divider-page)` rule below.
 * This used to differ between `screen` (element-box) and `preview`/`print` (CSS named
 * `@page` overrides per bleed page) because Chromium's `page.pdf()` doesn't fully honor a
 * named-page margin override on the trailing edges (right/bottom fell ~20-27mm short of the
 * sheet edge, confirmed by measuring rendered PDFs) — see the `@page` rule below for the
 * full story.
 *
 * Keeping this file free of I/O (like `book-layout.ts`) makes layout changes reviewable
 * and unit-testable: the renderer never decides *what* goes on a page (that's the
 * `PhotoBookPlan`, `lib/photo-book-plan.ts`) and never resolves an image or a font itself
 * — callers resolve the plan's assetIds to embeddable image `src`s (presigned S3 URLs for
 * `screen`, `data:` URIs for `preview`/`print` — see `lib/book-render.ts`) and a variant-
 * appropriate `@font-face` CSS block (`lib/photo-book-fonts.ts`'s `screenFontFaceCss` for
 * `screen`, `embeddedFontFaceCss` for `preview`/`print`), and hand it all to
 * `renderPhotoBookHtml`.
 */

export type PhotoLayoutVariant = 'screen' | 'preview' | 'print';

export interface PhotoLayoutImage {
  assetId: string;
  src: string;
  width: number;
  height: number;
}

export interface PhotoLayoutInput {
  variant: PhotoLayoutVariant;
  chronicleName: string;
  /** Trim size in millimetres — reuses `TRIM` from `lib/book-content.ts` (both book kinds
   *  share the same format list). */
  trim: { w: number; h: number };
  plan: PhotoBookPlan;
  /** Resolved image for every assetId the plan references (`referencedPhotoAssetIds`,
   *  `lib/photo-book-content.ts`) — a missing entry (photo not yet presignable, e.g. no
   *  dimensions) is rendered as an empty slot rather than crashing the page. */
  images: Map<string, PhotoLayoutImage>;
  /** `@font-face` rule text for the plan's style suite — `screenFontFaceCss`/
   *  `embeddedFontFaceCss` from `lib/photo-book-fonts.ts`, chosen by the caller per
   *  variant (see the module header). Injected verbatim into the `<style>` block. */
  fontFaceCss: string;
  createdLabel: string;
  watermarkText?: string;
}

/** 3 mm bleed on every edge for the `print` variant — same value as `lib/book-layout.ts`'s
 *  own `BLEED_MM` (kept as a separate constant, not imported, so this file stays free of
 *  any dependency on the story-book renderer); exported so `lib/photo-book-content.ts`'s
 *  print-embedding size calculation (`photoAssetPrintTargetSizeMm`) can size each photo to
 *  EXACTLY the physical box it will render into, not an approximation. */
export const PHOTO_BOOK_BLEED_MM = 3;

/** The page's content-box margins (trim edge, `screen`/`preview`; before adding bleed for
 *  `print`) — exported for the same reason as `PHOTO_BOOK_BLEED_MM`: the print-embedding
 *  size calculation needs the exact content-box dimensions these margins carve out of the
 *  page, so a photo is downscaled to precisely the pixels its slot will print at 300 dpi,
 *  never more (bounding worker memory) and never less (bounding visible upscaling). */
export const PHOTO_BOOK_CONTENT_MARGIN_MM = { top: 14, bottom: 16, inner: 16, outer: 14 } as const;

const esc = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** Emits the `:root { --pb-*: …; }` block a style suite's tokens resolve to — same
 *  approach as `themeVarsCss` in `lib/book-layout.ts`. */
function styleVarsCss(s: PhotoStyleTokens): string {
  return `
  :root {
    --pb-font-heading: ${s.fontHeading};
    --pb-font-body: ${s.fontBody};
    --pb-color-text: ${s.colorText};
    --pb-color-muted: ${s.colorMuted};
    --pb-page-bg: ${s.pageBg};
    --pb-cover-bg: ${s.coverBg};
    --pb-cover-heading-color: ${s.coverHeadingColor};
    --pb-cover-muted-color: ${s.coverMutedColor};
    --pb-cover-back-bg: ${s.coverBackBg};
    --pb-cover-back-text-color: ${s.coverBackTextColor};
    --pb-divider-bg: ${s.dividerBg};
    --pb-divider-text-color: ${s.dividerTextColor};
    --pb-photo-mat: ${s.photoMatMm}mm;
    --pb-photo-radius: ${s.photoRadius};
    --pb-photo-shadow: ${s.photoShadow};
    --pb-photo-frame-border: ${s.photoFrameBorder ? `0.3mm solid ${s.photoFrameBorder}` : 'none'};
    --pb-caption-color: ${s.captionColor};
    --pb-divider-ornament-display: ${s.dividerOrnament ? 'block' : 'none'};
    --pb-photo-tape-display: ${s.photoTape ? 'block' : 'none'};
    --pb-photo-tape-color: ${s.photoTapeColor ?? 'rgba(200, 200, 200, 0.6)'};
  }`;
}

function img(image: PhotoLayoutImage | undefined, cls: string): string {
  if (!image) return `<div class="${cls} ph-missing"></div>`;
  return `<img class="${cls}" src="${image.src}" alt="" style="aspect-ratio: ${image.width} / ${image.height}" />`;
}

/** Renders one `page.captions[i]` entry, or nothing when it's absent/null/empty — the
 *  AI design pass (`lib/photo-book-ai-layout.ts`) is the only producer that ever fills
 *  `captions` (the deterministic auto-layouter never does), and even it leaves most
 *  photos uncaptioned, so this is the common case everywhere `withCaption`/`framedFigure`
 *  call it. */
function captionEl(caption: string | null | undefined): string {
  if (!caption) return '';
  return `<p class="ph-caption">${esc(caption)}</p>`;
}

/** Wraps a photo's markup with an optional caption underneath it, in a flex column that
 *  lets the photo shrink to make room. Crucially, the `.ph-cell` wrapper (and the CSS
 *  that makes the photo flexible instead of a hardcoded 100% height) only appears in the
 *  output when a caption is actually present — a caption-less photo's markup is byte-
 *  for-byte what it was before captions existed, so plans without captions (i.e. every
 *  plan the auto-layouter ever produces) render exactly as before. */
function withCaption(photoHtml: string, caption: string | null | undefined): string {
  if (!caption) return photoHtml;
  return `<div class="ph-cell">${photoHtml}${captionEl(caption)}</div>`;
}

function framedFigure(image: PhotoLayoutImage | undefined, caption?: string | null): string {
  return withCaption(`<div class="ph-frame">${img(image, 'ph-frame-img')}</div>`, caption);
}

/** The page's content box in mm — what a content-box page's photos may fill. */
interface ContentBox {
  w: number;
  h: number;
}

/** Uniform gap between photos, horizontal and vertical (mm) — one value for the whole
 *  book, whatever the arrangement, so every page reads as the same grid system. */
const PHOTO_GAP_MM = 4;

/** Aspect ratio stood in for a photo the caller couldn't resolve (`ph-missing`) — the
 *  placeholder tile still has to occupy a plausible slot in the row math. */
const MISSING_ASPECT = 4 / 3;

interface RowPhoto {
  image?: PhotoLayoutImage;
  caption?: string | null;
}

function aspectOf(p: RowPhoto): number {
  return p.image ? p.image.width / p.image.height : MISSING_ASPECT;
}

/**
 * A stack of justified photo rows — the one mechanism behind every multi-photo template
 * (and the reason none of them crop): within a row, every photo renders at one shared
 * height with its width equal to `aspect × height`, so the row fills the content-box
 * width exactly, uncropped, whatever the orientation mix (the math: width_i = a_i · h and
 * Σ width_i = W − gaps means h is the row's single free variable). Rows are stacked and
 * vertically centered; when the stack's natural height exceeds the content box (e.g. a
 * dominant square over two portraits), every row is scaled down by the same factor and
 * stays horizontally centered — photos shrink, they never crop.
 *
 * Sized deterministically here in mm, not with CSS percentage/stretch tricks: a
 * stretched cell whose aspect ratio differs from its photo's forces `object-fit: cover`
 * to crop — exactly the "half the photo is missing" defect this renderer replaced.
 */
function rowStackHtml(rows: RowPhoto[][], box: ContentBox): string {
  const naturalHeights = rows.map((row) => {
    const gaps = (row.length - 1) * PHOTO_GAP_MM;
    const aspectSum = row.reduce((sum, p) => sum + aspectOf(p), 0);
    return (box.w - gaps) / aspectSum;
  });
  const gapsH = (rows.length - 1) * PHOTO_GAP_MM;
  const totalH = naturalHeights.reduce((a, b) => a + b, 0) + gapsH;
  const scale = totalH > box.h ? (box.h - gapsH) / (totalH - gapsH) : 1;

  const rowsHtml = rows
    .map((row, r) => {
      const h = naturalHeights[r] * scale;
      const cells = row
        .map((p) => {
          const w = aspectOf(p) * h;
          const photo = p.image ? img(p.image, 'ph-jimg') : `<div class="ph-jimg ph-missing"></div>`;
          return `<div class="ph-jcell" style="width: ${w.toFixed(2)}mm">${withCaption(photo, p.caption)}</div>`;
        })
        .join('\n');
      return `<div class="ph-jrow" style="height: ${h.toFixed(2)}mm">${cells}</div>`;
    })
    .join('\n');
  return `<div class="ph-rows">${rowsHtml}</div>`;
}

/** Renders a multi-photo template as its row arrangement (see `rowStackHtml`). */
function rowStackPage(
  page: PhotoPagePlan,
  images: Map<string, PhotoLayoutImage>,
  rowSizes: number[],
  box: ContentBox,
  withCaptions: boolean,
): string {
  const rows: RowPhoto[][] = [];
  let offset = 0;
  for (const size of rowSizes) {
    rows.push(
      page.assetIds.slice(offset, offset + size).map((id, i) => ({
        image: images.get(id),
        caption: withCaptions ? page.captions?.[offset + i] : null,
      })),
    );
    offset += size;
  }
  return `
      <section class="page photo-page pb-rows-page">
        ${rowStackHtml(rows.filter((r) => r.length > 0), box)}
      </section>`;
}

function renderPage(page: PhotoPagePlan, images: Map<string, PhotoLayoutImage>, box: ContentBox): string {
  const get = (id: string) => images.get(id);
  switch (page.template) {
    case 'full-bleed': {
      // One photo filling the entire content box — inside the same page frame as every
      // other page (the margins are the book's constant frame; a photo page doesn't get
      // to break it). Filling the box means a slight crop to its aspect ratio, which is
      // why this template is reserved for photos whose shape roughly matches the page.
      // A caption (when present) overlays the bottom on a scrim rather than pushing
      // content below it — same treatment the cover front uses for its title.
      const caption = page.captions?.[0];
      return `
      <section class="page photo-page pb-fullbleed">
        <div class="pb-fullbleed-inner">
          ${img(get(page.assetIds[0]), 'ph-fullbleed-img')}
          ${caption ? `<div class="ph-fullbleed-caption"><p>${esc(caption)}</p></div>` : ''}
        </div>
      </section>`;
    }
    case 'full-framed': {
      return `
      <section class="page photo-page pb-framed">
        <div class="pb-framed-inner">${framedFigure(get(page.assetIds[0]), page.captions?.[0])}</div>
      </section>`;
    }
    // Every multi-photo template is a justified row stack (see rowStackHtml) — photos
    // render at their true aspect ratios, never cropped:
    case 'two-vertical':
      // Side-by-side pair sharing one height.
      return rowStackPage(page, images, [2], box, true);
    case 'three-column':
      // Three side by side in one row — only sensible when all three are portrait.
      return rowStackPage(page, images, [3], box, true);
    case 'two-horizontal':
      // Two stacked full-width rows.
      return rowStackPage(page, images, [1, 1], box, true);
    case 'three-mixed':
      // One dominant photo across the top + a justified pair below it.
      return rowStackPage(page, images, [1, 2], box, true);
    case 'four-mixed':
      // One dominant photo across the top + a justified trio below it.
      return rowStackPage(page, images, [1, 3], box, true);
    case 'collage-4':
      // 2×2 mosaic as two justified rows. No captions — 4 small tiles have no room for
      // per-photo text (the AI design pass is told the same — see CAPTION_LESS_TEMPLATES).
      return rowStackPage(page, images, [2, 2], box, false);
    case 'collage-5':
      // Two justified rows of 2 + 3 — same caption reasoning as collage-4.
      return rowStackPage(page, images, [2, 3], box, false);
    case 'collage-6':
      // Two justified rows of 3 — the densest page the vocabulary allows.
      return rowStackPage(page, images, [3, 3], box, false);
    case 'divider': {
      // The auto-layouter never emits a `divider` page (it opens sections with a hero
      // photo instead — see `lib/photo-book-autolayout.ts`), but the template exists for
      // PR3/PR4 producers, so the renderer supports it: a muted photo behind the title.
      // Any `page.captions` here are intentionally not rendered — a divider is the
      // section-title page (see `.pb-divider`'s own `<h2>`/`dateLabel` above), not a
      // photo page, so a per-photo caption would compete with the title it's already
      // showing.
      const id = page.assetIds[0];
      const image = id ? get(id) : undefined;
      return `
      <section class="page photo-page pb-divider-page">
        ${image ? img(image, 'ph-divider-bg') : ''}
      </section>`;
    }
    default:
      return '';
  }
}

export function renderPhotoBookHtml(input: PhotoLayoutInput): string {
  const style = PHOTO_STYLE_TOKENS[input.plan.style];
  // Bleed only applies to `print`: `screen` is never printed, and `preview` is a proof,
  // not the binding print file — same split as `lib/book-layout.ts`'s `renderBookHtml`.
  // Bleed pages (cover front/back, divider) bleed to the physical page
  // edge in EVERY variant via their own explicit full-sheet `width`/`height` and no CSS
  // margin (the base `@page` rule below is a single unnamed `margin: 0` for every variant);
  // what changes for `print` is that the physical page itself grows by `PHOTO_BOOK_BLEED_MM`
  // on every edge, so those pages extend 3mm past the trim line the way a real bleed setup
  // needs.
  // Bleed pages are the cover front/back and the section dividers — full-sheet colored/
  // photo backdrops. Interior PHOTO pages (including the `full-bleed` template) all live
  // inside the shared content-box frame: the book keeps one constant border on every
  // photo page, whatever the arrangement.
  const bleed = input.variant === 'print' ? PHOTO_BOOK_BLEED_MM : 0;
  const pageW = input.trim.w + bleed * 2;
  const pageH = input.trim.h + bleed * 2;
  // Inner margins are measured from the TRIM edge; bleed is added on top — mirrors
  // `renderBookHtml`'s `m` so a content-box page's physical content area is identical
  // between variants (only the bleed pages around it grow).
  const m = {
    top: PHOTO_BOOK_CONTENT_MARGIN_MM.top + bleed,
    bottom: PHOTO_BOOK_CONTENT_MARGIN_MM.bottom + bleed,
    inner: PHOTO_BOOK_CONTENT_MARGIN_MM.inner + bleed,
    outer: PHOTO_BOOK_CONTENT_MARGIN_MM.outer + bleed,
  };
  // Watermark only on `preview` — the low-res PDF proof. Never on `screen` (an
  // auth-gated live-editing surface, not a distributable file) and never on `print` (the
  // full-resolution, order-ready PDF must be clean) — same rule as `renderBookHtml`.
  const watermark =
    input.variant === 'preview'
      ? `<div class="watermark">${esc(input.watermarkText ?? 'PREVIEW')}</div>`
      : '';

  // Body padding above/below the page stack in the screen chrome, below — kept small and
  // fixed (not scaled by the zoom `fitPages` applies to `.pagedjs_pages`, since padding is
  // on `body` itself) so it barely eats into the "one full page" fit budget; `fitPages`
  // subtracts it explicitly rather than approximating, so the fitted page's shadow is
  // never clipped by the iframe's own edge.
  const screenBodyPadMm = 4;

  const pagedScript =
    input.variant === 'screen'
      ? `
  <script>
    (function () {
      var PAGE_W_PX = ${pageW} * 96 / 25.4;
      var PAGE_H_PX = ${pageH} * 96 / 25.4;
      var BODY_PAD_PX = ${screenBodyPadMm} * 2 * 96 / 25.4;
      // Fit ONE full page inside the iframe's own viewport — both axes, not just width —
      // so the builder shows a whole page rather than a native-size crop of its top-left
      // corner. The host page (photo-book-create-step.tsx) sizes the iframe box to this
      // same trim aspect ratio, so in practice width- and height-fit agree almost exactly;
      // taking the min of both keeps this correct even when they don't (e.g. a very short
      // viewport), same "contain" logic as an image's object-fit: contain.
      function fitPages() {
        var pages = document.querySelector('.pagedjs_pages');
        if (!pages) return;
        var availW = document.documentElement.clientWidth - 16;
        var availH = document.documentElement.clientHeight - BODY_PAD_PX;
        // A zero/negative viewport means this document is laid out inside a hidden or
        // not-yet-sized box (an iframe in a display:none panel, a closed drawer). Zooming
        // by 0 would scale the whole book to nothing and — since nothing re-runs this
        // unless the viewport changes again — leave a permanently blank preview. Better to
        // keep the last good zoom and wait for a real size.
        if (availW <= 0 || availH <= 0) return;
        pages.style.zoom = Math.min(1, availW / PAGE_W_PX, availH / PAGE_H_PX);
      }
      window.PagedConfig = {
        auto: true,
        after: function () {
          fitPages();
          document.documentElement.setAttribute('data-pagedjs-ready', 'true');
        },
      };
      window.addEventListener('resize', fitPages);
      // A resize event alone isn't enough: an iframe that gains a layout box (its
      // container stops being display:none) doesn't reliably fire one in every browser.
      // Observing the root element covers that case and costs nothing.
      if (typeof ResizeObserver === 'function') {
        new ResizeObserver(fitPages).observe(document.documentElement);
      }
    })();
  </script>
  <script src="${PAGEDJS_POLYFILL_URL}"></script>`
      : '';

  const screenChrome =
    input.variant === 'screen'
      ? `
  html, body { background: #d7d9dd; }
  body { padding: ${screenBodyPadMm}mm 0; }
  .pagedjs_pages { display: flex; flex-direction: column; align-items: center; gap: 8mm; }
  .pagedjs_page { background: #fff; box-shadow: 0 3mm 10mm rgba(15, 15, 20, 0.28); }`
      : '';

  // Cover front — always a bleed page (edge-to-edge hero photo).
  const coverHero = input.plan.cover.heroAssetId ? input.images.get(input.plan.cover.heroAssetId) : undefined;
  const coverFront = `
    <section class="page pb-cover-front">
      ${coverHero ? img(coverHero, 'ph-cover-bg-img') : ''}
      <div class="pb-cover-text">
        <h1>${esc(input.plan.cover.title)}</h1>
        ${input.plan.cover.subtitle ? `<p class="pb-cover-subtitle">${esc(input.plan.cover.subtitle)}</p>` : ''}
        <p class="pb-cover-chronicle">${esc(input.chronicleName)}</p>
      </div>
    </section>`;

  // Cover back — the auto-layouter never fills `backAssetIds` in PR2 (see
  // `lib/photo-book-autolayout.ts`'s header), so most books render a photo-free,
  // suite-designed back panel; a future producer's back photos still render if present.
  const backImages = (input.plan.cover.backAssetIds ?? []).map((id) => input.images.get(id)).filter(Boolean);
  const coverBack = `
    <section class="page pb-cover-back">
      ${
        backImages.length > 0
          ? `<div class="pb-cover-back-photos">${backImages
              .map((image) => `<div class="ph-frame">${img(image, 'ph-frame-img')}</div>`)
              .join('\n')}</div>`
          : ''
      }
      <p class="pb-cover-back-text">${esc(input.chronicleName)} · ${esc(input.createdLabel)}</p>
    </section>`;

  // The content box a content-box page's photos may fill — the padded area the
  // `.photo-page:not(.pb-divider-page)` rule below carves out of the physical sheet
  // (the `+ 1` mirrors that rule's 1mm pagination-safety fudge on the bottom padding).
  const contentBox: ContentBox = {
    w: pageW - m.inner - m.outer,
    h: pageH - m.top - (m.bottom + 1),
  };

  const sectionsHtml = input.plan.sections
    .map((section) => {
      const divider = `
      <section class="page pb-divider">
        <p class="pb-divider-kicker">${esc(input.chronicleName)}</p>
        <h2>${esc(section.title)}</h2>
        ${section.dateLabel ? `<p class="pb-divider-date">${esc(section.dateLabel)}</p>` : ''}
      </section>`;

      const pages = section.pages.map((page) => renderPage(page, input.images, contentBox)).join('\n');

      return `${divider}\n${pages}`;
    })
    .join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
${input.fontFaceCss}
${styleVarsCss(style)}
  @page {
    size: ${pageW}mm ${pageH}mm;
    /* Single unnamed @page rule, margin 0, for every variant -- element-box bleed
       approach: EVERY page (bleed or content-box) sizes itself to the full physical
       sheet (width/height = pageW/pageH) with no CSS margin, so it reaches every edge;
       content-box pages (.photo-page:not(.pb-divider-page), below)
       then inset their own content via PADDING = m instead, which insets them from the
       physical edge by the content margin (screen/preview) or content margin + bleed
       (print) -- see that rule's own comment for why padding, not margin. This used to
       be a named @page ident block with
       margin 0 per bleed page for preview/print -- removed because Chromium's
       page.pdf() does not fully honor a named-page margin override on the TRAILING
       edges: measured right/bottom bleed fell ~20-27mm short of the sheet edge while
       left/top reached it. A single unnamed @page with margin 0 bleeds correctly on
       all four edges, and is also what the screen variant's Paged.js polyfill needs
       (it can't reliably paginate a document using many scattered named @page rules --
       confirmed by reproducing it headlessly: pagination stalled after the first
       page). So all three variants now share this one mechanism. */
    margin: 0;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: var(--pb-font-body);
    font-size: 10.5pt;
    line-height: 1.5;
    color: var(--pb-color-text);
  }

  .page { page-break-after: always; background: var(--pb-page-bg); }

  /* ---- Cover front/back: always edge-to-edge ---- */
  .pb-cover-front, .pb-cover-back {
    width: ${pageW}mm; height: ${pageH}mm;
    position: relative;
    overflow: hidden;
    display: flex;
  }
  .pb-cover-front { background: var(--pb-cover-bg); align-items: flex-end; }
  .ph-cover-bg-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .pb-cover-text {
    position: relative;
    padding: 14mm 16mm 18mm;
    color: var(--pb-cover-heading-color);
    background: ${input.plan.cover.heroAssetId ? 'linear-gradient(transparent, rgba(0,0,0,0.55) 55%)' : 'none'};
    ${input.plan.cover.heroAssetId ? 'color: #fff;' : ''}
    width: 100%;
  }
  .pb-cover-text h1 { font-family: var(--pb-font-heading); font-size: 26pt; margin: 0 0 3mm; font-weight: 700; }
  .pb-cover-subtitle { font-size: 12.5pt; margin: 0 0 3mm; opacity: 0.85; }
  .pb-cover-chronicle { font-size: 9.5pt; letter-spacing: 0.1em; font-variant: small-caps; margin: 0; opacity: 0.75; }

  .pb-cover-back {
    background: var(--pb-cover-back-bg);
    color: var(--pb-cover-back-text-color);
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8mm;
  }
  .pb-cover-back-photos { display: flex; gap: 6mm; }
  .pb-cover-back-photos .ph-frame { width: 40mm; height: 50mm; }
  .pb-cover-back-text { font-size: 9pt; letter-spacing: 0.05em; }

  /* ---- Section divider: also edge-to-edge ---- */
  .pb-divider {
    width: ${pageW}mm; height: ${pageH}mm;
    background: var(--pb-divider-bg);
    color: var(--pb-divider-text-color);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 0 16mm;
  }
  .pb-divider-kicker { font-size: 9pt; letter-spacing: 0.14em; font-variant: small-caps; opacity: 0.7; margin: 0 0 4mm; }
  .pb-divider h2 { font-family: var(--pb-font-heading); font-size: 22pt; margin: 0 0 2mm; }
  /* Ornamental divider flourish (heirloom): a plain hairline rule above/below the
     section title — on for every suite with dividerOrnament: true, off (display: none)
     otherwise, so this rule is a no-op for every other suite. */
  .pb-divider h2::before, .pb-divider h2::after {
    content: '';
    display: var(--pb-divider-ornament-display);
    width: 16mm;
    height: 0.3mm;
    margin: 3mm auto;
    background: currentColor;
    opacity: 0.5;
  }
  .pb-divider-date { font-size: 11pt; opacity: 0.75; margin: 0; }
  /* A bleed page like .pb-fullbleed: it must be the full sheet size, otherwise it
     collapses to height:0 (its only child .ph-divider-bg is position:absolute/inset:0,
     which can't give the parent a height) and renders as a blank page. Reachable in
     production when a chat/manual edit empties a page's last photo — GENERIC_TEMPLATE_
     FOR_COUNT (lib/photo-book-ops.ts) maps a 0-photo page to the "divider" template. */
  .pb-divider-page { width: ${pageW}mm; height: ${pageH}mm; position: relative; }
  .ph-divider-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0.5; }

  /* ---- Content-box pages (framed / grids): full-sheet box, inset via PADDING ----
     Deliberately padding, not margin: every .page forces a break after itself, so
     every content-box page immediately follows a forced page break -- and Chromium's
     print/PDF engine truncates an element's own top MARGIN right after a forced break
     (confirmed by rendering: a margin-based box measured 0mm top inset instead of the
     intended ~17mm, with the lost space reappearing as extra whitespace at the
     bottom). Padding isn't a forced-break casualty and doesn't collapse, so sizing the
     box to the full physical sheet (matching the bleed pages' own width/height) and
     insetting the content via padding keeps the exact same content-box geometry
     (background-clip: content-box keeps the painted background restricted to the
     original content area, so the padding strip -- visually the old margin area --
     stays unpainted, exactly like before). The '+ 1' on bottom padding preserves the
     old contentH's longstanding 1mm pagination-safety fudge. */
  .photo-page:not(.pb-divider-page) {
    width: ${pageW}mm;
    height: ${pageH}mm;
    padding: ${m.top}mm ${m.outer}mm ${m.bottom + 1}mm ${m.inner}mm;
    background-clip: content-box;
  }
  /* full-bleed: one photo filling the whole CONTENT box — it sits inside the same page
     frame (the padding above) as every other photo page, so the book keeps one constant
     border everywhere; "bleed" survives only in the template's stored name. The inner
     wrapper exists because the caption scrim needs a positioning context that matches
     the photo box, not the padded sheet. */
  .pb-fullbleed-inner { position: relative; width: 100%; height: 100%; overflow: hidden; }
  .ph-fullbleed-img { width: 100%; height: 100%; object-fit: cover; display: block; border-radius: var(--pb-photo-radius); }
  .ph-missing { background: repeating-linear-gradient(45deg, #eee, #eee 8px, #f6f6f6 8px, #f6f6f6 16px); }

  /* full-bleed caption: overlaid on a bottom scrim (the photo fills its whole box, so
     there's no room to put text below it) — same gradient-over-photo idea as the
     cover front's title treatment above. */
  .ph-fullbleed-caption {
    position: absolute;
    left: 0; right: 0; bottom: 0;
    padding: 10mm 14mm 8mm;
    background: linear-gradient(transparent, rgba(0, 0, 0, 0.6) 60%);
  }
  .ph-fullbleed-caption p { margin: 0; color: #fff; font-size: 10pt; font-style: italic; line-height: 1.4; }

  /* Optional per-photo captions (AI design pass only — the auto-layouter never emits
     them, so a caption-less plan never emits this markup at all — see withCaption()).
     '.ph-cell' turns a photo's normal 100%-height box into a flex column so the photo
     can shrink and leave room for the caption beneath it; '> *:first-child' reaches
     whatever's actually in there (an img element, or full-framed's already-matted
     '.ph-frame' div) and overrides its fixed height with 'flex: 1', at higher
     specificity than any of '.ph-cover-img' / '.ph-row-img' / '.ph-frame''s own
     'height: 100%' rules — those rules stay untouched for every caption-less photo,
     which is the vast majority. */
  .ph-cell { display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; }
  .ph-cell > *:first-child { flex: 1 1 0%; min-height: 0; height: auto; }
  .ph-caption {
    flex: 0 0 auto;
    margin: 1.5mm 0 0;
    font-size: 8pt;
    line-height: 1.35;
    font-style: italic;
    text-align: center;
    color: var(--pb-caption-color);
  }

  /* full-framed: one photo, matted per the style suite */
  .pb-framed { display: flex; align-items: center; justify-content: center; }
  .pb-framed-inner { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
  .ph-frame {
    position: relative;
    box-sizing: border-box;
    background: var(--pb-page-bg);
    padding: var(--pb-photo-mat);
    border: var(--pb-photo-frame-border);
    box-shadow: var(--pb-photo-shadow);
    border-radius: var(--pb-photo-radius);
    width: 100%;
    height: 100%;
  }
  /* Washi-tape accent (journal): a small rotated strip pinned across the top edge of the
     mat — on for every suite with photoTape: true, off (display: none) otherwise, so
     this rule is a no-op for every other suite. */
  .ph-frame::before {
    content: '';
    display: var(--pb-photo-tape-display);
    position: absolute;
    top: -4mm;
    left: 50%;
    width: 18mm;
    height: 7mm;
    margin-left: -9mm;
    background: var(--pb-photo-tape-color);
    box-shadow: 0 0.5mm 1mm rgba(0, 0, 0, 0.15);
    transform: rotate(-3deg);
  }
  .ph-frame-img { width: 100%; height: 100%; object-fit: contain; display: block; border-radius: var(--pb-photo-radius); }

  /* Every multi-photo template: a stack of justified rows (see rowStackHtml). Row
     heights and cell widths arrive as exact inline mm values computed from the photos'
     real aspect ratios, so 'cover' below never actually crops (cell aspect == photo
     aspect) — it only absorbs the tiny shrink a caption steals from its cell. Rows and
     the stack are centered so any spare space frames the arrangement symmetrically. */
  .ph-rows {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: ${PHOTO_GAP_MM}mm;
  }
  .ph-jrow { display: flex; justify-content: center; gap: ${PHOTO_GAP_MM}mm; flex: 0 0 auto; }
  .ph-jcell { height: 100%; }
  .ph-jimg { width: 100%; height: 100%; object-fit: cover; display: block; border-radius: var(--pb-photo-radius); }

  .watermark {
    position: fixed;
    top: 42%; left: 0; right: 0;
    text-align: center;
    transform: rotate(-28deg);
    font-size: 46pt;
    letter-spacing: 0.2em;
    color: rgba(140, 150, 165, 0.18);
    font-weight: 700;
    z-index: 10;
    pointer-events: none;
  }
${screenChrome}
</style>
${pagedScript}
</head>
<body>
${watermark}
${coverFront}
${coverBack}
${sectionsHtml}
</body>
</html>`;
}
