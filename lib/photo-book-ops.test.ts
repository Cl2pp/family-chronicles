import { describe, expect, it } from 'vitest';
import { checkPhotoBookPlanConsistency, type PhotoBookPlan, type PhotoPlanContent } from './photo-book-plan';
import { applyPhotoLayoutOp, removePhotoFromPlan, type PurePhotoLayoutOp } from './photo-book-ops';

// The cover hero ('a1') deliberately does NOT also appear on any section page — a real
// plan never reuses an id between the cover and a page (checkPhotoBookPlanConsistency
// forbids it), and 'c1' is a spare AVAILABLE-but-unplaced photo (a photo can be available
// without being referenced anywhere in the plan — see photo-book-content.ts's
// `unplacedPhotos`), used by tests that need somewhere fresh to place a photo.
function basePlan(overrides: Partial<PhotoBookPlan> = {}): PhotoBookPlan {
  return {
    kind: 'photo',
    style: 'classic',
    cover: { heroAssetId: 'a1', title: 'Our Family' },
    sections: [
      {
        title: 'Juni 2025',
        pages: [
          { template: 'full-bleed', assetIds: ['a7'] },
          { template: 'two-horizontal', assetIds: ['a2', 'a3'] },
          { template: 'three-mixed', assetIds: ['a4', 'a5', 'a6'] },
        ],
      },
      {
        title: 'Juli 2025',
        pages: [{ template: 'collage-5', assetIds: ['b1', 'b2', 'b3', 'b4', 'b5'] }],
      },
    ],
    ...overrides,
  };
}

const ALL_IDS = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'b1', 'b2', 'b3', 'b4', 'b5', 'c1'];

function contentFor(plan: PhotoBookPlan, excluded: string[] = []): PhotoPlanContent {
  const excludedSet = new Set(excluded);
  return {
    availableAssetIds: ALL_IDS.filter((id) => !excludedSet.has(id)),
    allAssetIds: ALL_IDS,
  };
}

function apply(plan: PhotoBookPlan, op: PurePhotoLayoutOp, available: string[] = ALL_IDS) {
  return applyPhotoLayoutOp(plan, op, { availableAssetIds: new Set(available) });
}

