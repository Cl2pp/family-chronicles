import { describe, expect, it } from 'vitest';
import { PHOTO_BOOK_BLEED_MM, PHOTO_BOOK_CONTENT_MARGIN_MM } from './photo-book-layout';
import { countPhotoBookPages, photoAssetPrintTargetSizeMm, photoSlotPrintWidthsMm } from './photo-book-print-sizing';
import type { PhotoBookPlan } from './photo-book-plan';

/** Pure-function tests for the print-embedding size calculation and page-count estimate —
 *  no DB, no S3, no Chromium (docs/PHOTO_BOOK_PLAN.md PR5's "unit-test the pure parts"
 *  guidance). */

function basePlan(overrides: Partial<PhotoBookPlan> = {}): PhotoBookPlan {
  return {
    kind: 'photo',
    style: 'classic',
    cover: { heroAssetId: 'hero', title: 'Our Family' },
    sections: [
      {
        title: 'Summer 2025',
        pages: [
          { template: 'full-bleed', assetIds: ['a1'] },
          { template: 'two-horizontal', assetIds: ['a2', 'a3'] },
        ],
      },
    ],
    ...overrides,
  };
}

const TRIM = { w: 210, h: 280 };

describe('countPhotoBookPages', () => {
  it('counts cover front + back, one divider per section, and every page', () => {
    // 2 (cover) + 1 (divider) + 2 (pages) = 5.
    expect(countPhotoBookPages(basePlan())).toBe(5);
  });

  it('counts a divider even for an empty section', () => {
    const plan = basePlan({ sections: [{ title: 'Empty', pages: [] }] });
    // 2 (cover) + 1 (divider) + 0 = 3.
    expect(countPhotoBookPages(plan)).toBe(3);
  });

  it('sums across multiple sections', () => {
    const plan = basePlan({
      sections: [
        { title: 'A', pages: [{ template: 'full-bleed', assetIds: ['x'] }] },
        {
          title: 'B',
          pages: [
            { template: 'full-bleed', assetIds: ['y'] },
            { template: 'full-framed', assetIds: ['z'] },
          ],
        },
      ],
    });
    // 2 (cover) + (1 + 1) + (1 + 2) = 7.
    expect(countPhotoBookPages(plan)).toBe(7);
  });

  it('always counts the 2 cover pages even for a content-free plan', () => {
    expect(countPhotoBookPages(basePlan({ sections: [] }))).toBe(2);
  });
});

