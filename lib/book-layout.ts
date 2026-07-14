/**
 * Book typesetting: pure HTML/CSS generation, printed to PDF by Chromium in
 * lib/book-render.ts. CSS paged media does the layout work (@page size, page
 * breaks, running page numbers); keeping this file free of I/O makes layout
 * changes reviewable and unit-testable.
 */

export type LayoutVariant = 'preview' | 'print';

export interface LayoutPhoto {
  /** data: URI (images are embedded so Chromium needs no network). */
  src: string;
  caption: string | null;
  /** Landscape photos span the text column; portraits float at half width. */
  landscape: boolean;
}

export interface LayoutChapter {
  title: string;
  eventLabel: string | null;
  paragraphs: string[];
  photos: LayoutPhoto[];
}

export interface LayoutInput {
  variant: LayoutVariant;
  title: string;
  subtitle: string | null;
  dedication: string | null;
  chronicleName: string;
  coverSrc: string | null;
  /** Trim size in millimetres. */
  trim: { w: number; h: number };
  chapters: LayoutChapter[];
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

export function renderBookHtml(input: LayoutInput): string {
  const bleed = input.variant === 'print' ? BLEED_MM : 0;
  const pageW = input.trim.w + bleed * 2;
  const pageH = input.trim.h + bleed * 2;
  // Inner margins are measured from the TRIM edge; bleed is added on top.
  const m = { top: 18 + bleed, bottom: 20 + bleed, inner: 20 + bleed, outer: 16 + bleed };

  const watermark =
    input.variant === 'preview'
      ? `<div class="watermark">${esc(input.watermarkText ?? 'PREVIEW')}</div>`
      : '';

  const coverPage = `
    <section class="page cover">
      ${input.coverSrc ? `<img class="cover-photo" src="${input.coverSrc}" alt="" />` : ''}
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

  const toc = `
    <section class="page toc">
      <h2>Inhalt · Contents</h2>
      <ol>
        ${input.chapters
          .map(
            (c) =>
              `<li><span class="toc-title">${esc(c.title)}</span>${
                c.eventLabel ? `<span class="toc-year">${esc(c.eventLabel)}</span>` : ''
              }</li>`,
          )
          .join('\n')}
      </ol>
    </section>`;

  const chapters = input.chapters
    .map((c) => {
      const photos = c.photos
        .map(
          (p) => `
          <figure class="${p.landscape ? 'wide' : 'narrow'}">
            <img src="${p.src}" alt="" />
            ${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ''}
          </figure>`,
        )
        .join('\n');
      return `
      <section class="chapter">
        <header>
          ${c.eventLabel ? `<p class="chapter-year">${esc(c.eventLabel)}</p>` : ''}
          <h2>${esc(c.title)}</h2>
        </header>
        ${c.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('\n')}
        ${photos ? `<div class="photos">${photos}</div>` : ''}
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
  }
  /* The cover is the first page and bleeds to the physical edge. */
  @page :first {
    margin: 0;
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

  .cover {
    /* Rendered on the zero-margin first page — fills it to the physical edge. */
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
  .cover-photo {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    object-fit: cover;
    opacity: 0.88;
  }
  .cover-text {
    position: relative;
    padding: 14mm 16mm 18mm;
    background: linear-gradient(transparent, rgba(20, 28, 43, 0.82) 40%);
  }
  .cover h1 { font-size: 26pt; margin: 0 0 3mm; font-weight: 600; }
  .cover .subtitle { font-size: 13pt; margin: 0; opacity: 0.85; }

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
  .chapter header { margin-bottom: 6mm; }
  .chapter-year {
    font-variant: small-caps; letter-spacing: 0.12em;
    color: #8a93a3; margin: 0 0 1mm; font-size: 9pt;
  }
  .chapter h2 { font-size: 16pt; font-weight: 600; margin: 0; }
  .chapter p { margin: 0 0 3.2mm; text-align: justify; hyphens: auto; }
  .chapter p:first-of-type::first-letter { font-size: 1.6em; }

  .photos { margin-top: 5mm; }
  figure { margin: 0 0 5mm; page-break-inside: avoid; }
  figure.wide img { width: 100%; }
  figure.narrow { width: 62%; }
  figure.narrow img { width: 100%; }
  figure img { display: block; border-radius: 1mm; }
  figcaption { font-size: 8.5pt; color: #5a6372; margin-top: 1.5mm; font-style: italic; }

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
</style>
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
