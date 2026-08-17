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

describe('aspect-aware fitting findings', () => {
  it('lets balanced mixed templates accept any first-photo orientation', () => {
    expect(templateFits('four-mixed', [landscape('l'), portrait('a'), portrait('b'), portrait('c')])).toBe(true);
    expect(templateFits('four-mixed', [portrait('a'), landscape('l'), portrait('b'), portrait('c')])).toBe(true);
  });

  it('collage-6 accepts any shape mix', () => {
    expect(
      templateFits('collage-6', [landscape('a'), portrait('b'), landscape('c'), portrait('d'), landscape('e'), portrait('f')]),
    ).toBe(true);
  });

  it('flags a landscape cover and landscape full-bleed page on a portrait book', () => {
    const plan = planOf([{ title: 'Tag 1', pages: [{ template: 'full-bleed', assetIds: ['a'] }] }]);
    const findings = lintPhotoBookPlan(plan, [landscape('hero'), landscape('a')]);
    expect(findings.filter((f) => f.code === 'excessive-crop')).toHaveLength(2);
  });

  it('flags a thin three-column row and names the materially better template', () => {
    const plan = planOf([{ title: 'Tag 1', pages: [{ template: 'three-column', assetIds: ['a', 'b', 'c'] }] }]);
    const findings = lintPhotoBookPlan(plan, [portrait('hero'), portrait('a'), portrait('b'), portrait('c')]);
    expect(findings.map((f) => f.code)).toContain('poor-page-fill');
    expect(findings.find((f) => f.code === 'suboptimal-template')?.message).toContain('three-mixed');
  });
});
