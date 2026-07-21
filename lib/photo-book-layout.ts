import type { PhotoBookPlan, PhotoPagePlan, PhotoPageTemplate } from '@/lib/photo-book-plan';
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

/** One figure of a justified row: the flex share equals the image's aspect ratio, same
 *  math as `rowFigureHtml` in `lib/book-layout.ts` — every image in the row renders at
 *  the SAME height while the row fills the full width, whatever the orientation mix. */
function rowFigure(image: PhotoLayoutImage | undefined, caption?: string | null): string {
  if (!image) return `<div class="ph-row-figure ph-missing" style="flex: 1 1 0%"></div>`;
  const aspect = (image.width / image.height).toFixed(4);
  return `<div class="ph-row-figure" style="flex: ${aspect} 1 0%">${withCaption(img(image, 'ph-row-img'), caption)}</div>`;
}

function framedFigure(image: PhotoLayoutImage | undefined, caption?: string | null): string {
  return withCaption(`<div class="ph-frame">${img(image, 'ph-frame-img')}</div>`, caption);
}

/** Renders the `page: <ident>` inline style declaration a bleed section needs to pick up
 *  its matching named `@page` rule — or nothing at all when `name` is falsy, which is
 *  always the case for `screen` (see `nextBleedPageName`'s comment): an empty `style="page:
 *  "` attribute is invalid CSS, so this must be all-or-nothing, not just an empty value. */
function pageStyleAttr(name: string): string {
  return name ? ` style="page: ${name}"` : '';
}

