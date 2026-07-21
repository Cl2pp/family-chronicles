import { describe, expect, it } from 'vitest';
import {
  checkPhotoBookPlanConsistency,
  photoBookPlanHasContent,
  validatePhotoBookPlan,
  type PhotoBookPlan,
} from '@/lib/photo-book-plan';
import { lintPhotoBookPlan, type LintPhoto } from '@/lib/photo-book-lint';
import { coercePhotoBookPlan, repairPhotoBookPlan, templateForGroup } from '@/lib/photo-book-repair';

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

/**
 * Regressions from the code review of the design-pass hardening PR. Each of these was a
 * live defect in the first cut: the module written so that ONE small flaw can't destroy a
 * design still let three separate small flaws destroy it (or, worse, quietly persist a book
 * with nothing in it).
 */
describe('repair regressions', () => {
  it('survives the same photo listed twice on one page', () => {
    // Was: the 3-photo path promoted a landscape by filtering on assetId, which removed BOTH
    // copies of the repeated id and left a `three-mixed` page holding two photos — schema
    // invalid, so the whole plan was discarded and the book fell back to the auto layout.
    const photos = [landscape('a'), portrait('b'), landscape('hero')];
    const raw = {
      kind: 'photo',
      style: 'classic',
      cover: { title: 'T', heroAssetId: 'hero' },
      sections: [{ title: 'S', pages: [{ template: 'collage-4', assetIds: ['a', 'a', 'b'] }] }],
    };
    const coerced = coercePhotoBookPlan(raw, { photos, fallbackTitle: 'T', fallbackStyle: 'classic' })!;
    const { plan } = repairPhotoBookPlan(coerced.plan, { photos });
    const validated = validatePhotoBookPlan(plan);
    expect(validated.ok).toBe(true);
    expect(checkPhotoBookPlanConsistency(plan, contentOf(photos))).toEqual([]);
  });

  it('takes the cover hero from a page that has one, not from a photo-less divider', () => {
    // Was: it always borrowed from `pages[0]`, so a section opening with an empty divider
    // produced `heroAssetId: undefined` on a book that still had content — rejected by the
    // consistency check, which in the stale-plan path meant the AI design was overwritten.
    const photos = [portrait('a'), portrait('b'), portrait('c')];
    const plan = planOf([
      {
        title: 'S',
        pages: [
          { template: 'divider', assetIds: [] },
          { template: 'three-column', assetIds: ['a', 'b', 'c'] },
        ],
      },
    ]);
    const { plan: repaired } = repairPhotoBookPlan(plan, { photos });
    expect(repaired.cover.heroAssetId).toBe('a');
    expect(checkPhotoBookPlanConsistency(repaired, contentOf(photos))).toEqual([]);
  });

  it('re-fits a page whose stored template no longer matches its photo count', () => {
    // Was: the "nothing changed" fast path returned any intact page untouched without
    // re-checking arity, so repair could not fix a mismatch it inherited — breaking its own
    // documented guarantee that the result passes the consistency check.
    const photos = [landscape('hero'), portrait('a'), portrait('b')];
    // A stored plan hand-edited into an illegal shape: three-column with only two photos.
    const plan = {
      kind: 'photo',
      style: 'classic',
      cover: { title: 'T', heroAssetId: 'hero' },
      sections: [{ title: 'S', pages: [{ template: 'three-column', assetIds: ['a', 'b'] }] }],
    } as unknown as PhotoBookPlan;
    const { plan: repaired } = repairPhotoBookPlan(plan, { photos });
    expect(validatePhotoBookPlan(repaired).ok).toBe(true);
    expect(repaired.sections[0].pages[0]).toMatchObject({ template: 'two-vertical', assetIds: ['a', 'b'] });
  });

  it('reports "no content" when every photo the model named is unusable', () => {
    // Was: this repaired to zero sections, which is legal AND consistency-clean (no content
    // means no cover hero is required), so the design pass persisted it as an AI design and
    // the user got a front cover, a back cover, and nothing in between.
    const photos = [landscape('a'), portrait('b')];
    const raw = {
      kind: 'photo',
      style: 'classic',
      cover: { title: 'T' },
      sections: [{ title: 'S', pages: [{ template: 'two-vertical', assetIds: ['zz', 'yy'] }] }],
    };
    const coerced = coercePhotoBookPlan(raw, { photos, fallbackTitle: 'T', fallbackStyle: 'classic' })!;
    const { plan } = repairPhotoBookPlan(coerced.plan, { photos });
    expect(checkPhotoBookPlanConsistency(plan, contentOf(photos))).toEqual([]);
    // ...which is exactly why the caller must ask this separate question before storing it.
    expect(photoBookPlanHasContent(plan)).toBe(false);
  });

  it('does not mistake a book of empty section openers for content', () => {
    const photos = [portrait('a')];
    const plan = planOf([{ title: 'S', pages: [{ template: 'divider', assetIds: [] }] }]);
    const { plan: repaired } = repairPhotoBookPlan(plan, { photos });
    expect(photoBookPlanHasContent(repaired)).toBe(false);
    expect(checkPhotoBookPlanConsistency(repaired, contentOf(photos))).toEqual([]);
  });
});
