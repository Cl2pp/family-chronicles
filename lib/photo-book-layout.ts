import type { PhotoBookPlan, PhotoPagePlan, PhotoPageTemplate } from '@/lib/photo-book-plan';
import { PHOTO_STYLE_TOKENS, type PhotoStyleTokens } from '@/lib/photo-book-styles';
import { PAGEDJS_POLYFILL_URL } from '@/lib/pagedjs';

/**
 * Photo-book typesetting: pure HTML/CSS generation, the photo-book counterpart of
 * `lib/book-layout.ts`'s `renderBookHtml`. PR2 only needs the `screen` variant working —
 * `app/api/books/[bookId]/preview-html/route.ts` serves it straight to the browser and
 * Paged.js paginates it client-side, exactly like the story book's live preview. `print`
 * is intentionally a thin pass-through of the same markup (no bleed math, no watermark
 * logic beyond what `screen` already needs) — the Chromium PDF render is PR5's
 * `render-book` photo branch; wiring it for real happens there. Keeping this file free of
 * I/O (like `book-layout.ts`) makes layout changes reviewable and unit-testable.
 *
 * The renderer never decides *what* goes on a page — it renders whatever the
 * `PhotoBookPlan` (`lib/photo-book-plan.ts`) says. Callers resolve the plan's assetIds to
 * embeddable image `src`s (presigned S3 URLs for `screen`) and hand both to
 * `renderPhotoBookHtml`.
 */

export type PhotoLayoutVariant = 'screen' | 'print';

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
  createdLabel: string;
  watermarkText?: string;
}

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
  }`;
}

function img(image: PhotoLayoutImage | undefined, cls: string): string {
  if (!image) return `<div class="${cls} ph-missing"></div>`;
  return `<img class="${cls}" src="${image.src}" alt="" style="aspect-ratio: ${image.width} / ${image.height}" />`;
}

/** One figure of a justified row: the flex share equals the image's aspect ratio, same
 *  math as `rowFigureHtml` in `lib/book-layout.ts` — every image in the row renders at
 *  the SAME height while the row fills the full width, whatever the orientation mix. */
function rowFigure(image: PhotoLayoutImage | undefined): string {
  if (!image) return `<div class="ph-row-figure ph-missing" style="flex: 1 1 0%"></div>`;
  const aspect = (image.width / image.height).toFixed(4);
  return `<div class="ph-row-figure" style="flex: ${aspect} 1 0%">${img(image, 'ph-row-img')}</div>`;
}

function framedFigure(image: PhotoLayoutImage | undefined): string {
  return `<div class="ph-frame">${img(image, 'ph-frame-img')}</div>`;
}

function renderPage(page: PhotoPagePlan, images: Map<string, PhotoLayoutImage>, pageNamed: string): string {
  const get = (id: string) => images.get(id);
  switch (page.template) {
    case 'full-bleed': {
      return `
      <section class="page photo-page pb-fullbleed" style="page: ${pageNamed}">
        ${img(get(page.assetIds[0]), 'ph-fullbleed-img')}
      </section>`;
    }
    case 'full-framed': {
      return `
      <section class="page photo-page pb-framed">
        <div class="pb-framed-inner">${framedFigure(get(page.assetIds[0]))}</div>
      </section>`;
    }
    case 'two-vertical': {
      // Two portraits side by side, justified to share one height across full width.
      return `
      <section class="page photo-page pb-row">
        ${page.assetIds.map((id) => rowFigure(get(id))).join('\n')}
      </section>`;
    }
    case 'two-horizontal': {
      // Two landscapes stacked, each filling the width in its own half of the page.
      return `
      <section class="page photo-page pb-stack-2">
        ${page.assetIds.map((id) => `<div class="ph-stack-cell">${img(get(id), 'ph-cover-img')}</div>`).join('\n')}
      </section>`;
    }
    case 'three-column': {
      return `
      <section class="page photo-page pb-row">
        ${page.assetIds.map((id) => rowFigure(get(id))).join('\n')}
      </section>`;
    }
    case 'three-mixed': {
      const [dominant, ...rest] = page.assetIds;
      return `
      <section class="page photo-page pb-mixed-3">
        <div class="ph-dominant">${img(get(dominant), 'ph-cover-img')}</div>
        <div class="ph-mixed-stack">
          ${rest.map((id) => `<div class="ph-stack-cell">${img(get(id), 'ph-cover-img')}</div>`).join('\n')}
        </div>
      </section>`;
    }
    case 'collage-4': {
      return `
      <section class="page photo-page pb-collage-4">
        ${page.assetIds.map((id) => `<div class="ph-tile">${img(get(id), 'ph-cover-img')}</div>`).join('\n')}
      </section>`;
    }
    case 'collage-5': {
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
      const id = page.assetIds[0];
      const image = id ? get(id) : undefined;
      return `
      <section class="page photo-page pb-divider-page" style="page: ${pageNamed}">
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
 *  (`page: <ident>` on the element, a matching `@page <ident> { margin: 0 }` rule). */
