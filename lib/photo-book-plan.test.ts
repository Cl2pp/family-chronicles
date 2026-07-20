import { describe, expect, it } from 'vitest';
import {
  checkPhotoBookPlanConsistency,
  validatePhotoBookPlan,
  type PhotoBookPlan,
  type PhotoPlanContent,
} from './photo-book-plan';

function basePlan(overrides: Partial<PhotoBookPlan> = {}): PhotoBookPlan {
  return {
    kind: 'photo',
    style: 'classic',
    cover: { heroAssetId: 'a1', title: 'Our Family' },
    sections: [
      {
        title: 'Juni 2025',
        pages: [
          { template: 'full-bleed', assetIds: ['a4'] },
          { template: 'two-horizontal', assetIds: ['a2', 'a3'] },
        ],
      },
    ],
    ...overrides,
  };
}

function contentFor(ids: string[], excludedIds: string[] = []): PhotoPlanContent {
  const excluded = new Set(excludedIds);
  return {
    availableAssetIds: ids.filter((id) => !excluded.has(id)),
    allAssetIds: ids,
  };
}

describe('validatePhotoBookPlan', () => {
  it('accepts a well-formed plan', () => {
    const result = validatePhotoBookPlan(basePlan());
    expect(result.ok).toBe(true);
  });

  it('rejects a plan missing kind/style', () => {
    const result = validatePhotoBookPlan({ cover: { title: 'x' }, sections: [] });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown style id', () => {
    const result = validatePhotoBookPlan(basePlan({ style: 'heirloom' as PhotoBookPlan['style'] }));
    expect(result.ok).toBe(false);
  });

  it('rejects a two-horizontal page with the wrong number of photos', () => {
    const plan = basePlan();
    plan.sections[0].pages[1] = { template: 'two-horizontal', assetIds: ['a2'] };
    const result = validatePhotoBookPlan(plan);
    expect(result.ok).toBe(false);
  });

  it('rejects a full-bleed page with two photos', () => {
    const plan = basePlan();
    plan.sections[0].pages[0] = { template: 'full-bleed', assetIds: ['a1', 'a2'] } as never;
    const result = validatePhotoBookPlan(plan);
    expect(result.ok).toBe(false);
  });

  it('accepts a divider page with zero or one photo', () => {
    const noPhoto = basePlan();
    noPhoto.sections[0].pages = [{ template: 'divider', assetIds: [] }];
    expect(validatePhotoBookPlan(noPhoto).ok).toBe(true);

    const onePhoto = basePlan();
    onePhoto.sections[0].pages = [{ template: 'divider', assetIds: ['a1'] }];
    expect(validatePhotoBookPlan(onePhoto).ok).toBe(true);
  });

  it('rejects a divider page with two photos', () => {
    const plan = basePlan();
    plan.sections[0].pages = [{ template: 'divider', assetIds: ['a1', 'a2'] } as never];
    expect(validatePhotoBookPlan(plan).ok).toBe(false);
  });

  it('accepts a plan with no cover hero (empty book)', () => {
    const plan = basePlan({ cover: { title: 'Empty Book' }, sections: [] });
    expect(validatePhotoBookPlan(plan).ok).toBe(true);
  });

  it('rejects a mismatched captions array length', () => {
    const plan = basePlan();
    plan.sections[0].pages[1] = {
      template: 'two-horizontal',
      assetIds: ['a2', 'a3'],
      captions: ['only one'],
    } as never;
    expect(validatePhotoBookPlan(plan).ok).toBe(false);
  });
});

describe('checkPhotoBookPlanConsistency', () => {
  it('finds no problems for a consistent plan', () => {
    const content = contentFor(['a1', 'a2', 'a3', 'a4']);
    expect(checkPhotoBookPlanConsistency(basePlan(), content)).toEqual([]);
  });

  it('flags a cover hero that does not exist in the book', () => {
    const content = contentFor(['a1', 'a2', 'a3', 'a4'].filter((id) => id !== 'a1'));
    const problems = checkPhotoBookPlanConsistency(basePlan(), content);
    expect(problems.some((p) => p.includes('Cover') && p.includes('a1'))).toBe(true);
  });

  it('flags a reference to an excluded photo', () => {
    const content = contentFor(['a1', 'a2', 'a3', 'a4'], ['a2']);
    const problems = checkPhotoBookPlanConsistency(basePlan(), content);
    expect(problems.some((p) => p.includes('excluded') && p.includes('a2'))).toBe(true);
  });

  it('flags a photo placed twice in the book', () => {
    const plan = basePlan();
    plan.sections.push({
      title: 'Juli 2025',
      pages: [{ template: 'full-framed', assetIds: ['a1'] }],
    });
    const content = contentFor(['a1', 'a2', 'a3', 'a4']);
    const problems = checkPhotoBookPlanConsistency(plan, content);
    expect(problems.some((p) => p.includes('placed 2 times') && p.includes('a1'))).toBe(true);
  });

  it('flags a section with zero pages', () => {
    const plan = basePlan();
    plan.sections.push({ title: 'Empty section', pages: [] });
    const content = contentFor(['a1', 'a2', 'a3', 'a4']);
    const problems = checkPhotoBookPlanConsistency(plan, content);
    expect(problems.some((p) => p.includes('Empty section') && p.includes('no pages'))).toBe(true);
  });

  it('flags a back-cover photo that is also used in a section (double use)', () => {
    const plan = basePlan({ cover: { heroAssetId: 'a1', title: 'x', backAssetIds: ['a2'] } });
    const content = contentFor(['a1', 'a2', 'a3', 'a4']);
    const problems = checkPhotoBookPlanConsistency(plan, content);
    expect(problems.some((p) => p.includes('a2') && p.includes('placed 2 times'))).toBe(true);
  });

  it('is happy with an empty book (no cover, no sections)', () => {
    const plan = basePlan({ cover: { title: 'Empty Book' }, sections: [] });
    expect(checkPhotoBookPlanConsistency(plan, contentFor([]))).toEqual([]);
  });
});
