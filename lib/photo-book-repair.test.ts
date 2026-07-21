import { describe, expect, it } from 'vitest';
import { checkPhotoBookPlanConsistency, type PhotoBookPlan } from '@/lib/photo-book-plan';
import { lintPhotoBookPlan, type LintPhoto } from '@/lib/photo-book-lint';
import { repairPhotoBookPlan, templateForGroup } from '@/lib/photo-book-repair';

const portrait = (id: string): LintPhoto => ({ assetId: id, width: 3000, height: 4000 });
const landscape = (id: string): LintPhoto => ({ assetId: id, width: 4000, height: 3000 });

function planOf(sections: PhotoBookPlan['sections'], cover: Partial<PhotoBookPlan['cover']> = {}): PhotoBookPlan {
  return { kind: 'photo', style: 'classic', cover: { title: 'Buch', ...cover }, sections };
}

function contentOf(photos: LintPhoto[]) {
  return { availableAssetIds: photos.map((p) => p.assetId), allAssetIds: photos.map((p) => p.assetId) };
}

describe('templateForGroup', () => {
  it('keeps three portraits as a three-column row', () => {
    const { template } = templateForGroup([portrait('a'), portrait('b'), portrait('c')]);
    expect(template).toBe('three-column');
  });

  it('switches a trio containing a landscape to three-mixed, landscape first', () => {
    const { template, ordered } = templateForGroup([portrait('a'), landscape('b'), portrait('c')]);
    expect(template).toBe('three-mixed');
    expect(ordered[0].assetId).toBe('b');
  });

  it('stacks a pair of landscapes but rows a mixed pair', () => {
    expect(templateForGroup([landscape('a'), landscape('b')]).template).toBe('two-horizontal');
    expect(templateForGroup([landscape('a'), portrait('b')]).template).toBe('two-vertical');
  });
});

