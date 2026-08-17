import { describe, expect, it } from 'vitest';
import {
  PHOTO_BOOK_BLEED_MM,
  PHOTO_CAPTION_RESERVE_MM,
  PHOTO_BOOK_CONTENT_MARGIN_MM,
  renderPhotoBookHtml,
  rowStackGeometryMm,
  type PhotoLayoutImage,
  type PhotoLayoutInput,
} from './photo-book-layout';
import { PHOTO_BOOK_STYLES, type PhotoBookPlan } from './photo-book-plan';
import { screenFontFaceCss } from './photo-book-fonts';

/** Pure HTML/CSS-generation tests (no Chromium) — the same split the module's own header
 *  comment calls for: exercise `renderPhotoBookHtml`'s output for every variant/style
 *  combination without ever launching a browser. */

const TRIM = { w: 210, h: 280 };

function image(assetId: string, w = 1600, h = 1200): PhotoLayoutImage {
  return { assetId, src: `data:image/jpeg;base64,${assetId}`, width: w, height: h };
}

function basePlan(overrides: Partial<PhotoBookPlan> = {}): PhotoBookPlan {
  return {
    kind: 'photo',
    style: 'classic',
    cover: { heroAssetId: 'hero', title: 'Our Family', subtitle: 'A Year Together' },
    sections: [
      {
        title: 'Summer 2025',
        dateLabel: 'June 2025',
        pages: [
          { template: 'full-bleed', assetIds: ['a1'], captions: ['At the lake'] },
          { template: 'two-horizontal', assetIds: ['a2', 'a3'] },
          { template: 'full-framed', assetIds: ['a4'] },
        ],
      },
    ],
    ...overrides,
  };
}

function baseInput(overrides: Partial<PhotoLayoutInput> = {}): PhotoLayoutInput {
  const plan = overrides.plan ?? basePlan();
  const images = new Map<string, PhotoLayoutImage>([
    ['hero', image('hero')],
    ['a1', image('a1')],
    ['a2', image('a2')],
    ['a3', image('a3')],
    ['a4', image('a4')],
  ]);
  return {
    variant: 'screen',
    chronicleName: 'The Smiths',
    trim: TRIM,
    plan,
    images,
    fontFaceCss: screenFontFaceCss(plan.style),
    createdLabel: 'July 2026',
    watermarkText: 'VORSCHAU · PREVIEW',
    ...overrides,
  };
}

