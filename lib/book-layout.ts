import type { Block, LayoutPlan } from '@/lib/book-layout-plan';
import { PAGEDJS_POLYFILL_URL } from '@/lib/pagedjs';

/**
 * Book typesetting: pure HTML/CSS generation. `preview`/`print` are printed to PDF by
 * Chromium in lib/book-render.ts (worker); `screen` is served straight to the browser
 * by app/api/books/[bookId]/preview-html/route.ts and paginated client-side by
 * Paged.js — the live builder preview. CSS paged media does the layout work (@page
 * size, page breaks, running page numbers) in all three; keeping this file free of
 * I/O makes layout changes reviewable and unit-testable.
 *
 * The renderer no longer decides *what* goes on a page — it renders whatever the
 * `LayoutPlan` (lib/book-layout-plan.ts) says. Callers resolve the plan's assetIds to
 * embeddable image `src`s (data: URIs for PDF variants, presigned URLs for `screen`)
 * and hand both to `renderBookHtml`.
 */

export type LayoutVariant = 'preview' | 'print' | 'screen';

export interface LayoutImage {
  assetId: string;
  /** A data: URI for `preview`/`print` (embedded so Chromium needs no network); a
   *  presigned S3 URL for `screen` (the browser fetches it directly). */
  src: string;
  caption: string | null;
  width: number;
  height: number;
}

export interface LayoutChapterContent {
  storyId: string;
  title: string;
  eventLabel: string | null;
  paragraphs: string[];
  /** Every photo available to this chapter, keyed by assetId inside plan blocks. */
  images: LayoutImage[];
}

export interface LayoutInput {
  variant: LayoutVariant;
  title: string;
  subtitle: string | null;
  dedication: string | null;
  chronicleName: string;
  /** Trim size in millimetres. */
  trim: { w: number; h: number };
  plan: LayoutPlan;
  chapters: LayoutChapterContent[];
  /** Resolved image for plan.cover.heroAssetId, if any. */
  coverImage: LayoutImage | null;
  /** Shown on the colophon page, e.g. "July 2026". */
  createdLabel: string;
  watermarkText?: string;
}

const esc = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** 3 mm bleed on every edge for the print variant. */
const BLEED_MM = 3;

function figureHtml(img: LayoutImage, extraClass = ''): string {
  return `
    <figure class="${extraClass}">
      <img src="${img.src}" alt="" />
      ${img.caption ? `<figcaption>${esc(img.caption)}</figcaption>` : ''}
    </figure>`;
}

function paragraphsHtml(
  block: Extract<Block, { type: 'paragraphs' }>,
  content: LayoutChapterContent,
): string {
  const slice = content.paragraphs.slice(block.from, block.to + 1);
  return slice.map((p) => `<p>${esc(p)}</p>`).join('\n');
}

/** Renders one chapter's block list against its resolved images/paragraphs. */
function renderBlocks(blocks: Block[], content: LayoutChapterContent): string {
  const byId = new Map(content.images.map((img) => [img.assetId, img]));
  const pieces: string[] = [];

  for (let idx = 0; idx < blocks.length; idx++) {
    const block = blocks[idx];
    switch (block.type) {
      case 'paragraphs': {
        pieces.push(paragraphsHtml(block, content));
        break;
      }
      case 'figure': {
        const img = byId.get(block.assetId);
        if (!img) break;
        if (block.size === 'full') {
          pieces.push(figureHtml(img, 'figure-full'));
          break;
        }
        const cls = block.size === 'float-left' ? 'figure-float-left' : 'figure-float-right';
        const figure = figureHtml(img, cls);
        // A float paired with the paragraphs block right after it, as one atomic
        // unit. Chromium's print pagination doesn't keep a float and its wrapping
        // text together on its own: a float that doesn't fit the remaining page
        // moves to the next page, but plain block siblings after it don't follow —
        // they stay behind, stranding the image alone with no text beside it.
        // Wrapping both in one break-inside: avoid container fixes that: either
        // both fit on the current page, or both move to the next one together.
        const next = blocks[idx + 1];
        if (next && next.type === 'paragraphs') {
          pieces.push(`<div class="float-wrap">${figure}${paragraphsHtml(next, content)}</div>`);
          idx++; // consumed — don't render it again on the next loop iteration
        } else {
          pieces.push(`<div class="float-wrap">${figure}</div>`);
        }
        break;
      }
      case 'photo-row': {
        const imgs = block.assetIds.map((id) => byId.get(id)).filter((i): i is LayoutImage => !!i);
        if (imgs.length === 0) break;
        pieces.push(`<div class="photo-row">${imgs.map((img) => figureHtml(img)).join('\n')}</div>`);
        break;
      }
      case 'photo-grid': {
        const imgs = block.assetIds.map((id) => byId.get(id)).filter((i): i is LayoutImage => !!i);
        if (imgs.length === 0) break;
        if (imgs.length >= 4) {
          // 2x2 — a flat flex-wrap row of 4 equal tiles.
          pieces.push(
            `<div class="photo-grid grid-4">${imgs.map((img) => figureHtml(img)).join('\n')}</div>`,
          );
        } else if (imgs.length === 3) {
          // Dominant slot = widest aspect ratio (most landscape), spans the left
          // column; the other two stack in a nested column so the whole thing is
          // one flex row (CSS Grid track fragmentation across a print page break
          // is unreliable in Chromium — flexbox fragments as a single block).
          const dominant = imgs.reduce((best, img) =>
            img.width / img.height > best.width / best.height ? img : best,
          );
          const rest = imgs.filter((img) => img !== dominant);
          pieces.push(
            `<div class="photo-grid grid-3">${figureHtml(dominant, 'dominant')}<div class="grid-3-stack">${rest
              .map((img) => figureHtml(img))
              .join('\n')}</div></div>`,
          );
        } else {
          pieces.push(
            `<div class="photo-grid grid-${imgs.length}">${imgs.map((img) => figureHtml(img)).join('\n')}</div>`,
          );
        }
        break;
      }
      case 'photo-page': {
        const img = byId.get(block.assetId);
        if (!img) break;
        pieces.push(`
          <section class="page photo-page-block">
            <img src="${img.src}" alt="" />
            ${img.caption ? `<p class="caption">${esc(img.caption)}</p>` : ''}
          </section>`);
        break;
      }
    }
  }
  return pieces.join('\n');
}

