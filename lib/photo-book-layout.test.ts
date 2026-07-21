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

  it('keeps the content-box margin (trim edge) identical between screen and print', () => {
    // The physical page grows by the bleed for print, but a content-box (non-bleed) page's
    // margin from the TRIM edge — i.e. margin minus bleed — must be unchanged, so
    // `full-framed`/grid photos occupy the identical physical area in both variants.
    const screenHtml = renderPhotoBookHtml(baseInput({ variant: 'screen' }));
    const printHtml = renderPhotoBookHtml(baseInput({ variant: 'print' }));

    const screenMargin = `margin: ${PHOTO_BOOK_CONTENT_MARGIN_MM.top}mm ${PHOTO_BOOK_CONTENT_MARGIN_MM.outer}mm ${PHOTO_BOOK_CONTENT_MARGIN_MM.bottom}mm ${PHOTO_BOOK_CONTENT_MARGIN_MM.inner}mm;`;
    const printMargin = `margin: ${PHOTO_BOOK_CONTENT_MARGIN_MM.top + PHOTO_BOOK_BLEED_MM}mm ${PHOTO_BOOK_CONTENT_MARGIN_MM.outer + PHOTO_BOOK_BLEED_MM}mm ${PHOTO_BOOK_CONTENT_MARGIN_MM.bottom + PHOTO_BOOK_BLEED_MM}mm ${PHOTO_BOOK_CONTENT_MARGIN_MM.inner + PHOTO_BOOK_BLEED_MM}mm;`;

    expect(screenHtml).toContain(screenMargin);
    expect(printHtml).toContain(printMargin);
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

  // Regression coverage for the pagination-crash bug: the self-hosted Paged.js polyfill
  // (screen only — preview/print render through Chromium's own native paged-media engine,
  // `lib/book-render.ts`) cannot reliably paginate a document that uses CSS's named-page
  // mechanism (`page: <ident>` + a matching `@page <ident> { margin: 0 }` rule per bleed
  // page) — reproduced headlessly: pagination stalled after page one and Paged.js's own
  // repeated-layout guard cloned the same page over and over instead of erroring cleanly
  // (`Layout repeated at:` in the console), which is what made a generated book look
  // "just a cover" (bug 3) and made the preview go blank on remount (bug 2). `screen` must
  // never emit ANY named `@page` rule or `page:` declaration; `preview`/`print` still must
  // (that's the real bleed mechanism, and Chromium's native engine handles it fine).
  describe('named @page bleed mechanism (screen vs. preview/print)', () => {
    it('screen never emits a `page:` declaration or a named `@page` rule', () => {
      const html = renderPhotoBookHtml(baseInput({ variant: 'screen' }));
      expect(html).not.toMatch(/style="page:/);
      expect(html).not.toMatch(/@page pb-bleed-\d+/);
    });

    it('preview and print still emit `page:` declarations and matching named `@page { margin: 0; }` rules', () => {
      for (const variant of ['preview', 'print'] as const) {
        const html = renderPhotoBookHtml(baseInput({ variant }));
        expect(html).toMatch(/style="page: pb-bleed-0"/);
        expect(html).toMatch(/@page pb-bleed-0 \{ margin: 0; \}/);
        // Cover front, cover back, and the one section's divider — 3 named bleed pages
        // for this fixture's plan (the section's full-bleed photo page is a 4th).
        expect(html).toMatch(/@page pb-bleed-3 \{ margin: 0; \}/);
      }
    });

    it("screen's base @page rule has margin 0 for every page; preview/print keep the content-box margin as the base and override to 0 per named bleed page", () => {
      const screenHtml = renderPhotoBookHtml(baseInput({ variant: 'screen' }));
      const printHtml = renderPhotoBookHtml(baseInput({ variant: 'print' }));

      // `[^}]*` (not `[\s\S]*?`) deliberately can't cross a `}` — this must only match
      // within the SAME unnamed `@page { ... }` block, never spill into an unrelated
      // named `@page pb-bleed-N { margin: 0; }` rule later in the stylesheet.
      expect(screenHtml).toMatch(/@page \{[^}]*margin: 0;[^}]*\}/);
      expect(printHtml).not.toMatch(/@page \{[^}]*margin: 0;[^}]*\}/);
    });

    it("a content-box (non-bleed) photo page's own margin/size is unaffected by the screen-only @page change", () => {
      // The fix relies on `.photo-page:not(.pb-fullbleed):not(.pb-divider-page)` already
      // fully implementing the content-box inset via its own CSS — this just pins that
      // down so a future edit can't quietly break it.
      const screenHtml = renderPhotoBookHtml(baseInput({ variant: 'screen' }));
      expect(screenHtml).toContain(
        `margin: ${PHOTO_BOOK_CONTENT_MARGIN_MM.top}mm ${PHOTO_BOOK_CONTENT_MARGIN_MM.outer}mm ${PHOTO_BOOK_CONTENT_MARGIN_MM.bottom}mm ${PHOTO_BOOK_CONTENT_MARGIN_MM.inner}mm;`,
      );
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