describe('applyPhotoLayoutOp', () => {
  it('set_style changes the style with no other effect', () => {
    const result = apply(basePlan(), { op: 'set_style', style: 'modern' });
    expect('plan' in result && result.plan.style).toBe('modern');
    expect('plan' in result && result.plan.sections).toEqual(basePlan().sections);
  });

  it('set_cover rejects an asset that is not available', () => {
    const result = apply(basePlan(), { op: 'set_cover', heroAssetId: 'nope' });
    expect('error' in result).toBe(true);
  });

  it('set_cover rejects a currently-excluded asset', () => {
    const result = apply(basePlan(), { op: 'set_cover', heroAssetId: 'a2' }, ALL_IDS.filter((id) => id !== 'a2'));
    expect('error' in result).toBe(true);
  });

  it('set_cover accepts an available asset and returns coverAssetId to pin', () => {
    const result = apply(basePlan(), { op: 'set_cover', heroAssetId: 'b1' });
    expect('plan' in result).toBe(true);
    if ('plan' in result) {
      expect(result.plan.cover.heroAssetId).toBe('b1');
      expect(result.coverAssetId).toBe('b1');
    }
  });

  it('set_cover_title updates title and subtitle independently', () => {
    const r1 = apply(basePlan(), { op: 'set_cover_title', title: 'New Title' });
    expect('plan' in r1 && r1.plan.cover.title).toBe('New Title');

    const r2 = apply(basePlan(), { op: 'set_cover_title', subtitle: 'A summer to remember' });
    expect('plan' in r2 && r2.plan.cover.subtitle).toBe('A summer to remember');
    expect('plan' in r2 && r2.plan.cover.title).toBe('Our Family'); // untouched
  });

  it('set_cover_title rejects an empty title', () => {
    const result = apply(basePlan(), { op: 'set_cover_title', title: '   ' });
    expect('error' in result).toBe(true);
  });

  it('set_section_title renames a section by index', () => {
    const result = apply(basePlan(), { op: 'set_section_title', sectionIndex: 0, title: 'Sommer in Italien' });
    expect('plan' in result && result.plan.sections[0].title).toBe('Sommer in Italien');
  });

  it('set_section_title rejects an out-of-range index', () => {
    const result = apply(basePlan(), { op: 'set_section_title', sectionIndex: 9, title: 'x' });
    expect('error' in result).toBe(true);
  });

  it('set_page_template rejects an arity mismatch', () => {
    // The two-horizontal page has 2 photos; three-column needs 3.
    const result = apply(basePlan(), { op: 'set_page_template', sectionIndex: 0, pageIndex: 1, template: 'three-column' });
    expect('error' in result).toBe(true);
  });

  it('set_page_template accepts a same-arity template swap', () => {
    const result = apply(basePlan(), { op: 'set_page_template', sectionIndex: 0, pageIndex: 1, template: 'two-vertical' });
    expect('plan' in result).toBe(true);
    if ('plan' in result) {
      const page = result.plan.sections[0].pages[1];
      expect(page.template).toBe('two-vertical');
      expect(page.assetIds).toEqual(['a2', 'a3']);
    }
  });

  it('move_photo removes the photo from its old page and gives it a new page at the destination', () => {
    const result = apply(basePlan(), { op: 'move_photo', assetId: 'a2', toSectionIndex: 1 });
    expect('plan' in result).toBe(true);
    if (!('plan' in result)) return;
    // Old page (two-horizontal, 2 photos) shrinks to a valid single-photo page.
    const oldPage = result.plan.sections[0].pages[1];
    expect(oldPage.assetIds).toEqual(['a3']);
    expect(oldPage.template).toBe('full-framed');
    // New page appended at the destination section, holding just the moved photo.
    const destPages = result.plan.sections[1].pages;
    const newPage = destPages[destPages.length - 1];
    expect(newPage.template).toBe('full-framed');
    expect(newPage.assetIds).toEqual(['a2']);
  });

  it('move_photo rejects an unavailable (excluded) photo', () => {
    const result = apply(basePlan(), { op: 'move_photo', assetId: 'a2', toSectionIndex: 1 }, ALL_IDS.filter((id) => id !== 'a2'));
    expect('error' in result).toBe(true);
  });

  it('move_photo rejects an out-of-range destination section', () => {
    const result = apply(basePlan(), { op: 'move_photo', assetId: 'a2', toSectionIndex: 9 });
    expect('error' in result).toBe(true);
  });

  it('swap_photos exchanges two photos wherever they sit, including the cover hero', () => {
    const result = apply(basePlan(), { op: 'swap_photos', assetIdA: 'a1', assetIdB: 'b3' });
    expect('plan' in result).toBe(true);
    if (!('plan' in result)) return;
    expect(result.plan.cover.heroAssetId).toBe('b3'); // a1 was the hero
    // a1 wasn't on any page, so swapping it with b3 only touches the collage page b3 sat on.
    const collage = result.plan.sections[1].pages[0].assetIds;
    expect(collage).toEqual(['b1', 'b2', 'a1', 'b4', 'b5']);
  });

  it('swap_photos rejects swapping a photo with itself', () => {
    const result = apply(basePlan(), { op: 'swap_photos', assetIdA: 'a1', assetIdB: 'a1' });
    expect('error' in result).toBe(true);
  });

  it('swap_photos rejects an unavailable photo on either side', () => {
    const result = apply(basePlan(), { op: 'swap_photos', assetIdA: 'a1', assetIdB: 'a2' }, ALL_IDS.filter((id) => id !== 'a2'));
    expect('error' in result).toBe(true);
  });

  it('move_section reorders sections', () => {
    const result = apply(basePlan(), { op: 'move_section', fromIndex: 1, toIndex: 0 });
    expect('plan' in result && result.plan.sections.map((s) => s.title)).toEqual(['Juli 2025', 'Juni 2025']);
  });

  it('move_section rejects an out-of-range index', () => {
    const result = apply(basePlan(), { op: 'move_section', fromIndex: 0, toIndex: 5 });
    expect('error' in result).toBe(true);
  });

  it('merge_sections concatenates pages into the target and removes the source section', () => {
    const result = apply(basePlan(), { op: 'merge_sections', sectionIndex: 0, intoIndex: 1 });
    expect('plan' in result).toBe(true);
    if (!('plan' in result)) return;
    expect(result.plan.sections).toHaveLength(1);
    expect(result.plan.sections[0].title).toBe('Juli 2025');
    expect(result.plan.sections[0].pages).toHaveLength(4); // 3 from Juni + 1 from Juli
  });

  it('merge_sections rejects merging a section into itself', () => {
    const result = apply(basePlan(), { op: 'merge_sections', sectionIndex: 0, intoIndex: 0 });
    expect('error' in result).toBe(true);
  });

  it('set_caption sets a caption for one photo on a page, leaving others null', () => {
    const result = apply(basePlan(), { op: 'set_caption', sectionIndex: 0, pageIndex: 1, assetId: 'a3', caption: 'At the lake' });
    expect('plan' in result).toBe(true);
    if (!('plan' in result)) return;
    expect(result.plan.sections[0].pages[1].captions).toEqual([null, 'At the lake']);
  });

  it('set_caption rejects a photo that is not on the given page', () => {
    const result = apply(basePlan(), { op: 'set_caption', sectionIndex: 0, pageIndex: 1, assetId: 'a4', caption: 'x' });
    expect('error' in result).toBe(true);
  });
});