describe('repairPhotoBookPlan', () => {
  it('leaves a clean plan untouched', () => {
    const photos = [portrait('a'), portrait('b'), portrait('c'), landscape('hero')];
    const plan = planOf([{ title: 'Tag 1', pages: [{ template: 'three-column', assetIds: ['a', 'b', 'c'] }] }], {
      heroAssetId: 'hero',
    });
    const { plan: repaired, changes } = repairPhotoBookPlan(plan, { photos });
    expect(changes).toEqual([]);
    expect(repaired).toEqual(plan);
  });

  it('drops a duplicated photo and re-fits the page instead of discarding the plan', () => {
    const photos = [landscape('hero'), portrait('a'), portrait('b')];
    // The model placed the cover hero on an interior page too — the exact single flaw that
    // used to make the whole design pass fall back to the auto layout.
    const plan = planOf([{ title: 'Tag 1', pages: [{ template: 'three-column', assetIds: ['hero', 'a', 'b'] }] }], {
      heroAssetId: 'hero',
    });
    const { plan: repaired, changes } = repairPhotoBookPlan(plan, { photos });
    expect(changes.join(' ')).toContain('re-fitted');
    expect(repaired.sections[0].pages[0].assetIds).toEqual(['a', 'b']);
    expect(repaired.cover.heroAssetId).toBe('hero');
    expect(checkPhotoBookPlanConsistency(repaired, contentOf(photos))).toEqual([]);
  });

  it('drops references to photos that are no longer available', () => {
    const photos = [landscape('hero'), portrait('a')];
    const plan = planOf(
      [{ title: 'Tag 1', pages: [{ template: 'two-vertical', assetIds: ['a', 'gone'] }] }],
      { heroAssetId: 'hero' },
    );
    const { plan: repaired } = repairPhotoBookPlan(plan, { photos });
    expect(repaired.sections[0].pages[0]).toMatchObject({ template: 'full-framed', assetIds: ['a'] });
    expect(checkPhotoBookPlanConsistency(repaired, contentOf(photos))).toEqual([]);
  });

  it('removes a section that lost every photo', () => {
    const photos = [landscape('hero'), portrait('a')];
    const plan = planOf(
      [
        { title: 'Tag 1', pages: [{ template: 'full-framed', assetIds: ['a'] }] },
        { title: 'Tag 2', pages: [{ template: 'two-vertical', assetIds: ['gone1', 'gone2'] }] },
      ],
      { heroAssetId: 'hero' },
    );
    const { plan: repaired } = repairPhotoBookPlan(plan, { photos });
    expect(repaired.sections).toHaveLength(1);
    expect(checkPhotoBookPlanConsistency(repaired, contentOf(photos))).toEqual([]);
  });

  it('places a force-included photo the model left out', () => {
    const photos = [landscape('hero'), portrait('a'), portrait('mine')];
    const plan = planOf([{ title: 'Tag 1', pages: [{ template: 'full-framed', assetIds: ['a'] }] }], {
      heroAssetId: 'hero',
    });
    const { plan: repaired } = repairPhotoBookPlan(plan, { photos, mustInclude: ['mine'] });
    const placed = repaired.sections.flatMap((s) => s.pages.flatMap((p) => p.assetIds));
    expect(placed).toContain('mine');
    expect(checkPhotoBookPlanConsistency(repaired, contentOf(photos))).toEqual([]);
  });

  it('gives a book with content a cover hero when the plan has none', () => {
    const photos = [portrait('a'), portrait('b')];
    const plan = planOf([{ title: 'Tag 1', pages: [{ template: 'two-vertical', assetIds: ['a', 'b'] }] }]);
    const { plan: repaired } = repairPhotoBookPlan(plan, { photos });
    expect(repaired.cover.heroAssetId).toBeTruthy();
    expect(checkPhotoBookPlanConsistency(repaired, contentOf(photos))).toEqual([]);
  });

  it('borrows from page one when every photo is already placed', () => {
    const photos = [portrait('a'), portrait('b'), portrait('c')];
    const plan = planOf([{ title: 'Tag 1', pages: [{ template: 'three-column', assetIds: ['a', 'b', 'c'] }] }]);
    const { plan: repaired } = repairPhotoBookPlan(plan, { photos });
    expect(repaired.cover.heroAssetId).toBe('a');
    expect(repaired.sections[0].pages[0].assetIds).toEqual(['b', 'c']);
    expect(checkPhotoBookPlanConsistency(repaired, contentOf(photos))).toEqual([]);
  });

  it('drops captions a re-fitted template can no longer render', () => {
    const photos = [landscape('hero'), portrait('a'), portrait('b'), portrait('c'), portrait('d')];
    const plan = planOf(
      [
        {
          title: 'Tag 1',
          pages: [
            { template: 'three-column', assetIds: ['a', 'b', 'gone'], captions: ['eins', null, 'drei'] },
            { template: 'full-framed', assetIds: ['c'], captions: ['vier'] },
          ],
        },
      ],
      { heroAssetId: 'hero' },
    );
    const { plan: repaired } = repairPhotoBookPlan(plan, { photos });
    expect(repaired.sections[0].pages[0]).toMatchObject({
      template: 'two-vertical',
      assetIds: ['a', 'b'],
      captions: ['eins', null],
    });
    expect(checkPhotoBookPlanConsistency(repaired, contentOf(photos))).toEqual([]);
  });

  it('produces a lint-clean layout for a mixed-orientation trio', () => {
    const photos = [landscape('hero'), portrait('a'), landscape('b'), portrait('c')];
    const plan = planOf([{ title: 'Tag 1', pages: [{ template: 'three-column', assetIds: ['a', 'b', 'c'] }] }], {
      heroAssetId: 'hero',
    });
    // The incoming plan is structurally legal but visually broken — a landscape squashing
    // a 3-up row is exactly what the linter flags.
    expect(lintPhotoBookPlan(plan, photos).map((f) => f.code)).toContain('template-orientation');
    const { plan: repaired } = repairPhotoBookPlan(plan, { photos });
    expect(repaired.sections[0].pages[0].template).toBe('three-mixed');
    expect(lintPhotoBookPlan(repaired, photos).filter((f) => f.code === 'template-orientation')).toEqual([]);
  });
});
