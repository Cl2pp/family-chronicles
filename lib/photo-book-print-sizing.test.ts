import { describe, expect, it } from 'vitest';
import { PHOTO_BOOK_BLEED_MM, PHOTO_BOOK_CONTENT_MARGIN_MM } from './photo-book-layout';
import { countPhotoBookPages, photoAssetPrintTargetSizeMm } from './photo-book-print-sizing';
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

  it('sizes a two-horizontal photo to full content width, half content height', () => {
    const sizes = photoAssetPrintTargetSizeMm(basePlan(), TRIM);
    expect(sizes.get('a2')).toEqual({ w: contentW, h: contentH / 2 });
    expect(sizes.get('a3')).toEqual({ w: contentW, h: contentH / 2 });
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

  it('gives every photo in a collage-4 an equal quarter of the content box', () => {
    const plan = basePlan({
      sections: [{ title: 'S', pages: [{ template: 'collage-4', assetIds: ['c1', 'c2', 'c3', 'c4'] }] }],
    });
    const sizes = photoAssetPrintTargetSizeMm(plan, TRIM);
    for (const id of ['c1', 'c2', 'c3', 'c4']) {
      expect(sizes.get(id)).toEqual({ w: contentW / 2, h: contentH / 2 });
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