describe('photoAssetPrintTargetSizeMm', () => {
  const pageW = TRIM.w + PHOTO_BOOK_BLEED_MM * 2;
  const pageH = TRIM.h + PHOTO_BOOK_BLEED_MM * 2;
  const m = PHOTO_BOOK_CONTENT_MARGIN_MM;
  const contentW = pageW - m.inner - m.outer - PHOTO_BOOK_BLEED_MM * 2;
  const contentH = pageH - m.top - m.bottom - PHOTO_BOOK_BLEED_MM * 2;

  it('sizes the cover hero to the full bleed-inclusive page', () => {
    const sizes = photoAssetPrintTargetSizeMm(basePlan(), TRIM);
    expect(sizes.get('hero')).toEqual({ w: pageW, h: pageH });
  });

  it('sizes a full-bleed photo to the content box (it renders inside the shared page frame)', () => {
    const sizes = photoAssetPrintTargetSizeMm(basePlan(), TRIM);
    expect(sizes.get('a1')).toEqual({ w: contentW, h: contentH });
  });

  it('without dimensions, budgets every row-stack slot at the whole content box (errs large)', () => {
    const sizes = photoAssetPrintTargetSizeMm(basePlan(), TRIM);
    expect(sizes.get('a2')).toEqual({ w: contentW, h: contentH });
    expect(sizes.get('a3')).toEqual({ w: contentW, h: contentH });
  });

  it('with dimensions, replays the renderer row math exactly (two-horizontal landscapes)', () => {
    const dims = new Map([
      ['a1', { width: 1600, height: 1067 }],
      ['a2', { width: 4000, height: 3000 }],
      ['a3', { width: 4000, height: 3000 }],
    ]);
    const sizes = photoAssetPrintTargetSizeMm(basePlan(), TRIM, dims);
    // Two full-width rows of one 4:3 landscape each: natural height = contentW / (4/3)
    // per row; the stack overflows contentH, so both rows scale to fit exactly.
    const natural = contentW / (4 / 3);
    const scale = (contentH - 4) / (natural * 2);
    expect(sizes.get('a2')!.h).toBeCloseTo(natural * scale, 1);
    expect(sizes.get('a2')!.w).toBeCloseTo((4 / 3) * natural * scale, 1);
  });

  it('a landscape sharing a justified row with a portrait gets its true (wide) share', () => {
    // The case fixed by the shared row math: fixed per-template fractions budgeted a
    // collage-4 slot at contentW/2, but a 3:2 landscape beside a 2:3 portrait renders
    // ~68% of the row width — the embed must match or the print goes soft.
    const plan = basePlan({
      sections: [
        {
          title: 'Mixed',
          pages: [{ template: 'collage-4', assetIds: ['l1', 'p1', 'l2', 'p2'] }],
        },
      ],
    });
    const dims = new Map([
      ['l1', { width: 3000, height: 2000 }],
      ['p1', { width: 2000, height: 3000 }],
      ['l2', { width: 3000, height: 2000 }],
      ['p2', { width: 2000, height: 3000 }],
    ]);
    const sizes = photoAssetPrintTargetSizeMm(plan, TRIM, dims);
    const rowH = (contentW - 4) / (1.5 + 2 / 3);
    expect(sizes.get('l1')!.w).toBeCloseTo(1.5 * rowH, 1);
    expect(sizes.get('l1')!.w).toBeGreaterThan(contentW / 2 + 20);
    expect(sizes.get('p1')!.w).toBeCloseTo((2 / 3) * rowH, 1);
  });

  it('photoSlotPrintWidthsMm reports the dominant slot of a three-mixed at full content width', () => {
    const plan = basePlan({
      sections: [
        { title: 'S', pages: [{ template: 'three-mixed', assetIds: ['l1', 'p1', 'p2'] }] },
      ],
    });
    const dims = new Map([
      ['l1', { width: 3000, height: 2000 }],
      ['p1', { width: 2000, height: 3000 }],
      ['p2', { width: 2000, height: 3000 }],
    ]);
    const widths = photoSlotPrintWidthsMm(plan, TRIM, dims);
    // The dominant row may scale down to fit the stack, but must stay far wider than
    // the old contentW*2/3 budget — this is what forces the original-quality source.
    expect(widths.get('l1')!).toBeGreaterThan(135);
  });

  it('sizes back-cover photos to the fixed 40x50mm frame', () => {
    const plan = basePlan({ cover: { heroAssetId: 'hero', title: 'T', backAssetIds: ['b1', 'b2'] } });
    const sizes = photoAssetPrintTargetSizeMm(plan, TRIM);
    expect(sizes.get('b1')).toEqual({ w: 40, h: 50 });
    expect(sizes.get('b2')).toEqual({ w: 40, h: 50 });
  });

  it('sizes a full-framed photo to the full content box', () => {
    const plan = basePlan({
      sections: [{ title: 'S', pages: [{ template: 'full-framed', assetIds: ['a4'] }] }],
    });
    const sizes = photoAssetPrintTargetSizeMm(plan, TRIM);
    expect(sizes.get('a4')).toEqual({ w: contentW, h: contentH });
  });

  it('gives four equal squares in a collage-4 an equal quarter-ish share (exact row math)', () => {
    const plan = basePlan({
      sections: [{ title: 'S', pages: [{ template: 'collage-4', assetIds: ['c1', 'c2', 'c3', 'c4'] }] }],
    });
    const dims = new Map(['c1', 'c2', 'c3', 'c4'].map((id) => [id, { width: 1200, height: 1200 }]));
    const sizes = photoAssetPrintTargetSizeMm(plan, TRIM, dims);
    // 2+2 rows of squares: each cell (contentW - gap) / 2 wide and equally tall.
    for (const id of ['c1', 'c2', 'c3', 'c4']) {
      expect(sizes.get(id)!.w).toBeCloseTo((contentW - 4) / 2, 1);
      expect(sizes.get(id)!.h).toBeCloseTo((contentW - 4) / 2, 1);
    }
  });

  it('never returns a size larger than the full bleed-inclusive page (memory bound)', () => {
    const plan = basePlan({
      cover: { heroAssetId: 'hero', title: 'T', backAssetIds: ['b1'] },
      sections: [
        {
          title: 'S',
          pages: [
            { template: 'full-bleed', assetIds: ['a1'] },
            { template: 'divider', assetIds: ['a2'] },
            { template: 'three-mixed', assetIds: ['a3', 'a4', 'a5'] },
            { template: 'collage-5', assetIds: ['a6', 'a7', 'a8', 'a9', 'a10'] },
          ],
        },
      ],
    });
    const sizes = photoAssetPrintTargetSizeMm(plan, TRIM);
    for (const size of sizes.values()) {
      expect(size.w).toBeLessThanOrEqual(pageW);
      expect(size.h).toBeLessThanOrEqual(pageH);
    }
  });
});