export function renderBookHtml(input: LayoutInput): string {
  const bleed = input.variant === 'print' ? BLEED_MM : 0;
  const pageW = input.trim.w + bleed * 2;
  const pageH = input.trim.h + bleed * 2;
  // Inner margins are measured from the TRIM edge; bleed is added on top.
  const m = { top: 18 + bleed, bottom: 20 + bleed, inner: 20 + bleed, outer: 16 + bleed };

  // No watermark on `screen`: it's an auth-gated live-editing surface, not a
  // distributable file — unlike the PDF, there's nothing to mark up before order.
  const watermark =
    input.variant === 'preview'
      ? `<div class="watermark">${esc(input.watermarkText ?? 'PREVIEW')}</div>`
      : '';

  // Paged.js: only for `screen`. It polyfills CSS Paged Media in the browser,
  // chunking the document into real `.pagedjs_page` boxes using the same `@page`
  // rules Chromium prints from. `after` stamps a data attribute a caller (or a test
  // driving the iframe) can poll for instead of guessing when pagination settled.
  const pagedScript =
    input.variant === 'screen'
      ? `
  <script>
    window.PagedConfig = {
      auto: true,
      after: () => { document.documentElement.setAttribute('data-pagedjs-ready', 'true'); },
    };
  </script>
  <script src="${PAGEDJS_POLYFILL_URL}"></script>`
      : '';

  // Screen-only chrome: pages read as sheets of paper on a neutral background,
  // never part of the print/preview PDF stylesheet (Chromium's page.pdf() renders
  // print media anyway, but keeping this out of the shared block keeps the PDF
  // variants byte-for-byte what they were before `screen` existed).
  const screenChrome =
    input.variant === 'screen'
      ? `
  html, body { background: #d7d9dd; }
  body { padding: 10mm 0 24mm; }
  .pagedjs_pages {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8mm;
  }
  .pagedjs_page {
    background: #fff;
    box-shadow: 0 3mm 10mm rgba(15, 15, 20, 0.28);
  }`
      : '';

  const coverStyle = input.plan.cover.style;
  const coverPage =
    coverStyle === 'framed'
      ? `
    <section class="page cover framed">
      <div class="cover-inner">
        ${
          input.coverImage
            ? `<div class="cover-frame"><img src="${input.coverImage.src}" alt="" /></div>`
            : ''
        }
        <h1>${esc(input.title)}</h1>
        ${input.subtitle ? `<p class="subtitle">${esc(input.subtitle)}</p>` : ''}
        <p class="chronicle">${esc(input.chronicleName)}</p>
      </div>
    </section>`
      : `
    <section class="page cover full-bleed">
      ${input.coverImage ? `<img class="cover-photo" src="${input.coverImage.src}" alt="" />` : ''}
      <div class="cover-text">
        <h1>${esc(input.title)}</h1>
        ${input.subtitle ? `<p class="subtitle">${esc(input.subtitle)}</p>` : ''}
      </div>
    </section>`;

  const titlePage = `
    <section class="page title-page">
      <h1>${esc(input.title)}</h1>
      ${input.subtitle ? `<p class="subtitle">${esc(input.subtitle)}</p>` : ''}
      <p class="chronicle">${esc(input.chronicleName)}</p>
      ${input.dedication ? `<p class="dedication">${esc(input.dedication)}</p>` : ''}
    </section>`;

  const contentByStory = new Map(input.chapters.map((c) => [c.storyId, c]));

  const toc = `
    <section class="page toc">
      <h2>Inhalt · Contents</h2>
      <ol>
        ${input.plan.chapters
          .map((planChapter) => contentByStory.get(planChapter.storyId))
          .filter((c): c is LayoutChapterContent => !!c)
          .map(
            (c) =>
              `<li><span class="toc-title">${esc(c.title)}</span>${
                c.eventLabel ? `<span class="toc-year">${esc(c.eventLabel)}</span>` : ''
              }</li>`,
          )
          .join('\n')}
      </ol>
    </section>`;

  const chapters = input.plan.chapters
    .map((planChapter) => {
      const c = contentByStory.get(planChapter.storyId);
      if (!c) return '';
      return `
      <section class="chapter">
        <header>
          ${c.eventLabel ? `<p class="chapter-year">${esc(c.eventLabel)}</p>` : ''}
          <h2>${esc(c.title)}</h2>
        </header>
        ${renderBlocks(planChapter.blocks, c)}
      </section>`;
    })
    .join('\n');

  const colophon = `
    <section class="page colophon">
      <p>${esc(input.chronicleName)}</p>
      <p>Created with Family Chronicle · ${esc(input.createdLabel)}</p>
    </section>`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @page {
    size: ${pageW}mm ${pageH}mm;
    margin: ${m.top}mm ${m.outer}mm ${m.bottom}mm ${m.inner}mm;
    @bottom-center {
      content: counter(page);
      font-family: Georgia, 'Noto Serif', 'DejaVu Serif', serif;
      font-size: 8pt;
      color: #9aa1ad;
    }
  }
  /* The cover is the first page, bleeds to the physical edge, and never shows a
     running page number. */
  @page :first {
    margin: 0;
    @bottom-center { content: ''; }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: Georgia, 'Noto Serif', 'DejaVu Serif', serif;
    font-size: 10.5pt;
    line-height: 1.55;
    color: #1e2430;
  }

  /* Full-page sections (cover, title, toc, colophon) */
  .page { page-break-after: always; }

  /* ---- Cover: framed (v2 default) ---- */
  .cover.framed {
    width: ${pageW}mm;
    height: ${pageH}mm;
    background: #f4efe6;
    color: #1e1b16;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .cover.framed .cover-inner {
    text-align: center;
    padding: 0 14mm;
  }
  .cover.framed .cover-frame {
    width: 60%;
    aspect-ratio: 4 / 5;
    margin: 0 auto 10mm;
    background: #fff;
    padding: 3mm;
    border: 0.3mm solid #ded4c2;
    box-shadow: 0 4mm 9mm rgba(40, 32, 20, 0.22);
  }
  .cover.framed .cover-frame img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .cover.framed h1 {
    font-size: 25pt;
    font-weight: 600;
    color: #1a1712;
    margin: 0 0 4mm;
  }
  .cover.framed .subtitle {
    font-size: 12.5pt;
    color: #6b6153;
    margin: 0 0 3mm;
  }
  .cover.framed .chronicle {
    font-size: 10pt;
    color: #8d8471;
    font-variant: small-caps;
    letter-spacing: 0.1em;
    margin: 0;
  }

  /* ---- Cover: full-bleed (v1 look, kept as an alternative style) ---- */
  .cover.full-bleed {
    width: ${pageW}mm;
    height: ${pageH}mm;
    background: #223047;
    color: #f6f3ec;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    overflow: hidden;
    position: relative;
  }
  .cover.full-bleed .cover-photo {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    object-fit: cover;
    opacity: 0.88;
  }
  .cover.full-bleed .cover-text {
    position: relative;
    padding: 14mm 16mm 18mm;
    background: linear-gradient(transparent, rgba(20, 28, 43, 0.82) 40%);
  }
  .cover.full-bleed h1 { font-size: 26pt; margin: 0 0 3mm; font-weight: 600; }
  .cover.full-bleed .subtitle { font-size: 13pt; margin: 0; opacity: 0.85; }

  .title-page { text-align: center; padding-top: 30%; }
  .title-page h1 { font-size: 22pt; font-weight: 600; margin: 0 0 4mm; }
  .title-page .subtitle { font-size: 12pt; color: #5a6372; margin: 0 0 12mm; }
  .title-page .chronicle { font-variant: small-caps; letter-spacing: 0.08em; color: #5a6372; }
  .title-page .dedication { margin-top: 18mm; font-style: italic; color: #444c5c; }

  .toc h2 { font-size: 14pt; margin: 0 0 8mm; }
  .toc ol { list-style: none; margin: 0; padding: 0; }
  .toc li {
    display: flex; justify-content: space-between; gap: 6mm;
    padding: 1.6mm 0; border-bottom: 0.2mm dotted #b9c0cc;
    font-size: 10pt;
  }
  .toc-year { color: #5a6372; white-space: nowrap; }

  .chapter { page-break-before: right; }
  /* Clears floated figures at the end of the chapter so nothing spills into the
     next page's margin. */
  .chapter::after { content: ''; display: table; clear: both; }
  .chapter header { margin-bottom: 6mm; }
  .chapter-year {
    font-variant: small-caps; letter-spacing: 0.12em;
    color: #8a93a3; margin: 0 0 1mm; font-size: 9pt;
  }
  .chapter h2 { font-size: 16pt; font-weight: 600; margin: 0; }
  .chapter p { margin: 0 0 3.2mm; text-align: justify; hyphens: auto; }
  /* Direct child only — a nested <p> (a photo-page caption, a float-wrap paragraph)
     is also ":first-of-type" among its own siblings and must not get a drop cap. */
  .chapter > p:first-of-type::first-letter { font-size: 1.6em; }

  figure { margin: 0 0 5mm; page-break-inside: avoid; }
  figure img { display: block; border-radius: 1mm; }
  figcaption, .caption { font-size: 8.5pt; color: #5a6372; margin-top: 1.5mm; font-style: italic; }

  /* One landscape hero, full column width, uncropped. */
  figure.figure-full { width: 100%; }
  figure.figure-full img { width: 100%; height: auto; }

  /* Portrait floated beside wrapping text. See renderBlocks() in book-layout.ts:
     the float and the paragraph block right after it are wrapped together in one
     .float-wrap so they paginate as a unit — a bare float would get stranded on
     its own page, separated from the text it's meant to sit beside. */
  .float-wrap {
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .float-wrap::after { content: ''; display: table; clear: both; }
  figure.figure-float-left, figure.figure-float-right {
    width: 44%;
    margin-bottom: 3mm;
  }
  figure.figure-float-left { float: left; margin-right: 5mm; }
  figure.figure-float-right { float: right; margin-left: 5mm; }
  figure.figure-float-left img, figure.figure-float-right img {
    width: 100%;
    aspect-ratio: 4 / 5;
    object-fit: cover;
  }

  /* Two portraits side by side, equal-height slots. Flexbox, not grid: Chromium's
     print engine fragments CSS Grid containers unreliably across a page break even
     with break-inside: avoid, occasionally dropping/clipping grid items. Flexbox
     fragments as a single block, which is what "avoid" actually needs here. */
  .photo-row {
    display: flex;
    gap: 3.5mm;
    margin: 5mm 0;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .photo-row figure { margin: 0; flex: 1; min-width: 0; }
  .photo-row img { width: 100%; aspect-ratio: 4 / 5; object-fit: cover; display: block; }

  /* 3-4 leftover images. 3 => one dominant + two stacked; 4 => 2x2. */
  .photo-grid {
    display: flex;
    gap: 3.5mm;
    height: 88mm;
    margin: 5mm 0;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .photo-grid figure { margin: 0; }
  .photo-grid img { width: 100%; height: 100%; object-fit: cover; display: block; }
  /* A dense collage of small tiles has no room for per-image captions without
     crowding the narrow row gap; the grid reads as one collage instead. */
  .photo-grid figcaption { display: none; }

  .photo-grid.grid-3 > figure.dominant { flex: 2; height: 100%; min-width: 0; }
  .photo-grid.grid-3 > .grid-3-stack {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3.5mm;
  }
  .photo-grid.grid-3 > .grid-3-stack figure { flex: 1; min-height: 0; }

  .photo-grid.grid-4 { flex-wrap: wrap; }
  .photo-grid.grid-4 figure { width: calc(50% - 1.75mm); height: calc(50% - 1.75mm); }

  /* A standout image on its own page. */
  .photo-page-block {
    page-break-before: always;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 12mm 16mm;
  }
  .photo-page-block img {
    max-width: 100%;
    max-height: 85%;
    width: auto;
    height: auto;
    object-fit: contain;
    box-shadow: 0 3mm 8mm rgba(20, 20, 20, 0.15);
  }
  .photo-page-block .caption {
    margin-top: 6mm;
    text-align: center;
  }

  .colophon {
    text-align: center; padding-top: 70%;
    color: #8a93a3; font-size: 9pt;
    page-break-after: avoid;
  }

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
${coverPage}
${titlePage}
${toc}
${chapters}
${colophon}
</body>
</html>`;
}
