import { describe, expect, it } from 'vitest';
import { lintPhotoBookPlan, lintScore, templateFits, type LintPhoto } from './photo-book-lint';
import type { PhotoBookPlan } from './photo-book-plan';

const portrait = (id: string): LintPhoto => ({ assetId: id, width: 3000, height: 4000 });
const landscape = (id: string): LintPhoto => ({ assetId: id, width: 4000, height: 3000 });

function planOf(sections: PhotoBookPlan['sections']): PhotoBookPlan {
  return { kind: 'photo', style: 'classic', cover: { heroAssetId: 'hero', title: 'Buch' }, sections };
}

describe('empty-page finding', () => {
  it('flags a photo-less page as a blank page — the heaviest defect after none', () => {
    const plan = planOf([
      {
        title: 'Tag 1',
        pages: [
          { template: 'divider', assetIds: [] },
          { template: 'full-framed', assetIds: ['a'] },
        ],
      },
    ]);
    const findings = lintPhotoBookPlan(plan, [landscape('hero'), portrait('a')]);
    const empty = findings.filter((f) => f.code === 'empty-page');
    expect(empty).toHaveLength(1);
    expect(empty[0].sectionIndex).toBe(0);
    expect(empty[0].pageIndex).toBe(0);
    // An empty page must outweigh every other single finding so a review round that
    // fixes it always scores as an improvement.
    expect(lintScore(empty)).toBeGreaterThan(10);
  });

  it('does not flag pages that hold photos', () => {
    const plan = planOf([
      { title: 'Tag 1', pages: [{ template: 'two-vertical', assetIds: ['a', 'b'] }, { template: 'full-framed', assetIds: ['c'] }] },
    ]);
    const findings = lintPhotoBookPlan(plan, [portrait('a'), portrait('b'), portrait('c'), landscape('hero')]);
    expect(findings.filter((f) => f.code === 'empty-page')).toHaveLength(0);
  });
});

describe('four-mixed shape rule', () => {
  it('accepts a landscape-first four-mixed and rejects a portrait-first one', () => {
    expect(templateFits('four-mixed', [landscape('l'), portrait('a'), portrait('b'), portrait('c')])).toBe(true);
    expect(templateFits('four-mixed', [portrait('a'), landscape('l'), portrait('b'), portrait('c')])).toBe(false);
  });

  it('collage-6 accepts any shape mix', () => {
    expect(
      templateFits('collage-6', [landscape('a'), portrait('b'), landscape('c'), portrait('d'), landscape('e'), portrait('f')]),
    ).toBe(true);
  });
});
