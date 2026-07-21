import { describe, expect, it } from 'vitest';
import {
  PHOTO_BOOK_BLEED_MM,
  PHOTO_BOOK_CONTENT_MARGIN_MM,
  renderPhotoBookHtml,
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
    it('no variant ever emits a `page:` declaration or a named `@page` rule', () => {
      for (const variant of ['screen', 'preview', 'print'] as const) {
        const html = renderPhotoBookHtml(baseInput({ variant }));
        expect(html).not.toMatch(/style="page:/);
        expect(html).not.toMatch(/@page [a-zA-Z][\w-]*\s*\{/); // named @page rule
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
      // The fix relies on `.photo-page:not(.pb-fullbleed):not(.pb-divider-page)` fully
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

    it('bleed pages (cover front/back, full-bleed, divider) size to the full physical sheet with no CSS margin, for every variant', () => {
      for (const variant of ['screen', 'preview', 'print'] as const) {
        const html = renderPhotoBookHtml(baseInput({ variant }));
        const bleed = variant === 'print' ? PHOTO_BOOK_BLEED_MM : 0;
        const pageW = TRIM.w + bleed * 2;
        const pageH = TRIM.h + bleed * 2;
        expect(html).toContain(`.pb-cover-front, .pb-cover-back {\n    width: ${pageW}mm; height: ${pageH}mm;`);
        expect(html).toContain(`.pb-fullbleed { width: ${pageW}mm; height: ${pageH}mm;`);
        expect(html).toContain(`.pb-divider-page { width: ${pageW}mm; height: ${pageH}mm;`);
      }
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