function renderPage(page: PhotoPagePlan, images: Map<string, PhotoLayoutImage>, pageNamed: string): string {
  const get = (id: string) => images.get(id);
  switch (page.template) {
    case 'full-bleed': {
      // Bleeds edge to edge, so a caption (when present) overlays the bottom on a
      // scrim rather than pushing content below it — same treatment the cover front
      // uses for its title over `coverHero` (`.pb-cover-text`'s gradient, below).
      const caption = page.captions?.[0];
      return `
      <section class="page photo-page pb-fullbleed"${pageStyleAttr(pageNamed)}>
        ${img(get(page.assetIds[0]), 'ph-fullbleed-img')}
        ${caption ? `<div class="ph-fullbleed-caption"><p>${esc(caption)}</p></div>` : ''}
      </section>`;
    }
    case 'full-framed': {
      return `
      <section class="page photo-page pb-framed">
        <div class="pb-framed-inner">${framedFigure(get(page.assetIds[0]), page.captions?.[0])}</div>
      </section>`;
    }
    case 'two-vertical': {
      // Two portraits side by side, justified to share one height across full width.
      return `
      <section class="page photo-page pb-row">
        ${page.assetIds.map((id, i) => rowFigure(get(id), page.captions?.[i])).join('\n')}
      </section>`;
    }
    case 'two-horizontal': {
      // Two landscapes stacked, each filling the width in its own half of the page.
      return `
      <section class="page photo-page pb-stack-2">
        ${page.assetIds
          .map((id, i) => `<div class="ph-stack-cell">${withCaption(img(get(id), 'ph-cover-img'), page.captions?.[i])}</div>`)
          .join('\n')}
      </section>`;
    }
    case 'three-column': {
      return `
      <section class="page photo-page pb-row">
        ${page.assetIds.map((id, i) => rowFigure(get(id), page.captions?.[i])).join('\n')}
      </section>`;
    }
    case 'three-mixed': {
      const [dominant, ...rest] = page.assetIds;
      const [dominantCaption, ...restCaptions] = page.captions ?? [];
      return `
      <section class="page photo-page pb-mixed-3">
        <div class="ph-dominant">${withCaption(img(get(dominant), 'ph-cover-img'), dominantCaption)}</div>
        <div class="ph-mixed-stack">
          ${rest
            .map((id, i) => `<div class="ph-stack-cell">${withCaption(img(get(id), 'ph-cover-img'), restCaptions[i])}</div>`)
            .join('\n')}
        </div>
      </section>`;
    }
    case 'collage-4': {
      // Dense mosaic, no captions — mirrors `.photo-grid figcaption { display: none }`
      // in `lib/book-layout.ts`: 4 small tiles have no room for per-photo text without
      // crowding the grid (the AI design pass is told the same thing — see the "not on
      // dense collages" line in `lib/photo-book-ai-layout.ts`'s system prompt).
      return `
      <section class="page photo-page pb-collage-4">
        ${page.assetIds.map((id) => `<div class="ph-tile">${img(get(id), 'ph-cover-img')}</div>`).join('\n')}
      </section>`;
    }
    case 'collage-5': {
      // Same reasoning as collage-4 — 5 tiles is even denser.
      const [dominant, ...rest] = page.assetIds;
      return `
      <section class="page photo-page pb-collage-5">
        <div class="ph-dominant">${img(get(dominant), 'ph-cover-img')}</div>
        <div class="ph-collage-5-grid">
          ${rest.map((id) => `<div class="ph-tile">${img(get(id), 'ph-cover-img')}</div>`).join('\n')}
        </div>
      </section>`;
    }
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
      <section class="page photo-page pb-divider-page"${pageStyleAttr(pageNamed)}>
        ${image ? img(image, 'ph-divider-bg') : ''}
      </section>`;
    }
    default:
      return '';
  }
}

/** Every distinct page (across the whole book) gets its own generated CSS named-page
 *  identifier so full-bleed / divider pages can be margin:0 (bleeding to the physical
 *  edge) while framed/grid pages keep the normal content margin — `@page :first` (used
 *  by the story renderer) only reaches page ONE, but a photo book has many bleed pages
 *  scattered throughout, so this uses CSS's named-page mechanism instead
 *  (`page: <ident>` on the element, a matching `@page <ident> { margin: 0 }` rule).
 *
 *  ONLY for `preview`/`print`: those render through Chromium's own native paged-media
 *  engine (`page.pdf()` in `lib/book-render.ts`), which implements CSS named pages
 *  correctly. The `screen` variant is paginated client-side by the self-hosted Paged.js
 *  *polyfill* instead, and that polyfill cannot reliably reflow a document that uses many
 *  scattered named `@page` rules — confirmed by reproducing it headlessly: pagination
 *  stalls after the first page and Paged.js's own repeated-layout guard clones the same
 *  page over and over (`Layout repeated at:` in the console) instead of erroring cleanly.
 *  So for `screen`, `renderPhotoBookHtml` below skips named pages entirely: the base
 *  `@page` rule's margin is 0 for every page, and each bleed section relies on its own
 *  explicit `width`/`height` (already set to the full sheet size, no CSS margin) to reach
 *  the edge, while content-box pages keep filling the same inset via their own `margin`/
 *  `width`/`height` (`.photo-page:not(.pb-fullbleed):not(.pb-divider-page)`, below) —
 *  the exact same visual result, just without any `@page <ident>` selector for the
 *  polyfill to choke on. */
function pageNameFor(kind: string, index: number): string {
  return `pb-${kind}-${index}`;
}

export function renderPhotoBookHtml(input: PhotoLayoutInput): string {
  const style = PHOTO_STYLE_TOKENS[input.plan.style];
  // Bleed only applies to `print`: `screen` is never printed, and `preview` is a proof,
  // not the binding print file — same split as `lib/book-layout.ts`'s `renderBookHtml`.
  // Bleed pages (cover front/back, full-bleed photo, divider) bleed to the physical page
  // edge in every variant via the named `@page { margin: 0 }` rules below; what changes
  // for `print` is that the physical page itself grows by `PHOTO_BOOK_BLEED_MM` on every
  // edge, so those pages extend 3mm past the trim line the way a real bleed setup needs.
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
  const contentW = pageW - m.inner - m.outer;
  const contentH = pageH - m.top - m.bottom - 1;

  // `screen` never emits named `@page` rules (see `pageNameFor`'s comment above) — its
  // bleed pages reach the edge via the base `@page` rule's margin being 0 for every page
  // instead, so `nextBleedPageName` is a no-op there: it returns '' (renderPage/the cover
  // and divider markup below treat a falsy name as "no `page:` declaration needed") and
  // never grows `namedBleedPages`, so `namedPageRules` ends up empty too.
  const isScreen = input.variant === 'screen';
  const namedBleedPages: string[] = [];
  let bleedPageCounter = 0;
  function nextBleedPageName(): string {
    if (isScreen) return '';
    const name = pageNameFor('bleed', bleedPageCounter++);
    namedBleedPages.push(name);
    return name;
  }

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

  // Cover front — always a named bleed page (edge-to-edge hero photo).
  const coverFrontName = nextBleedPageName();
  const coverHero = input.plan.cover.heroAssetId ? input.images.get(input.plan.cover.heroAssetId) : undefined;
  const coverFront = `
    <section class="page pb-cover-front"${pageStyleAttr(coverFrontName)}>
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
  const coverBackName = nextBleedPageName();
  const backImages = (input.plan.cover.backAssetIds ?? []).map((id) => input.images.get(id)).filter(Boolean);
  const coverBack = `
    <section class="page pb-cover-back"${pageStyleAttr(coverBackName)}>
      ${
        backImages.length > 0
          ? `<div class="pb-cover-back-photos">${backImages
              .map((image) => `<div class="ph-frame">${img(image, 'ph-frame-img')}</div>`)
              .join('\n')}</div>`
          : ''
      }
      <p class="pb-cover-back-text">${esc(input.chronicleName)} · ${esc(input.createdLabel)}</p>
    </section>`;

  const sectionsHtml = input.plan.sections
    .map((section) => {
      const dividerName = nextBleedPageName();
      const divider = `
      <section class="page pb-divider"${pageStyleAttr(dividerName)}>
        <p class="pb-divider-kicker">${esc(input.chronicleName)}</p>
        <h2>${esc(section.title)}</h2>
        ${section.dateLabel ? `<p class="pb-divider-date">${esc(section.dateLabel)}</p>` : ''}
      </section>`;

      const pages = section.pages
        .map((page) => {
          const bleeds: PhotoPageTemplate[] = ['full-bleed', 'divider'];
          const pageName = bleeds.includes(page.template) ? nextBleedPageName() : '';
          return renderPage(page, input.images, pageName);
        })
        .join('\n');

      return `${divider}\n${pages}`;
    })
    .join('\n');

  const namedPageRules = namedBleedPages.map((name) => `@page ${name} { margin: 0; }`).join('\n  ');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
${input.fontFaceCss}
${styleVarsCss(style)}
  @page {
    size: ${pageW}mm ${pageH}mm;
    /* screen: base margin is always 0 -- every page (bleed or content-box) sizes and
       insets itself via its own element CSS instead (see pageNameFor's comment above),
       since named @page rules are what the Paged.js polyfill can't reliably paginate.
       preview/print: base margin is the content-box inset; bleed pages override it
       to 0 via their own named @page rule (namedPageRules, below) -- real CSS paged
       media, rendered by Chromium's native engine, which supports this fine. */
    margin: ${isScreen ? '0' : `${m.top}mm ${m.outer}mm ${m.bottom}mm ${m.inner}mm`};
  }
  ${namedPageRules}
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
  .pb-divider-page { position: relative; }
  .ph-divider-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0.5; }

  /* ---- Content-box pages (framed / grids): normal margin, fill it symmetrically ---- */
  .photo-page:not(.pb-fullbleed):not(.pb-divider-page) {
    width: ${contentW}mm;
    height: ${contentH}mm;
    margin: ${m.top}mm ${m.outer}mm ${m.bottom}mm ${m.inner}mm;
  }
  .pb-fullbleed { width: ${pageW}mm; height: ${pageH}mm; position: relative; }
  .ph-fullbleed-img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .ph-missing { background: repeating-linear-gradient(45deg, #eee, #eee 8px, #f6f6f6 8px, #f6f6f6 16px); }

  /* full-bleed caption: overlaid on a bottom scrim (the photo bleeds edge to edge, so
     there's no margin to put text in below it) — same gradient-over-photo idea as the
     cover front's title treatment above. */
  .ph-fullbleed-caption {
    position: absolute;
    left: 0; right: 0; bottom: 0;
    padding: 10mm 14mm 8mm;
    background: linear-gradient(transparent, rgba(0, 0, 0, 0.6) 60%);
  }
  .ph-fullbleed-caption p { margin: 0; color: #fff; font-size: 10pt; font-style: italic; line-height: 1.4; }

  .ph-cover-img { width: 100%; height: 100%; object-fit: cover; display: block; border-radius: var(--pb-photo-radius); }

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

  /* two-vertical / three-column: a justified row sharing one height (see rowFigure).
     A caption (when present) arrives already wrapped in '.ph-cell' by withCaption(), so
     it gets the same flex-shrink-to-make-room treatment as every other template — the
     caption-less path below ('.ph-row-img' direct child, 'height: 100%') is untouched. */
  .pb-row { display: flex; align-items: stretch; gap: 4mm; }
  .ph-row-figure { min-width: 0; }
  .ph-row-img { width: 100%; height: 100%; object-fit: cover; display: block; border-radius: var(--pb-photo-radius); }

  /* two-horizontal: two landscapes stacked, each filling its half */
  .pb-stack-2 { display: flex; flex-direction: column; gap: 4mm; }
  .ph-stack-cell { flex: 1; min-height: 0; }

  /* three-mixed: one dominant + a stacked pair */
  .pb-mixed-3 { display: flex; gap: 4mm; }
  .ph-dominant { flex: 2; min-width: 0; }
  .ph-mixed-stack { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4mm; }

  /* collage-4: a flat 2x2 */
  .pb-collage-4 { display: flex; flex-wrap: wrap; gap: 4mm; }
  .pb-collage-4 .ph-tile { width: calc(50% - 2mm); height: calc(50% - 2mm); }

  /* collage-5: one dominant + a 2x2 of the rest */
  .pb-collage-5 { display: flex; gap: 4mm; }
  .pb-collage-5 .ph-dominant { flex: 1; min-width: 0; }
  .ph-collage-5-grid { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: 4mm; }
  .ph-collage-5-grid .ph-tile { width: calc(50% - 2mm); height: calc(50% - 2mm); }

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
