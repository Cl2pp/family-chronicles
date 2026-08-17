import { describe, expect, it } from 'vitest';
import {
  birthdayCoverFrontGeometryMm,
  estimateBirthdayCoverTitleMm,
  estimateTextFlowHeightMm,
  PHOTO_BOOK_BLEED_MM,
  PHOTO_CAPTION_RESERVE_MM,
  PHOTO_BOOK_CONTENT_MARGIN_MM,
  PHOTO_GAP_MM,
  renderPhotoBookHtml,
  rowStackGeometryMm,
  type PhotoLayoutImage,
  type PhotoLayoutInput,
} from './photo-book-layout';
import { PHOTO_BOOK_STYLES, type PhotoBookPlan } from './photo-book-plan';
import { PHOTO_STYLE_TOKENS } from './photo-book-styles';
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
    // Title only under the chapter heading: a Birthday chapter prints no date, even though
    // the section still carries its `dateLabel` for the standard recipe's divider/contents.
    expect(html).toContain('<header class="pb-story-heading"><h2>Omas Geburtstag</h2></header>');
    expect(html).not.toContain('12. Mai 2025');
    expect(html).toContain('break-before: left');
    expect(html).toContain('<p class="pb-cover-subtitle">July 2026</p>');
    expect(html).not.toContain('<section class="page pb-toc">');
    expect(html).not.toContain('<section class="page pb-divider">');
    // Two paragraphs are far short of a page, so the collage joins them inside the text
    // flow instead of taking a sheet of its own (see the shared-photos suite below).
    expect(html.indexOf('Der erste Absatz.')).toBeLessThan(html.indexOf('class="pb-shared-photos"'));
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

  it('lays the Birthday cover collage out as one square grid of equal tiles', () => {
    // The cover front is a COLUMN inside a 10mm/10mm/18mm inset: the collage band on top,
    // the title block under it in normal flow. So the collage is the largest square that
    // fits once the title's own estimated height (and a 4mm gap) is reserved. Asserted in
    // mm rather than by class name because "the tiles are square" is a NUMBER, and
    // Chromium and Paged.js only agree when the tracks are fixed lengths.
    const birthday = basePlan({
      template: 'birthday',
      cover: { heroAssetId: 'a1', assetIds: ['a1', 'a2', 'a3'], title: 'Birthday Book' },
      sections: [{ title: 'S', storyId: 's1', pages: [{ template: 'full-framed', assetIds: ['a4'] }] }],
    });

    // screen/preview: 210x280 sheet, no bleed -> inner 190 x 252, and a one-line title
    // reserves ~26.87mm, so the WIDTH decides: side 190, cell 93.
    const screenHtml = renderPhotoBookHtml(baseInput({ plan: birthday, variant: 'screen' }));
    expect(screenHtml).toMatch(
      /\.pb-birthday-cover-collage \{\s*flex: 0 0 auto;\s*width: 190\.00mm;\s*height: 190\.00mm;/,
    );
    expect(screenHtml).toContain('grid-template-columns: repeat(2, 93.00mm);');
    expect(screenHtml).toContain('grid-auto-rows: 93.00mm;');
    // The band can never be squeezed below the collage, whatever the title does.
    expect(screenHtml).toMatch(/\.pb-birthday-cover-band \{[^}]*min-height: 190\.00mm;/);

    // print: the same sheet plus 3mm bleed all round -> inner 196 x 258 -> side 196, cell 96.
    const printHtml = renderPhotoBookHtml(baseInput({ plan: birthday, variant: 'print' }));
    expect(printHtml).toMatch(/\.pb-birthday-cover-collage \{[^}]*width: 196\.00mm;\s*height: 196\.00mm;/);
    expect(printHtml).toContain('grid-template-columns: repeat(2, 96.00mm);');

    // A square 20x20 book is the height-constrained case: what the title block leaves of
    // the 178mm-tall inner box, not the page width, decides the collage size.
    const squareHtml = renderPhotoBookHtml(
      baseInput({ plan: birthday, variant: 'print', trim: { w: 200, h: 200 } }),
    );
    expect(squareHtml).toMatch(
      /\.pb-birthday-cover-collage \{\s*flex: 0 0 auto;\s*width: 147\.13mm;\s*height: 147\.13mm;/,
    );
    expect(squareHtml).toContain('grid-template-columns: repeat(2, 71.56mm);');

    // Nothing restretches a tile with the count, and no jaunty per-tile rotation survives
    // (the remaining `rotate()` rules in the sheet belong to the tape ornament and
    // watermark). Scoped to the collage's own rules: an unrelated future grid elsewhere in
    // the stylesheet is none of this test's business.
    for (const html of [screenHtml, printHtml, squareHtml]) {
      const collageRules = html.match(/\.pb-birthday-cover-(photo|collage)[^{]*\{[^}]*\}/g) ?? [];
      expect(collageRules.length).toBeGreaterThan(0);
      expect(collageRules.join('\n')).not.toMatch(/grid-column: span|transform/);
    }
  });

  it('sizes every Birthday cover count off the same square: 1 fills it, 3 centre the odd tile', () => {
    // 21x28 print: a 196mm square of 96mm tiles. One photo takes the whole 196mm square
    // (a lone 96mm tile was a quarter-size stamp marooned in cover colour); three keep the
    // 96mm tile and centre the third across the bottom row, so no quadrant sits empty.
    const cover = (n: number) =>
      renderPhotoBookHtml(
        baseInput({
          variant: 'print',
          plan: basePlan({
            template: 'birthday',
            cover: {
              heroAssetId: 'a1',
              assetIds: ['a1', 'a2', 'a3', 'a4'].slice(0, n),
              title: 'Birthday Book',
            },
            sections: [
              { title: 'S', storyId: 's1', pages: [{ template: 'full-framed', assetIds: ['a4'] }] },
            ],
          }),
        }),
      );

    for (const n of [1, 2, 3, 4]) {
      const html = cover(n);
      expect(html).toContain(`class="pb-birthday-cover-collage" data-count="${n}"`);
      // The 2x2 track is what 2, 3 and 4 photos all lay out on.
      expect(html).toContain('grid-template-columns: repeat(2, 96.00mm);');
      expect(html).toContain('grid-auto-rows: 96.00mm;');
      // One photo overrides both tracks to the full square.
      expect(html).toMatch(
        /\.pb-birthday-cover-collage\[data-count="1"\] \{\s*grid-template-columns: 196\.00mm;\s*grid-auto-rows: 196\.00mm;\s*\}/,
      );
      // Three centre the third tile across the bottom row, at the same 96mm square.
      expect(html).toMatch(
        /\.pb-birthday-cover-collage\[data-count="3"\] \.pb-birthday-cover-photo:nth-child\(3\) \{\s*grid-column: 1 \/ span 2;\s*justify-self: center;\s*width: 96\.00mm;\s*\}/,
      );
      expect(html.match(/class="pb-birthday-cover-photo /g) ?? []).toHaveLength(n);
    }
  });

  it('puts the Birthday title straight on the cover colour, with no panel or scrim behind it', () => {
    // The panel used to cut a visible straight edge through the drop shadows of the tiles
    // above it, and .pb-cover-text's photo scrim (a Birthday heroAssetId is just the first
    // collage tile, not a backdrop) would darken the same strip.
    const birthday = renderPhotoBookHtml(
      baseInput({
        plan: basePlan({
          template: 'birthday',
          cover: { heroAssetId: 'a1', assetIds: ['a1', 'a2'], title: 'Birthday Book' },
          sections: [{ title: 'S', storyId: 's1', pages: [{ template: 'full-framed', assetIds: ['a4'] }] }],
        }),
      }),
    );
    expect(birthday).not.toMatch(/\.pb-birthday-cover-text \{[^}]*background:/);
    expect(birthday).toMatch(/\.pb-cover-text \{[^}]*background: none;/);
    expect(birthday).not.toMatch(/\.pb-cover-text \{[^}]*color: #fff;/);

    // A standard cover over a real backdrop photo keeps its scrim and white type.
    const standard = renderPhotoBookHtml(baseInput());
    expect(standard).toMatch(/\.pb-cover-text \{[^}]*background: linear-gradient\(transparent, rgba\(0,0,0,0\.55\) 55%\);/);
    expect(standard).toMatch(/\.pb-cover-text \{[^}]*color: #fff;/);
  });

  it('keeps the section date on a standard divider, and off a Birthday chapter heading', () => {
    const standard = renderPhotoBookHtml(baseInput());
    expect(standard).toContain('<p class="pb-divider-date">June 2025</p>');

    const birthday = basePlan({
      template: 'birthday',
      cover: { heroAssetId: 'a1', assetIds: ['a1'], title: 'Birthday Book' },
      sections: [
        {
          title: 'Omas Geburtstag',
          dateLabel: 'June 2025',
          storyId: 's1',
          pages: [{ template: 'text', from: 0, to: 0 }],
        },
      ],
    });
    const html = renderPhotoBookHtml(
      baseInput({ plan: birthday, storyParagraphs: new Map([['s1', ['Ein Absatz.']]]) }),
    );
    expect(html).toContain('<header class="pb-story-heading"><h2>Omas Geburtstag</h2></header>');
    expect(html).not.toContain('June 2025');
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

describe('Birthday chapter: photos shared with the story page', () => {
  /** One Birthday chapter: `paragraphs` of prose, then a four-photo group, then a
   *  single-photo page — the shape `paceChapter` emits (lib/photo-book-autolayout.ts). */
  const birthdayPlan = (paragraphCount: number): PhotoBookPlan =>
    basePlan({
      template: 'birthday',
      cover: { heroAssetId: 'a1', assetIds: ['a1', 'a2'], title: 'Geburtstagsbuch' },
      sections: [
        {
          title: 'Omas Geburtstag',
          storyId: 's1',
          pages: [
            { template: 'text', from: 0, to: paragraphCount - 1 },
            { template: 'four-mixed', assetIds: ['a1', 'a2', 'a3', 'a4'] },
            { template: 'full-framed', assetIds: ['hero'] },
          ],
        },
      ],
    });
  const short = ['Liebe Oma, danke für jeden Sonntagnachmittag in deiner Küche. Alles Gute!'];
  const long = Array.from({ length: 40 }, (_, i) => `Absatz ${i + 1}. ${'Eine lange Erinnerung. '.repeat(14)}`);

  it('moves a short chapter’s first photo group into its own text flow', () => {
    const html = renderPhotoBookHtml(
      baseInput({ plan: birthdayPlan(short.length), storyParagraphs: new Map([['s1', short]]) }),
    );
    // The group renders inside the flow, after the prose — not as a sheet of its own …
    expect(html).toMatch(/<p>Liebe Oma[^<]*<\/p>\s*<div class="pb-shared-photos" style="height: [\d.]+mm">/);
    // … and the chapter's OTHER photo page is untouched.
    expect(html.match(/class="page photo-page/g) ?? []).toHaveLength(1);
    expect(html).toContain('class="page photo-page pb-framed"');
    expect(html).toMatch(/\.pb-shared-photos \{[\s\S]*?break-inside: avoid;/);
  });

  it('leaves a long chapter’s photos on their own pages', () => {
    const html = renderPhotoBookHtml(
      baseInput({ plan: birthdayPlan(long.length), storyParagraphs: new Map([['s1', long]]) }),
    );
    expect(html).not.toContain('class="pb-shared-photos"');
    expect(html.match(/class="page photo-page/g) ?? []).toHaveLength(2);
  });

  it('never shares a page in the standard recipe, however short the story', () => {
    const plan = birthdayPlan(short.length);
    const html = renderPhotoBookHtml(
      baseInput({
        plan: { ...plan, template: 'standard' },
        storyParagraphs: new Map([['s1', short]]),
      }),
    );
    // The rule ships with every chaptered book (like .pb-birthday-story-start); what must
    // never appear in a standard book is the markup that uses it.
    expect(html).not.toContain('<div class="pb-shared-photos"');
    expect(html.match(/class="page photo-page/g) ?? []).toHaveLength(2);
  });

  it('decides and sizes the shared block identically in screen, preview and print', () => {
    // The named text page's content box is the same physical box in all three variants
    // (bleed grows the sheet and the margins add it back), so the block the reader
    // approves in the preview is the block the print file carries.
    const blocks = (['screen', 'preview', 'print'] as const).map((variant) => {
      const html = renderPhotoBookHtml(
        baseInput({
          variant,
          plan: birthdayPlan(short.length),
          storyParagraphs: new Map([['s1', short]]),
        }),
      );
      return /<div class="pb-shared-photos"[\s\S]*?<\/div>\s*<\/div>/.exec(html)![0];
    });
    expect(blocks[1]).toBe(blocks[0]);
    expect(blocks[2]).toBe(blocks[0]);
  });
});

describe('estimateTextFlowHeightMm', () => {
  const style = PHOTO_STYLE_TOKENS.classic;

  it('grows with the amount of prose and shrinks as the column widens', () => {
    const one = estimateTextFlowHeightMm({ paragraphs: ['Ein kurzer Satz.'], widthMm: 178, style });
    const three = estimateTextFlowHeightMm({
      paragraphs: ['Ein kurzer Satz.', 'Ein kurzer Satz.', 'Ein kurzer Satz.'],
      widthMm: 178,
      style,
    });
    expect(three).toBeGreaterThan(one);

    const paragraphs = ['Ein deutlich längerer Absatz, der über mehrere Zeilen läuft. '.repeat(6)];
    expect(estimateTextFlowHeightMm({ paragraphs, widthMm: 90, style })).toBeGreaterThan(
      estimateTextFlowHeightMm({ paragraphs, widthMm: 178, style }),
    );
  });

  it('counts the chapter heading and the opening drop cap', () => {
    const bare = estimateTextFlowHeightMm({ paragraphs: ['Kurz.'], widthMm: 178, style });
    const withHeading = estimateTextFlowHeightMm({
      paragraphs: ['Kurz.'],
      heading: 'Omas Geburtstag',
      widthMm: 178,
      style,
    });
    // Heading line (21pt × 1.15 ≈ 8.5mm) plus its 10mm gap.
    expect(withHeading - bare).toBeGreaterThan(15);
    // `modern` has no drop cap, `classic` scales the first letter 1.6× — so the same text
    // is estimated taller under classic.
    expect(bare).toBeGreaterThan(
      estimateTextFlowHeightMm({ paragraphs: ['Kurz.'], widthMm: 178, style: PHOTO_STYLE_TOKENS.modern }),
    );
  });

  it('errs high: a real column fits more text than the estimate assumes', () => {
    // 178mm at 10.5pt is ~90 characters of Playfair per line in practice; the estimate
    // deliberately assumes a wider glyph, so a 90-character paragraph must never come out
    // as a single line.
    const height = estimateTextFlowHeightMm({ paragraphs: ['x'.repeat(90)], widthMm: 178, style });
    const oneLine = 10.5 * (25.4 / 72) * 1.55;
    expect(height).toBeGreaterThan(oneLine * 1.5);
  });
});

describe('birthdayCoverFrontGeometryMm', () => {
  /** Deliberately squarish, so the HEIGHT binds and the title's reserve is what decides the
   *  square. On a tall 21×28 sheet the width binds instead and the title is free. */
  const inner = { w: 190, h: 160 };
  const short = { title: 'Omas Geburtstag', subtitle: 'August 2026' };

  it('is capped by the width when the sheet is tall enough for any title', () => {
    const tall = birthdayCoverFrontGeometryMm({ inner: { w: 190, h: 252 }, ...short });
    expect(tall.side).toBe(190);
  });

  it('takes the title block out of the collage, not out of thin air', () => {
    const one = birthdayCoverFrontGeometryMm({ inner, ...short });
    const many = birthdayCoverFrontGeometryMm({
      inner,
      title: 'Zum achtzigsten Geburtstag unserer lieben Oma Margarete Wilhelmine Auguste',
      subtitle: short.subtitle,
    });
    // A wrapping title reserves more, so the square it leaves is smaller — and both squares
    // plus their own title reserve still fit inside the box.
    expect(many.titleMm).toBeGreaterThan(one.titleMm);
    expect(many.side).toBeLessThan(one.side);
    for (const geometry of [one, many]) {
      expect(geometry.side + geometry.titleMm).toBeLessThanOrEqual(inner.h);
      expect(geometry.side).toBeLessThanOrEqual(inner.w);
      // The 2×2 tiles are the square, minus the one gap between them.
      expect(geometry.cell * 2 + PHOTO_GAP_MM).toBeCloseTo(geometry.side, 6);
    }
  });

  it('never returns a negative square, however absurd the title', () => {
    const squeezed = birthdayCoverFrontGeometryMm({
      inner: { w: 190, h: 60 },
      title: 'Ein wirklich unfassbar langer Geburtstagsbuchtitel '.repeat(8),
      subtitle: short.subtitle,
    });
    expect(squeezed.side).toBeGreaterThan(0);
    expect(squeezed.cell).toBeGreaterThanOrEqual(0);
  });

  it('errs high on the title, so the reserve can only ever be too generous', () => {
    // 174mm at 26pt is ~34 characters of Playfair per line in practice; like
    // `estimateTextFlowHeightMm`, this assumes a wider glyph, so a 34-character title must
    // never be estimated as fitting on one line.
    const oneLineMm = 26 * (25.4 / 72) * 1.5;
    const twoLines = estimateBirthdayCoverTitleMm({ title: 'x'.repeat(34), subtitle: 'x', widthMm: 174 });
    const oneLine = estimateBirthdayCoverTitleMm({ title: 'x'.repeat(10), subtitle: 'x', widthMm: 174 });
    expect(twoLines - oneLine).toBeCloseTo(oneLineMm, 6);
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