describe('removePhotoFromPlan', () => {
  it('clears the cover hero when it is the removed photo', () => {
    const plan = removePhotoFromPlan(basePlan(), 'a1');
    expect(plan.cover.heroAssetId).toBeUndefined();
  });

  it('shrinks a full page down to a valid smaller template instead of vanishing', () => {
    const plan = removePhotoFromPlan(basePlan(), 'a2');
    const page = plan.sections[0].pages[1];
    expect(page.assetIds).toEqual(['a3']);
    expect(page.template).toBe('full-framed');
  });

  it('turns a single-photo page into an empty divider rather than deleting it', () => {
    const plan = removePhotoFromPlan(basePlan(), 'a7');
    const page = plan.sections[0].pages[0];
    expect(page.assetIds).toEqual([]);
    expect(page.template).toBe('divider');
  });

  it('never changes the number of pages or sections', () => {
    const before = basePlan();
    const after = removePhotoFromPlan(before, 'b3');
    expect(after.sections.length).toBe(before.sections.length);
    expect(after.sections.map((s) => s.pages.length)).toEqual(before.sections.map((s) => s.pages.length));
  });

  it('is a no-op when the photo is not referenced anywhere', () => {
    const before = basePlan();
    const after = removePhotoFromPlan(before, 'does-not-exist');
    expect(after).toEqual(before);
  });
});

describe('exclude/set_cover interplay with checkPhotoBookPlanConsistency (the reject-if-inconsistent contract)', () => {
  it('flags a plan left without a cover hero after its photo was excluded', () => {
    // Mirrors what lib/books.ts's updatePhotoBookLayout must catch: excluding the
    // current cover hero without picking a new one leaves the plan inconsistent, and
    // the whole batch must be rejected — nothing persisted.
    const plan = removePhotoFromPlan(basePlan(), 'a1');
    const problems = checkPhotoBookPlanConsistency(plan, contentFor(plan, ['a1']));
    expect(problems.some((p) => p.includes('no heroAssetId'))).toBe(true);
  });

  it('is consistent again once a new cover is set after the exclude', () => {
    const excluded = removePhotoFromPlan(basePlan(), 'a1');
    const result = apply(excluded, { op: 'set_cover', heroAssetId: 'c1' }, ALL_IDS.filter((id) => id !== 'a1'));
    expect('plan' in result).toBe(true);
    if (!('plan' in result)) return;
    const problems = checkPhotoBookPlanConsistency(result.plan, contentFor(result.plan, ['a1']));
    expect(problems).toEqual([]);
  });

  it('a same-arity set_page_template keeps the plan consistent', () => {
    const result = apply(basePlan(), { op: 'set_page_template', sectionIndex: 0, pageIndex: 1, template: 'two-vertical' });
    expect('plan' in result).toBe(true);
    if (!('plan' in result)) return;
    const problems = checkPhotoBookPlanConsistency(result.plan, contentFor(result.plan));
    expect(problems).toEqual([]);
  });

  it('move_photo keeps the plan consistent end to end', () => {
    const result = apply(basePlan(), { op: 'move_photo', assetId: 'b1', toSectionIndex: 0, toPageIndex: 0 });
    expect('plan' in result).toBe(true);
    if (!('plan' in result)) return;
    const problems = checkPhotoBookPlanConsistency(result.plan, contentFor(result.plan));
    expect(problems).toEqual([]);
  });
});
