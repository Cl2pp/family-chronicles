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
    const result = validatePhotoBookPlan(basePlan({ style: 'sepia' as PhotoBookPlan['style'] }));
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

  it('flags a non-empty book with no cover hero', () => {
    const plan = basePlan({ cover: { title: 'No Hero' } }); // sections carried over from basePlan(), non-empty
    const content = contentFor(['a1', 'a2', 'a3', 'a4']);
    const problems = checkPhotoBookPlanConsistency(plan, content);
    expect(problems.some((p) => p.includes('heroAssetId'))).toBe(true);
  });

  it('does not flag a missing hero when every section has zero pages (already flagged separately)', () => {
    // A book whose only section is empty isn't really "has content" in spirit, but that
    // case is already flagged by the "Section has no pages" check — this test just
    // documents that the missing-hero check doesn't pile on a second, redundant problem
    // for the same underlying section.
    const plan = basePlan({ cover: { title: 'x' } });
    plan.sections[0].pages = [];
    const content = contentFor(['a1', 'a2', 'a3', 'a4']);
    const problems = checkPhotoBookPlanConsistency(plan, content);
    expect(problems.some((p) => p.includes('heroAssetId'))).toBe(false);
    expect(problems.some((p) => p.includes('no pages'))).toBe(true);
  });
});

describe('text flow items (unified-book plan)', () => {
  const base = {
    kind: 'photo' as const,
    style: 'classic' as const,
    cover: { heroAssetId: 'hero', title: 'Buch' },
  };
  const content = (stories?: Array<{ storyId: string; paragraphCount: number }>) => ({
    availableAssetIds: ['hero', 'a', 'b'],
    allAssetIds: ['hero', 'a', 'b'],
    ...(stories ? { stories } : {}),
  });

  it('validates a plan with storyId sections and text items', () => {
    const result = validatePhotoBookPlan({
      ...base,
      sections: [
        {
          title: 'Oma erzählt',
          storyId: 's1',
          pages: [
            { template: 'text', from: 0, to: 2 },
            { template: 'full-framed', assetIds: ['a'] },
            { template: 'text', from: 3, to: 5 },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('enforces gap-free in-order coverage when stories are provided', () => {
    const plan = {
      ...base,
      sections: [
        {
          title: 'S',
          storyId: 's1',
          pages: [
            { template: 'text' as const, from: 0, to: 2 },
            { template: 'text' as const, from: 4, to: 5 }, // gap at 3
          ],
        },
      ],
    };
    const validated = validatePhotoBookPlan(plan);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const problems = checkPhotoBookPlanConsistency(validated.plan, content([{ storyId: 's1', paragraphCount: 6 }]));
    expect(problems.some((p) => p.includes('gap/overlap'))).toBe(true);
  });

  it('flags a missing section per story, a split story, and text without a storyId', () => {
    const plan = validatePhotoBookPlan({
      ...base,
      sections: [
        { title: 'A', storyId: 's1', pages: [{ template: 'text', from: 0, to: 1 }] },
        { title: 'B', storyId: 's1', pages: [{ template: 'text', from: 0, to: 1 }] },
        { title: 'C', pages: [{ template: 'text', from: 0, to: 0 }] },
      ],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const problems = checkPhotoBookPlanConsistency(
      plan.plan,
      content([
        { storyId: 's1', paragraphCount: 2 },
        { storyId: 's2', paragraphCount: 3 },
      ]),
    );
    expect(problems.some((p) => p.includes('missing a section for story s2'))).toBe(true);
    expect(problems.some((p) => p.includes('split across 2 sections'))).toBe(true);
    expect(problems.some((p) => p.includes('text block but no storyId'))).toBe(true);
  });

  it('skips all text rules when the caller provides no stories (pre-unification callers)', () => {
    const plan = validatePhotoBookPlan({
      ...base,
      sections: [{ title: 'S', storyId: 's1', pages: [{ template: 'text', from: 3, to: 1 }] }],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(checkPhotoBookPlanConsistency(plan.plan, content())).toEqual([]);
  });

  it('a text-only book needs no cover hero, but a book with photos still does', () => {
    const textOnly = validatePhotoBookPlan({
      kind: 'photo',
      style: 'classic',
      cover: { title: 'Buch' },
      sections: [{ title: 'S', storyId: 's1', pages: [{ template: 'text', from: 0, to: 1 }] }],
    });
    expect(textOnly.ok).toBe(true);
    if (!textOnly.ok) return;
    expect(
      checkPhotoBookPlanConsistency(textOnly.plan, {
        availableAssetIds: [],
        allAssetIds: [],
        stories: [{ storyId: 's1', paragraphCount: 2 }],
      }),
    ).toEqual([]);
  });
});