describe('renderPhotoBookHtml', () => {
  it('renders every style suite without throwing, for every variant', () => {
    for (const style of PHOTO_BOOK_STYLES) {
      for (const variant of ['screen', 'preview', 'print'] as const) {
        const plan = basePlan({ style });
        const html = renderPhotoBookHtml(
          baseInput({ variant, plan, fontFaceCss: screenFontFaceCss(style) }),
        );
        expect(html).toContain('<!doctype html>');
        expect(html).toContain(plan.cover.title);
      }
    }
  });

  it('renders the Birthday recipe with a cover collage, no contents/divider, and left-page story starts', () => {
    const plan = basePlan({
      template: 'birthday',
      cover: { heroAssetId: 'a1', assetIds: ['a1', 'a2', 'a3', 'a4'], title: 'Birthday Book' },
      sections: [
        {
          title: 'Omas Geburtstag',
          dateLabel: '12. Mai 2025',
          storyId: 'story-1',
          pages: [
            { template: 'text', from: 0, to: 1 },
            { template: 'collage-4', assetIds: ['a1', 'a2', 'a3', 'a4'] },
          ],
        },
      ],
    });
    const html = renderPhotoBookHtml(
      baseInput({
        plan,
        storyParagraphs: new Map([['story-1', ['Der erste Absatz.', 'Der zweite Absatz.']]]),
      }),
    );

    expect(html).toContain('class="pb-birthday-cover-collage" data-count="4"');
    expect(html).toContain('<h2>Omas Geburtstag</h2>');
    expect(html).toContain('12. Mai 2025');
    expect(html).toContain('break-before: left');
    expect(html).toContain('<p class="pb-cover-subtitle">July 2026</p>');
    expect(html).not.toContain('<section class="page pb-toc">');
    expect(html).not.toContain('<section class="page pb-divider">');
    expect(html.indexOf('Der erste Absatz.')).toBeLessThan(html.indexOf('class="page photo-page pb-rows-page"'));
  });

  it('puts the Birthday parity opener around photo-only story sections too', () => {
    const plan = basePlan({
      template: 'birthday',
      cover: { heroAssetId: 'a1', assetIds: ['a1', 'a2'], title: 'Birthday Book' },
      sections: [
        { title: 'Photo story one', storyId: 's1', pages: [{ template: 'full-framed', assetIds: ['a1'] }] },
        { title: 'Photo story two', storyId: 's2', pages: [{ template: 'full-framed', assetIds: ['a2'] }] },
      ],
    });
    const html = renderPhotoBookHtml(baseInput({ plan, storyParagraphs: new Map() }));
    expect(html.match(/class="pb-birthday-story-start"/g)).toHaveLength(2);
    expect(html).toContain('.pb-birthday-story-start { break-before: left;');
  });

  it('gives the divider-page template an explicit full-sheet size so it never collapses to a blank page', () => {
    // Regression: `.pb-divider-page` used to be only `position: relative` with no
    // width/height; its sole child (`.ph-divider-bg`) is absolutely positioned, so the
    // page collapsed to height:0 and rendered blank. Reachable when a chat/manual edit
    // empties a page's last photo (mapped to the `divider` template).
    const screenHtml = renderPhotoBookHtml(baseInput({ variant: 'screen' }));
    expect(screenHtml).toMatch(/\.pb-divider-page\s*\{[^}]*width:\s*\d/);
    expect(screenHtml).toMatch(/\.pb-divider-page\s*\{[^}]*height:\s*\d/);
  });

  it('adds PHOTO_BOOK_BLEED_MM to every physical page edge only for print', () => {
    const screenHtml = renderPhotoBookHtml(baseInput({ variant: 'screen' }));
    const previewHtml = renderPhotoBookHtml(baseInput({ variant: 'preview' }));
    const printHtml = renderPhotoBookHtml(baseInput({ variant: 'print' }));

    const bleedW = TRIM.w + PHOTO_BOOK_BLEED_MM * 2;
    const bleedH = TRIM.h + PHOTO_BOOK_BLEED_MM * 2;

    expect(screenHtml).toContain(`size: ${TRIM.w}mm ${TRIM.h}mm;`);
    expect(previewHtml).toContain(`size: ${TRIM.w}mm ${TRIM.h}mm;`);
    expect(printHtml).toContain(`size: ${bleedW}mm ${bleedH}mm;`);
    expect(printHtml).not.toContain(`size: ${TRIM.w}mm ${TRIM.h}mm;`);
  });

  it('keeps the content-box inset (trim edge) identical between screen and print', () => {
    // The physical page grows by the bleed for print, but a content-box (non-bleed) page's
    // inset from the TRIM edge — i.e. padding minus bleed — must be unchanged, so
    // `full-framed`/grid photos occupy the identical physical area in both variants.
    const screenHtml = renderPhotoBookHtml(baseInput({ variant: 'screen' }));
    const printHtml = renderPhotoBookHtml(baseInput({ variant: 'print' }));

    const screenPadding = `padding: ${PHOTO_BOOK_CONTENT_MARGIN_MM.top}mm ${PHOTO_BOOK_CONTENT_MARGIN_MM.outer}mm ${PHOTO_BOOK_CONTENT_MARGIN_MM.bottom + 1}mm ${PHOTO_BOOK_CONTENT_MARGIN_MM.inner}mm;`;
    const printPadding = `padding: ${PHOTO_BOOK_CONTENT_MARGIN_MM.top + PHOTO_BOOK_BLEED_MM}mm ${PHOTO_BOOK_CONTENT_MARGIN_MM.outer + PHOTO_BOOK_BLEED_MM}mm ${PHOTO_BOOK_CONTENT_MARGIN_MM.bottom + PHOTO_BOOK_BLEED_MM + 1}mm ${PHOTO_BOOK_CONTENT_MARGIN_MM.inner + PHOTO_BOOK_BLEED_MM}mm;`;

    expect(screenHtml).toContain(screenPadding);
    expect(printHtml).toContain(printPadding);
  });

  it('shows the watermark only on preview, never on screen or print', () => {
    const screenHtml = renderPhotoBookHtml(baseInput({ variant: 'screen' }));
    const previewHtml = renderPhotoBookHtml(baseInput({ variant: 'preview' }));
    const printHtml = renderPhotoBookHtml(baseInput({ variant: 'print' }));

    expect(screenHtml).not.toContain('class="watermark"');
    expect(previewHtml).toContain('class="watermark"');
    expect(previewHtml).toContain('VORSCHAU · PREVIEW');
    expect(printHtml).not.toContain('class="watermark"');
  });

  it('injects the caller-provided fontFaceCss verbatim', () => {
    const marker = '@font-face { font-family: "Test Marker Font"; }';
    const html = renderPhotoBookHtml(baseInput({ fontFaceCss: marker }));
    expect(html).toContain(marker);
  });

  it('emits Paged.js wiring only for screen, never for preview/print PDF variants', () => {
    const screenHtml = renderPhotoBookHtml(baseInput({ variant: 'screen' }));
    const previewHtml = renderPhotoBookHtml(baseInput({ variant: 'preview' }));
    const printHtml = renderPhotoBookHtml(baseInput({ variant: 'print' }));

    expect(screenHtml).toContain('PagedConfig');
    expect(previewHtml).not.toContain('PagedConfig');
    expect(printHtml).not.toContain('PagedConfig');
  });

  it('hides the screen page stack until Paged.js reports done, and only for screen', () => {
    const screenHtml = renderPhotoBookHtml(baseInput({ variant: 'screen' }));
    const previewHtml = renderPhotoBookHtml(baseInput({ variant: 'preview' }));
    const printHtml = renderPhotoBookHtml(baseInput({ variant: 'print' }));

    // Nothing scales the stack until pagination finishes, so it stays hidden until then
    // rather than showing a native-size crop of page one for the whole run. The behavioral
    // check lives in `photo-book-text-flow.integration.test.ts`, but it can only assert
    // while pagination is still in flight — this is the guard that survives whatever the
    // timing does, and it is the reason deleting the rule can't pass unnoticed.
    expect(screenHtml).toContain('html:not([data-pagedjs-visible]) .pagedjs_pages');
    expect(screenHtml).toContain('visibility: hidden');
    // Both rescue paths that release it — a pagination that fails, and one that stops.
    // They un-hide ONLY: neither may reach `fitPages`, since scaling a pagination that is
    // still running is the bug this all exists to prevent.
    expect(screenHtml).toContain("addEventListener('unhandledrejection', unhide)");
    expect(screenHtml).toContain('setTimeout(unhide');
    // Neither PDF variant paginates in a browser, so none of this may leak into one: a
    // hidden stack there would render blank pages into the print file.
    expect(previewHtml).not.toContain('data-pagedjs-visible');
    expect(printHtml).not.toContain('data-pagedjs-visible');
  });

  it('renders a divider ornament flourish only for suites with dividerOrnament (heirloom)', () => {
    const heirloomHtml = renderPhotoBookHtml(
      baseInput({ plan: basePlan({ style: 'heirloom' }), fontFaceCss: screenFontFaceCss('heirloom') }),
    );
    const classicHtml = renderPhotoBookHtml(baseInput({ plan: basePlan({ style: 'classic' }) }));

    expect(heirloomHtml).toContain('--pb-divider-ornament-display: block;');
    expect(classicHtml).toContain('--pb-divider-ornament-display: none;');
  });

  it('renders a photo-tape accent only for suites with photoTape (journal)', () => {
    const journalHtml = renderPhotoBookHtml(
      baseInput({ plan: basePlan({ style: 'journal' }), fontFaceCss: screenFontFaceCss('journal') }),
    );
    const modernHtml = renderPhotoBookHtml(
      baseInput({ plan: basePlan({ style: 'modern' }), fontFaceCss: screenFontFaceCss('modern') }),
    );

    expect(journalHtml).toContain('--pb-photo-tape-display: block;');
    expect(modernHtml).toContain('--pb-photo-tape-display: none;');
  });

  it('renders a missing image as an empty slot instead of throwing', () => {
    const html = renderPhotoBookHtml(baseInput({ images: new Map() }));
    expect(html).toContain('ph-missing');
  });

  it('protects an incompatible landscape cover with blurred fill plus an uncropped foreground', () => {
    const html = renderPhotoBookHtml(baseInput());
    expect(html).toContain('ph-cover-bg-img ph-cover-bg-blur');
    expect(html).toContain('ph-cover-contain-img');
  });

  it('falls a landscape full-bleed page back to an intrinsic-aspect frame', () => {
    const html = renderPhotoBookHtml(baseInput());
    expect(html).toContain('pb-fullbleed-fallback');
    expect(html).toMatch(/pb-framed-figure" style="width: [\d.]+mm; height: [\d.]+mm/);
  });

  it('uses the vision focal point as object-position for cover crops', () => {
    const images = new Map(baseInput().images);
    images.set('hero', { ...image('hero', 900, 1200), focalPoint: { x: 0.2, y: 0.7 } });
    const html = renderPhotoBookHtml(baseInput({ images }));
    expect(html).toContain('object-position: 20.0% 70.0%');
  });

  it('reserves caption height before sizing photos instead of cropping afterward', () => {
    const box = { w: 180, h: 249 };
    const geometry = rowStackGeometryMm([[2 / 3, 2 / 3]], box, [true]);
    expect(geometry.rowHeights[0] - geometry.cells[0][0].h).toBe(PHOTO_CAPTION_RESERVE_MM);
    expect(geometry.cells[0][0].w / geometry.cells[0][0].h).toBeCloseTo(2 / 3);

    const plan = basePlan({
      sections: [{ title: 'S', pages: [{ template: 'two-vertical', assetIds: ['a2', 'a3'], captions: ['One', null] }] }],
    });
    const images = new Map(baseInput().images);
    images.set('a2', image('a2', 800, 1200));
    images.set('a3', image('a3', 800, 1200));
    const html = renderPhotoBookHtml(baseInput({ plan, images }));
    expect(html.match(/class="ph-caption-slot"/g)).toHaveLength(2);
    expect(html).toContain('.ph-jimg { width: 100%; height: 100%; object-fit: contain;');
  });

  // Regression coverage: the photo book used to render bleed pages for `preview`/`print`
  // with CSS's named-page mechanism (`page: <ident>` on the element + a matching
  // `@page <ident> { margin: 0 }` rule) while `screen` used a single unnamed
  // `@page { margin: 0 }` with element-box sizing instead. Two bugs came from that split:
  // (1) the self-hosted Paged.js polyfill (`screen` only) can't reliably paginate a
  // document with many scattered named `@page` rules — reproduced headlessly: pagination
  // stalled after page one and Paged.js's own repeated-layout guard cloned the same page
  // over and over (`Layout repeated at:` in the console) — so `screen` never used named
  // pages to begin with; (2) Chromium's `page.pdf()` (`preview`/`print`) does not fully
  // honor a named-page margin override on the TRAILING edges — measured right/bottom bleed
  // fell ~20-27mm short of the physical sheet edge while left/top reached it, so bleed
  // pages didn't actually bleed on two sides. The fix unifies every variant onto the
  // element-box approach `screen` already used: a single unnamed `@page { margin: 0 }` for
  // the whole document, with bleed pages sized to the full sheet via their own `width`/
  // `height` and no CSS margin. No variant emits `page: <ident>` or a named `@page` rule
  // anymore.
  describe('unnamed @page bleed mechanism (all variants)', () => {
    it('a PHOTO-ONLY book emits no named @page rule at all (unchanged from before text support)', () => {
      // The named-page mechanism only exists for flowing text. A book without chapters
      // must keep the single-unnamed-@page document it always had — that's what makes
      // text support dormant for every existing photo book, and it keeps them away from
      // the documented Chromium/Paged.js named-page bugs entirely.
      for (const variant of ['screen', 'preview', 'print'] as const) {
        const html = renderPhotoBookHtml(baseInput({ variant }));
        expect(html).not.toMatch(/style="page:/);
        expect(html.match(/@page [a-zA-Z][\w-]*\s*\{/g) ?? []).toEqual([]);
      }
    });

    it('a book WITH chapters emits exactly one named @page rule — text-flow', () => {
      const plan = basePlan({
        sections: [{ title: 'Kapitel', storyId: 's1', pages: [{ template: 'text', from: 0, to: 0 }] }],
      });
      for (const variant of ['screen', 'preview', 'print'] as const) {
        const html = renderPhotoBookHtml(
          baseInput({ variant, plan, storyParagraphs: new Map([['s1', ['Ein Absatz.']]]) }),
        );
        expect(html.match(/@page [a-zA-Z][\w-]*\s*\{/g) ?? []).toEqual(['@page text-flow {']);
      }
    });

    it('text-page margins are measured from the trim edge in every variant (print adds bleed)', () => {
      // A different column width would mean different line breaks — and therefore a
      // print PDF that paginates differently from the proof the reader approved.
      const plan = basePlan({
        sections: [{ title: 'Kapitel', storyId: 's1', pages: [{ template: 'text', from: 0, to: 0 }] }],
      });
      const input = { plan, storyParagraphs: new Map([['s1', ['Ein Absatz.']]]) };
      const m = PHOTO_BOOK_CONTENT_MARGIN_MM;
      expect(renderPhotoBookHtml(baseInput({ ...input, variant: 'screen' }))).toContain(
        `margin: ${m.top}mm ${m.inner}mm ${m.bottom + 2}mm;`,
      );
      expect(renderPhotoBookHtml(baseInput({ ...input, variant: 'print' }))).toContain(
        `margin: ${m.top + PHOTO_BOOK_BLEED_MM}mm ${m.inner + PHOTO_BOOK_BLEED_MM}mm ${m.bottom + PHOTO_BOOK_BLEED_MM + 2}mm;`,
      );
    });

    it('a photo-only book never propagates a page background (no restyle of existing books)', () => {
      // `background-clip: content-box` leaves the frame strip around every photo page
      // showing the page canvas; propagating --pb-page-bg would recolor it (black for
      // the `bold` suite) on books whose proofs are already approved.
      for (const style of PHOTO_BOOK_STYLES) {
        const html = renderPhotoBookHtml(
          baseInput({ plan: basePlan({ style }), fontFaceCss: screenFontFaceCss(style) }),
        );
        expect(html).not.toMatch(/color: var\(--pb-color-text\);\s*\n\s*background: var\(--pb-page-bg\);/);
      }
    });

    it('every variant has exactly one @page rule, margin 0', () => {
      for (const variant of ['screen', 'preview', 'print'] as const) {
        const html = renderPhotoBookHtml(baseInput({ variant }));
        const pageRules = html.match(/@page\s*\{[^}]*\}/g) ?? [];
        expect(pageRules).toHaveLength(1);
        expect(pageRules[0]).toMatch(/margin: 0;/);
      }
    });

    it("a content-box (non-bleed) photo page's own padding/size carries the inset for every variant", () => {
      // The fix relies on `.photo-page:not(.pb-divider-page)` fully
      // implementing the content-box inset via its own element CSS (a full-sheet
      // width/height plus PADDING, not margin — see that rule's own comment for why
      // padding: Chromium's print/PDF engine truncates an element's own top MARGIN
      // immediately after a forced page break, which is every content-box page, since
      // every `.page` forces a break after itself) rather than the page's own `@page`
      // margin — this pins that down so a future edit can't quietly break it.
      const screenHtml = renderPhotoBookHtml(baseInput({ variant: 'screen' }));
      const printHtml = renderPhotoBookHtml(baseInput({ variant: 'print' }));

      expect(screenHtml).toContain(
        `padding: ${PHOTO_BOOK_CONTENT_MARGIN_MM.top}mm ${PHOTO_BOOK_CONTENT_MARGIN_MM.outer}mm ${PHOTO_BOOK_CONTENT_MARGIN_MM.bottom + 1}mm ${PHOTO_BOOK_CONTENT_MARGIN_MM.inner}mm;`,
      );
      expect(printHtml).toContain(
        `padding: ${PHOTO_BOOK_CONTENT_MARGIN_MM.top + PHOTO_BOOK_BLEED_MM}mm ${PHOTO_BOOK_CONTENT_MARGIN_MM.outer + PHOTO_BOOK_BLEED_MM}mm ${PHOTO_BOOK_CONTENT_MARGIN_MM.bottom + PHOTO_BOOK_BLEED_MM + 1}mm ${PHOTO_BOOK_CONTENT_MARGIN_MM.inner + PHOTO_BOOK_BLEED_MM}mm;`,
      );
    });

    it('bleed pages (cover front/back, divider) size to the full physical sheet with no CSS margin, for every variant', () => {
      for (const variant of ['screen', 'preview', 'print'] as const) {
        const html = renderPhotoBookHtml(baseInput({ variant }));
        const bleed = variant === 'print' ? PHOTO_BOOK_BLEED_MM : 0;
        const pageW = TRIM.w + bleed * 2;
        const pageH = TRIM.h + bleed * 2;
        expect(html).toContain(`.pb-cover-front, .pb-cover-back {\n    width: ${pageW}mm; height: ${pageH}mm;`);
        expect(html).toContain(`.pb-divider-page { width: ${pageW}mm; height: ${pageH}mm;`);
      }
    });

    it('full-bleed photo pages sit inside the shared content-box frame, not edge to edge', () => {
      // The book keeps one constant border on every photo page — a full-bleed page is a
      // .photo-page WITHOUT its own full-sheet rule, so it falls under the shared
      // `.photo-page:not(.pb-divider-page)` padding rule like every other photo page.
      const html = renderPhotoBookHtml(baseInput({ variant: 'screen' }));
      expect(html).not.toContain('.pb-fullbleed {');
      expect(html).toContain('.pb-fullbleed-inner { position: relative; width: 100%; height: 100%;');
      expect(html).toContain('.photo-page:not(.pb-divider-page) {');
    });
  });

  // Regression coverage for bug 4 ("preview is cropped/zoomed"): the old fitPages() only
  // scaled `.pagedjs_pages` to fit the iframe's WIDTH, never its height, so a fixed-height
  // host container cropped most of the page below the fold. The fix fits BOTH axes (like
  // object-fit: contain) so a whole page is always visible.
  it('screen fits pages to both width AND height of the iframe viewport, not just width', () => {
    const html = renderPhotoBookHtml(baseInput({ variant: 'screen' }));
    expect(html).toContain('var PAGE_H_PX');
    expect(html).toMatch(/Math\.min\(1, availW \/ PAGE_W_PX, availH \/ PAGE_H_PX\)/);
  });
});

/** The justified row stack behind every multi-photo template (see `rowStackHtml` in
 *  photo-book-layout.ts): photos render at their true aspect ratios — no cropping —
 *  in rows that share one height, balanced (never cropped) when the stack would
 *  overflow the content box. */
describe('justified row stacks', () => {
  const contentW = TRIM.w - PHOTO_BOOK_CONTENT_MARGIN_MM.inner - PHOTO_BOOK_CONTENT_MARGIN_MM.outer;
  const contentH = TRIM.h - PHOTO_BOOK_CONTENT_MARGIN_MM.top - (PHOTO_BOOK_CONTENT_MARGIN_MM.bottom + 1);

  function renderPages(pages: PhotoBookPlan['sections'][number]['pages'], imgs: PhotoLayoutImage[]): string {
    const plan = basePlan({ sections: [{ title: 'S', pages }] });
    const images = new Map<string, PhotoLayoutImage>([['hero', image('hero')], ...imgs.map((i) => [i.assetId, i] as const)]);
    return renderPhotoBookHtml(baseInput({ plan, images }));
  }

  function parseRows(html: string): { height: number; widths: number[] }[] {
    // Capture each row's height and, in document order, its cell widths.
    const rowChunks = html.split('<div class="ph-jrow"').slice(1);
    return rowChunks.map((chunk) => {
      const height = Number(/height: ([\d.]+)mm/.exec(chunk)![1]);
      const widths = [...chunk.matchAll(/<div class="ph-jcell" style="width: ([\d.]+)mm"/g)].map((m) => Number(m[1]));
      return { height, widths };
    });
  }

  it('a two-vertical pair of portraits shares one height and fills the content width uncropped', () => {
    const html = renderPages(
      [{ template: 'two-vertical', assetIds: ['p1', 'p2'] }],
      [image('p1', 800, 1200), image('p2', 800, 1200)],
    );
    const [row] = parseRows(html);
    // Shared height h solves (2/3)h + (2/3)h + gap = contentW.
    expect(row.height).toBeCloseTo((contentW - 4) / (2 / 3 + 2 / 3), 1);
    for (const w of row.widths) {
      // Cell width = aspect × height — the cell has exactly the photo's shape, so
      // object-fit can never actually crop.
      expect(w / row.height).toBeCloseTo(800 / 1200, 2);
    }
    expect(row.widths.reduce((a, b) => a + b, 0) + 4).toBeCloseTo(contentW, 1);
  });

  it('a three-mixed stack that would overflow the page balances rows instead of cropping', () => {
    const html = renderPages(
      [{ template: 'three-mixed', assetIds: ['l1', 'p1', 'p2'] }],
      [image('l1', 1600, 1200), image('p1', 800, 1200), image('p2', 800, 1200)],
    );
    const rows = parseRows(html);
    expect(rows).toHaveLength(2);
    const total = rows.reduce((sum, r) => sum + r.height, 0) + 4;
    // Balanced to exactly the content box height (the natural stack would overflow it).
    expect(total).toBeCloseTo(contentH, 1);
    // Every cell still has its photo's exact shape.
    expect(rows[0].widths[0] / rows[0].height).toBeCloseTo(1600 / 1200, 2);
    expect(rows[1].widths[0] / rows[1].height).toBeCloseTo(800 / 1200, 2);
  });

  it('four-mixed and collage-6 render as row stacks (1+3 and 3+3)', () => {
    const html = renderPages(
      [
        { template: 'four-mixed', assetIds: ['l1', 'p1', 'p2', 'p3'] },
        { template: 'collage-6', assetIds: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] },
      ],
      [
        image('l1', 1600, 1200),
        image('p1', 800, 1200),
        image('p2', 800, 1200),
        image('p3', 800, 1200),
        image('c1'),
        image('c2'),
        image('c3'),
        image('c4'),
        image('c5'),
        image('c6'),
      ],
    );
    const rows = parseRows(html);
    expect(rows.map((r) => r.widths.length)).toEqual([1, 3, 3, 3]);
  });
});

describe('flowing story text (unified-book plan)', () => {
  const textPlan = (): PhotoBookPlan =>
    basePlan({
      sections: [
        {
          title: 'Omas Sommer',
          storyId: 's1',
          pages: [
            { template: 'text', from: 0, to: 1 },
            { template: 'full-framed', assetIds: ['a4'] },
            { template: 'text', from: 2, to: 2 },
          ],
        },
      ],
    });
  const paragraphs = new Map([['s1', ['Erster Absatz.', 'Zweiter Absatz.', 'Dritter Absatz.']]]);

  it('renders text items as .text-flow divs on the named page, drop cap on the first', () => {
    const html = renderPhotoBookHtml(baseInput({ plan: textPlan(), storyParagraphs: paragraphs }));
    expect(html).toContain('@page text-flow {');
    expect(html).toMatch(/\.text-flow \{[\s\S]*?page: text-flow;[\s\S]*?height: auto;[\s\S]*?max-height: none;[\s\S]*?overflow: visible;[\s\S]*?break-inside: auto;/);
    const flows = html.match(/<div class="text-flow[^"]*">/g) ?? [];
    expect(flows).toEqual(['<div class="text-flow first-of-section">', '<div class="text-flow">']);
    expect(html).toContain('<p>Erster Absatz.</p>');
    expect(html).toContain('<p>Dritter Absatz.</p>');
  });

  it('emits a TOC only for books with story chapters', () => {
    const withText = renderPhotoBookHtml(baseInput({ plan: textPlan(), storyParagraphs: paragraphs }));
    const photoOnly = renderPhotoBookHtml(baseInput());
    expect(withText).toContain('class="page pb-toc"');
    expect(withText).toContain('Omas Sommer');
    expect(photoOnly).not.toContain('class="page pb-toc"');
  });

  it('renders nothing for text items when no paragraphs were provided (dormant-safe)', () => {
    const html = renderPhotoBookHtml(baseInput({ plan: textPlan() }));
    expect(html).not.toContain('class="text-flow');
  });

  it('emits every paragraph of a long story into an unconstrained multipage flow', () => {
    const longParagraphs = Array.from(
      { length: 120 },
      (_, index) => `TEXT-MARKER-${index + 1} ${'Eine lange Geburtstagserinnerung. '.repeat(12)}`,
    );
    const plan: PhotoBookPlan = {
      kind: 'photo',
      style: 'classic',
      cover: { title: 'Geburtstagsbuch' },
      sections: [
        {
          title: 'Lange Geschichte',
          storyId: 'long-story',
          pages: [{ template: 'text', from: 0, to: longParagraphs.length - 1 }],
        },
      ],
    };

    const html = renderPhotoBookHtml(
      baseInput({ plan, storyParagraphs: new Map([['long-story', longParagraphs]]) }),
    );

    for (let index = 1; index <= longParagraphs.length; index++) {
      expect(html.match(new RegExp(`TEXT-MARKER-${index}(?!\\d)`, 'g'))).toHaveLength(1);
    }
    expect(html).toContain('overflow-wrap: anywhere;');
    expect(html).not.toMatch(/\.text-flow\s*\{[^}]*overflow:\s*hidden/);
  });

  it('sets the document language for hyphenation', () => {
    expect(renderPhotoBookHtml(baseInput())).toContain('<html lang="de">');
    expect(renderPhotoBookHtml(baseInput({ language: 'en' }))).toContain('<html lang="en">');
  });

  it('page numbers live only in the text page margin box, per suite', () => {
    const classic = renderPhotoBookHtml(baseInput({ plan: textPlan(), storyParagraphs: paragraphs }));
    expect(classic).toContain('@bottom-center { content: counter(page);');
    const gallery = renderPhotoBookHtml(
      baseInput({
        plan: { ...textPlan(), style: 'gallery' },
        storyParagraphs: paragraphs,
        fontFaceCss: screenFontFaceCss('gallery'),
      }),
    );
    expect(gallery).not.toContain('@bottom-center');
  });
});

describe('dedication page (unified builder)', () => {
  const chapterPlan = () =>
    basePlan({
      sections: [{ title: 'Kapitel', storyId: 's1', pages: [{ template: 'text', from: 0, to: 0 }] }],
    });
  const paragraphs = new Map([['s1', ['Ein Absatz.']]]);

  it('prints the dedication on its own page for a book with chapters', () => {
    const html = renderPhotoBookHtml(
      baseInput({ plan: chapterPlan(), storyParagraphs: paragraphs, dedication: 'Für Oma Hilde' }),
    );
    expect(html).toContain('class="page pb-dedication"');
    expect(html).toContain('Für Oma Hilde');
  });

  it('prints nothing when there is no dedication', () => {
    const html = renderPhotoBookHtml(baseInput({ plan: chapterPlan(), storyParagraphs: paragraphs }));
    expect(html).not.toContain('class="page pb-dedication"');
    expect(renderPhotoBookHtml(baseInput({ plan: chapterPlan(), dedication: '   ' }))).not.toContain(
      'class="page pb-dedication"',
    );
  });

  it('never prints one for a pure photo book, even if the column holds text', () => {
    // The field is only offered for books with chapters; a photo book has no front
    // matter to hang it on, and must keep rendering exactly as it did.
    const html = renderPhotoBookHtml(baseInput({ dedication: 'Für Oma Hilde' }));
    expect(html).not.toContain('pb-dedication');
  });
});