function pageNameFor(kind: string, index: number): string {
  return `pb-${kind}-${index}`;
}

export function renderPhotoBookHtml(input: PhotoLayoutInput): string {
  const style = PHOTO_STYLE_TOKENS[input.plan.style];
  const pageW = input.trim.w;
  const pageH = input.trim.h;
  const m = { top: 14, bottom: 16, inner: 16, outer: 14 };
  const contentW = pageW - m.inner - m.outer;
  const contentH = pageH - m.top - m.bottom - 1;

  const namedBleedPages: string[] = [];
  let bleedPageCounter = 0;
  function nextBleedPageName(): string {
    const name = pageNameFor('bleed', bleedPageCounter++);
    namedBleedPages.push(name);
    return name;
  }

  const watermark =
    input.variant === 'screen'
      ? `<div class="watermark">${esc(input.watermarkText ?? 'PREVIEW')}</div>`
      : '';

  const pagedScript =
    input.variant === 'screen'
      ? `
  <script>
    (function () {
      var PAGE_W_PX = ${pageW} * 96 / 25.4;
      function fitPages() {
        var pages = document.querySelector('.pagedjs_pages');
        if (!pages) return;
        var avail = document.documentElement.clientWidth - 16;
        pages.style.zoom = Math.min(1, avail / PAGE_W_PX);
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
  body { padding: 10mm 0 24mm; }
  .pagedjs_pages { display: flex; flex-direction: column; align-items: center; gap: 8mm; }
  .pagedjs_page { background: #fff; box-shadow: 0 3mm 10mm rgba(15, 15, 20, 0.28); }`
      : '';

  // Cover front — always a named bleed page (edge-to-edge hero photo).
  const coverFrontName = nextBleedPageName();
  const coverHero = input.plan.cover.heroAssetId ? input.images.get(input.plan.cover.heroAssetId) : undefined;
  const coverFront = `
    <section class="page pb-cover-front" style="page: ${coverFrontName}">
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
    <section class="page pb-cover-back" style="page: ${coverBackName}">
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
      <section class="page pb-divider" style="page: ${dividerName}">
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
${styleVarsCss(style)}
  @page {
    size: ${pageW}mm ${pageH}mm;
    margin: ${m.top}mm ${m.outer}mm ${m.bottom}mm ${m.inner}mm;
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
  .pb-divider-date { font-size: 11pt; opacity: 0.75; margin: 0; }
  .pb-divider-page { position: relative; }
  .ph-divider-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0.5; }

  /* ---- Content-box pages (framed / grids): normal margin, fill it symmetrically ---- */
  .photo-page:not(.pb-fullbleed):not(.pb-divider-page) {
    width: ${contentW}mm;
    height: ${contentH}mm;
    margin: ${m.top}mm ${m.outer}mm ${m.bottom}mm ${m.inner}mm;
  }
  .pb-fullbleed { width: ${pageW}mm; height: ${pageH}mm; }
  .ph-fullbleed-img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .ph-missing { background: repeating-linear-gradient(45deg, #eee, #eee 8px, #f6f6f6 8px, #f6f6f6 16px); }

  .ph-cover-img { width: 100%; height: 100%; object-fit: cover; display: block; border-radius: var(--pb-photo-radius); }

  /* full-framed: one photo, matted per the style suite */
  .pb-framed { display: flex; align-items: center; justify-content: center; }
  .pb-framed-inner { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
  .ph-frame {
    box-sizing: border-box;
    background: var(--pb-page-bg);
    padding: var(--pb-photo-mat);
    border: var(--pb-photo-frame-border);
    box-shadow: var(--pb-photo-shadow);
    border-radius: var(--pb-photo-radius);
    width: 100%;
    height: 100%;
  }
  .ph-frame-img { width: 100%; height: 100%; object-fit: contain; display: block; border-radius: var(--pb-photo-radius); }

  /* two-vertical / three-column: a justified row sharing one height (see rowFigure) */
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
