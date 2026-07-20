import { describe, expect, it } from 'vitest';
import {
  buildPhotoBookAutoLayout,
  computeCandidateSections,
  type AutoLayoutPhoto,
  type PhotoBookAutoLayoutInput,
} from './photo-book-autolayout';
import { checkPhotoBookPlanConsistency } from './photo-book-plan';
import type { PhotoAnalysis } from './photo-analysis';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function photo(overrides: Partial<AutoLayoutPhoto> & { assetId: string }): AutoLayoutPhoto {
  return {
    width: 1200,
    height: 800,
    position: 0,
    takenAt: null,
    gpsLat: null,
    gpsLng: null,
    phash: null,
    blurScore: null,
    ...overrides,
  };
}

function analysis(overrides: Partial<PhotoAnalysis> = {}): PhotoAnalysis {
  return {
    aestheticScore: 5,
    sharpness: 'sharp',
    eyesClosed: false,
    peopleCount: 1,
    sceneTags: [],
    shortDescription: '',
    coverCandidate: false,
    ...overrides,
  };
}

const t0 = new Date('2025-06-01T10:00:00Z').getTime();

function baseInput(photos: AutoLayoutPhoto[]) {
  return { title: 'Our Family', coverAssetId: null, photos };
}

describe('buildPhotoBookAutoLayout — determinism', () => {
  it('produces the exact same plan for the exact same input', () => {
    const photos = [
      photo({ assetId: 'a', position: 0, takenAt: new Date(t0), width: 1600, height: 1200 }),
      photo({ assetId: 'b', position: 1, takenAt: new Date(t0 + HOUR), width: 1200, height: 1600 }),
      photo({ assetId: 'c', position: 2, takenAt: new Date(t0 + 2 * HOUR), width: 1200, height: 1600 }),
    ];
    const r1 = buildPhotoBookAutoLayout(baseInput(photos));
    const r2 = buildPhotoBookAutoLayout(baseInput(photos.slice()));
    expect(r1).toEqual(r2);
  });

  it('returns kind photo and defaults style to classic', () => {
    const result = buildPhotoBookAutoLayout(baseInput([]));
    expect(result.plan.kind).toBe('photo');
    expect(result.plan.style).toBe('classic');
  });

  it('an empty photo set produces an empty, hero-less plan', () => {
    const result = buildPhotoBookAutoLayout(baseInput([]));
    expect(result.plan.sections).toEqual([]);
    expect(result.plan.cover.heroAssetId).toBeUndefined();
    expect(result.culled).toEqual([]);
  });
});

describe('buildPhotoBookAutoLayout — sectioning', () => {
  it('keeps same-day, close-together photos in one section', () => {
    const photos = [
      photo({ assetId: 'a', position: 0, takenAt: new Date(t0) }),
      photo({ assetId: 'b', position: 1, takenAt: new Date(t0 + HOUR) }),
      photo({ assetId: 'c', position: 2, takenAt: new Date(t0 + 2 * HOUR) }),
    ];
    const { plan } = buildPhotoBookAutoLayout(baseInput(photos));
    expect(plan.sections).toHaveLength(1);
  });

  it('splits into two sections across a large time gap', () => {
    // 5 photos/cluster (10 total) — comfortably under the section-count cap
    // (`SECTION_CAP_DIVISOR`, see the "caps section count" test below) so this test
    // isolates boundary detection, not capping.
    const cluster1 = [0, 1, 2, 3, 4].map((h) =>
      photo({ assetId: `a${h}`, position: h, takenAt: new Date(t0 + h * HOUR) }),
    );
    const cluster2 = [0, 1, 2, 3, 4].map((h) =>
      photo({ assetId: `b${h}`, position: 5 + h, takenAt: new Date(t0 + 3 * DAY + h * HOUR) }),
    );
    const { plan } = buildPhotoBookAutoLayout(baseInput([...cluster1, ...cluster2]));
    expect(plan.sections).toHaveLength(2);
  });

  it('caps section count for a large book with many well-separated tiny-but-valid clusters', () => {
    // 10 clusters of exactly MIN_SECTION_SIZE (3) photos, each a full day apart — none
    // are tiny enough for the merge-tiny pass to touch, so without a cap this would be
    // 10 sections for only 30 photos. The cap (ceil(30 / SECTION_CAP_DIVISOR) = 4) must
    // still bring it down.
    const photos = Array.from({ length: 10 }, (_, cluster) =>
      [0, 1, 2].map((h) =>
        photo({
          assetId: `c${cluster}-${h}`,
          position: cluster * 3 + h,
          takenAt: new Date(t0 + cluster * DAY + h * HOUR),
        }),
      ),
    ).flat();
    const { plan } = buildPhotoBookAutoLayout(baseInput(photos));
    expect(plan.sections.length).toBeLessThanOrEqual(4);
    expect(plan.sections.length).toBeGreaterThan(1);
    // 30 photos in, 1 becomes the cover hero (excluded from interior pages — see "cover
    // selection — exclusivity" below), so 29 remain placed inside sections.
    const placed = plan.sections.flatMap((s) => s.pages.flatMap((p) => p.assetIds));
    expect(placed).toHaveLength(29);
    expect(plan.cover.heroAssetId).toBeDefined();
    expect(placed).not.toContain(plan.cover.heroAssetId);
  });

  it('keeps a multi-day weekend trip as one section (gaps only overnight)', () => {
    // Day 1: photos every couple hours from 09:00 to 21:00. Overnight gap ~12h to day 2
    // 09:00, which exceeds the 8h threshold — so a naive rule would split here. The trip
    // stays one section only because each individual day is small (<3 photos), which the
    // tiny-section merge folds back into its neighbor.
    const day1 = [9, 13, 17, 21].map((h, i) =>
      photo({ assetId: `d1-${i}`, position: i, takenAt: new Date(t0 + h * HOUR) }),
    );
    const day2 = [9, 13, 17, 21].map((h, i) =>
      photo({ assetId: `d2-${i}`, position: 4 + i, takenAt: new Date(t0 + DAY + h * HOUR) }),
    );
    const { plan } = buildPhotoBookAutoLayout(baseInput([...day1, ...day2]));
    // Both days individually clear MIN_SECTION_SIZE (4 each), so this legitimately stays
    // two sections — the point of this test is that it does NOT explode into 8 (one per
    // photo) or leave any section under the minimum size.
    for (const section of plan.sections) {
      const photoCount = section.pages.reduce((n, p) => n + p.assetIds.length, 0);
      expect(photoCount).toBeGreaterThanOrEqual(3);
    }
  });

  it('merges a tiny trailing section into its neighbor', () => {
    const photos = [
      photo({ assetId: 'a', position: 0, takenAt: new Date(t0) }),
      photo({ assetId: 'b', position: 1, takenAt: new Date(t0 + HOUR) }),
      photo({ assetId: 'c', position: 2, takenAt: new Date(t0 + 2 * HOUR) }),
      photo({ assetId: 'd', position: 3, takenAt: new Date(t0 + 3 * HOUR) }),
      // Lone photo, far enough away to start a new section on its own — but only 1
      // photo, under MIN_SECTION_SIZE, so it must fold back into the section above.
      photo({ assetId: 'e', position: 4, takenAt: new Date(t0 + 2 * DAY) }),
    ];
    const { plan } = buildPhotoBookAutoLayout(baseInput(photos));
    expect(plan.sections).toHaveLength(1);
    // One of the 5 becomes the cover hero and is excluded from interior placement (see
    // "cover selection — exclusivity" below) — so `placed` alone is the other 4; adding
    // the hero back in accounts for all 5.
    const placed = plan.sections.flatMap((s) => s.pages.flatMap((p) => p.assetIds));
    expect(placed).toHaveLength(4);
    expect([...placed, plan.cover.heroAssetId].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('starts a new section on a large GPS jump even without a big time gap', () => {
    const photos = [
      photo({ assetId: 'a', position: 0, takenAt: new Date(t0), gpsLat: 52.52, gpsLng: 13.405 }), // Berlin
      photo({ assetId: 'b', position: 1, takenAt: new Date(t0 + HOUR), gpsLat: 52.53, gpsLng: 13.41 }),
      photo({ assetId: 'c', position: 2, takenAt: new Date(t0 + 2 * HOUR), gpsLat: 52.5, gpsLng: 13.39 }),
      photo({ assetId: 'g', position: 3, takenAt: new Date(t0 + 2.5 * HOUR), gpsLat: 52.51, gpsLng: 13.4 }),
      photo({ assetId: 'h', position: 4, takenAt: new Date(t0 + 2.8 * HOUR), gpsLat: 52.49, gpsLng: 13.42 }),
      // Munich, ~500km away, only 3 hours later — a flight/fast trip, not a drift.
      photo({ assetId: 'd', position: 5, takenAt: new Date(t0 + 3 * HOUR), gpsLat: 48.14, gpsLng: 11.58 }),
      photo({ assetId: 'e', position: 6, takenAt: new Date(t0 + 4 * HOUR), gpsLat: 48.15, gpsLng: 11.57 }),
      photo({ assetId: 'f', position: 7, takenAt: new Date(t0 + 5 * HOUR), gpsLat: 48.13, gpsLng: 11.6 }),
      photo({ assetId: 'i', position: 8, takenAt: new Date(t0 + 5.5 * HOUR), gpsLat: 48.16, gpsLng: 11.59 }),
      photo({ assetId: 'j', position: 9, takenAt: new Date(t0 + 5.8 * HOUR), gpsLat: 48.12, gpsLng: 11.56 }),
    ];
    const { plan } = buildPhotoBookAutoLayout(baseInput(photos));
    expect(plan.sections).toHaveLength(2);
  });

  it('groups undated photos into one trailing section titled with the fallback', () => {
    const photos = [
      photo({ assetId: 'a', position: 0 }),
      photo({ assetId: 'b', position: 1 }),
      photo({ assetId: 'c', position: 2 }),
    ];
    const { plan } = buildPhotoBookAutoLayout(baseInput(photos));
    expect(plan.sections).toHaveLength(1);
    expect(plan.sections[0].title).toBe('Weitere Fotos');
  });

  it('gives a dated section a "Month Year" title', () => {
    const photos = [
      photo({ assetId: 'a', position: 0, takenAt: new Date(t0) }),
      photo({ assetId: 'b', position: 1, takenAt: new Date(t0 + HOUR) }),
      photo({ assetId: 'c', position: 2, takenAt: new Date(t0 + 2 * HOUR) }),
    ];
    const { plan } = buildPhotoBookAutoLayout(baseInput(photos));
    expect(plan.sections[0].title).toBe('Juni 2025');
  });
});

describe('buildPhotoBookAutoLayout — culling', () => {
  it('culls a near-duplicate photo, keeping the sharper one', () => {
    const photos = [
      photo({ assetId: 'sharp', position: 0, takenAt: new Date(t0), phash: 'aaaaaaaaaaaaaaaa', blurScore: 200 }),
      photo({ assetId: 'blurry-dup', position: 1, takenAt: new Date(t0 + 60_000), phash: 'aaaaaaaaaaaaaaaa', blurScore: 50 }),
      photo({ assetId: 'other', position: 2, takenAt: new Date(t0 + 2 * 60_000), phash: 'ffffffffffffffff', blurScore: 180 }),
    ];
    // Pin the cover away from any of these ids — this test is about duplicate culling,
    // not cover-hero exclusivity (covered separately below), so both survivors should
    // land in the interior pages.
    const { plan, culled } = buildPhotoBookAutoLayout({ ...baseInput(photos), coverAssetId: 'unrelated-cover' });
    expect(culled).toEqual([{ assetId: 'blurry-dup', reason: 'duplicate' }]);
    const placed = plan.sections.flatMap((s) => s.pages.flatMap((p) => p.assetIds));
    expect(placed).not.toContain('blurry-dup');
    expect(placed).toContain('sharp');
    expect(placed).toContain('other');
  });

  it('culls a clearly-blurry photo when a sharp sibling exists', () => {
    const photos = [
      photo({ assetId: 'sharp1', position: 0, takenAt: new Date(t0), blurScore: 100 }),
      photo({ assetId: 'sharp2', position: 1, takenAt: new Date(t0 + 60_000), blurScore: 90 }),
      photo({ assetId: 'blurry', position: 2, takenAt: new Date(t0 + 120_000), blurScore: 5 }),
    ];
    const { culled } = buildPhotoBookAutoLayout(baseInput(photos));
    expect(culled).toEqual([{ assetId: 'blurry', reason: 'blurry' }]);
  });

  it('never culls a section down to zero photos even if every score is low', () => {
    const photos = [
      photo({ assetId: 'a', position: 0, takenAt: new Date(t0), blurScore: 5 }),
      photo({ assetId: 'b', position: 1, takenAt: new Date(t0 + 60_000), blurScore: 4.9 }),
    ];
    const { plan } = buildPhotoBookAutoLayout(baseInput(photos));
    const placed = plan.sections.flatMap((s) => s.pages.flatMap((p) => p.assetIds));
    expect(placed.length).toBeGreaterThan(0);
  });

  it('never treats photos without a phash as duplicates of each other', () => {
    const photos = [
      photo({ assetId: 'a', position: 0, takenAt: new Date(t0) }),
      photo({ assetId: 'b', position: 1, takenAt: new Date(t0 + 60_000) }),
    ];
    const { culled } = buildPhotoBookAutoLayout(baseInput(photos));
    expect(culled).toEqual([]);
  });
});

describe('buildPhotoBookAutoLayout — pacing', () => {
  // Every test in this block pins the cover to an id outside the section under test —
  // otherwise the section's own best photo would double as the (excluded) cover hero,
  // which is exactly what "cover selection — exclusivity" below tests; pinning it away
  // keeps these tests focused on `paceSection`'s grouping logic alone.

  it('gives a lone section photo its own full page, not a multi-slot template', () => {
    const photos = [photo({ assetId: 'a', position: 0, takenAt: new Date(t0), width: 1600, height: 1200 })];
    const { plan } = buildPhotoBookAutoLayout({ ...baseInput(photos), coverAssetId: 'unrelated-cover' });
    expect(plan.sections[0].pages).toHaveLength(1);
    expect(['full-bleed', 'full-framed']).toContain(plan.sections[0].pages[0].template);
    expect(plan.sections[0].pages[0].assetIds).toEqual(['a']);
  });

  it('pairs two landscape leftovers into a two-horizontal page', () => {
    const photos = [
      photo({ assetId: 'opener', position: 0, takenAt: new Date(t0), width: 2000, height: 1000 }),
      photo({ assetId: 'a', position: 1, takenAt: new Date(t0 + HOUR), width: 1600, height: 1000 }),
      photo({ assetId: 'b', position: 2, takenAt: new Date(t0 + 2 * HOUR), width: 1600, height: 1000 }),
    ];
    const { plan } = buildPhotoBookAutoLayout({ ...baseInput(photos), coverAssetId: 'unrelated-cover' });
    const pairPage = plan.sections[0].pages.find((p) => p.assetIds.length === 2);
    expect(pairPage?.template).toBe('two-horizontal');
  });

  it('pairs two portrait leftovers into a two-vertical page', () => {
    const photos = [
      photo({ assetId: 'opener', position: 0, takenAt: new Date(t0), width: 2000, height: 1000 }),
      photo({ assetId: 'a', position: 1, takenAt: new Date(t0 + HOUR), width: 1000, height: 1600 }),
      photo({ assetId: 'b', position: 2, takenAt: new Date(t0 + 2 * HOUR), width: 1000, height: 1600 }),
    ];
    const { plan } = buildPhotoBookAutoLayout({ ...baseInput(photos), coverAssetId: 'unrelated-cover' });
    const pairPage = plan.sections[0].pages.find((p) => p.assetIds.length === 2);
    expect(pairPage?.template).toBe('two-vertical');
  });

  it('every emitted page has the exact slot count its template requires', () => {
    const photos = Array.from({ length: 23 }, (_, i) =>
      photo({
        assetId: `p${i}`,
        position: i,
        takenAt: new Date(t0 + i * HOUR),
        width: i % 2 === 0 ? 1600 : 1000,
        height: i % 2 === 0 ? 1000 : 1600,
      }),
    );
    const { plan } = buildPhotoBookAutoLayout(baseInput(photos));
    const slots: Record<string, number> = {
      'full-bleed': 1,
      'full-framed': 1,
      'two-horizontal': 2,
      'two-vertical': 2,
      'three-column': 3,
      'three-mixed': 3,
      'collage-4': 4,
      'collage-5': 5,
      divider: 1, // upper bound; the layouter never emits 0-photo dividers
    };
    for (const section of plan.sections) {
      for (const page of section.pages) {
        expect(page.assetIds.length).toBeLessThanOrEqual(slots[page.template]);
        expect(page.assetIds.length).toBeGreaterThan(0);
      }
    }
  });

  it('never emits a divider page (auto-layouter opens sections with a hero photo instead)', () => {
    const photos = Array.from({ length: 12 }, (_, i) =>
      photo({ assetId: `p${i}`, position: i, takenAt: new Date(t0 + i * HOUR) }),
    );
    const { plan } = buildPhotoBookAutoLayout(baseInput(photos));
    const templates = plan.sections.flatMap((s) => s.pages.map((p) => p.template));
    expect(templates).not.toContain('divider');
  });
});

describe('buildPhotoBookAutoLayout — cover selection', () => {
  it('picks the highest-resolution non-blurry photo as the hero', () => {
    const photos = [
      photo({ assetId: 'small-sharp', position: 0, takenAt: new Date(t0), width: 800, height: 600, blurScore: 100 }),
      photo({ assetId: 'big-blurry', position: 1, takenAt: new Date(t0 + HOUR), width: 4000, height: 3000, blurScore: 3 }),
      photo({ assetId: 'big-sharp', position: 2, takenAt: new Date(t0 + 2 * HOUR), width: 3000, height: 2000, blurScore: 95 }),
    ];
    const { plan } = buildPhotoBookAutoLayout(baseInput(photos));
    expect(plan.cover.heroAssetId).toBe('big-sharp');
  });

  it('an explicit cover pin always wins', () => {
    const photos = [
      photo({ assetId: 'a', position: 0, takenAt: new Date(t0), width: 4000, height: 3000 }),
      photo({ assetId: 'b', position: 1, takenAt: new Date(t0 + HOUR), width: 400, height: 300 }),
    ];
    const { plan } = buildPhotoBookAutoLayout({ title: 'x', coverAssetId: 'b', photos });
    expect(plan.cover.heroAssetId).toBe('b');
  });

  it('an existing hero from a prior plan wins over recomputing, when there is no pin', () => {
    const photos = [
      photo({ assetId: 'a', position: 0, takenAt: new Date(t0), width: 4000, height: 3000 }),
      photo({ assetId: 'b', position: 1, takenAt: new Date(t0 + HOUR), width: 400, height: 300 }),
    ];
    const { plan } = buildPhotoBookAutoLayout({
      title: 'x',
      coverAssetId: null,
      existingHeroAssetId: 'b',
      photos,
    });
    expect(plan.cover.heroAssetId).toBe('b');
  });

  it('the cover title defaults to the book title and carries an existing style forward', () => {
    const photos = [photo({ assetId: 'a', position: 0, takenAt: new Date(t0) })];
    const { plan } = buildPhotoBookAutoLayout({
      title: 'Familie Müller',
      coverAssetId: null,
      existingStyle: 'gallery',
      photos,
    });
    expect(plan.cover.title).toBe('Familie Müller');
    expect(plan.style).toBe('gallery');
  });
});

describe('buildPhotoBookAutoLayout — cover selection exclusivity (regression)', () => {
  // Regression coverage for the blocker this fixes: the auto-layouter used to pick the
  // cover hero via `pickBestPhoto` *and* let `paceSection` place that same photo again as
  // its section's opener, producing a duplicate `assetId` that `checkPhotoBookPlanConsistency`
  // rejects — which made `buildAndPersistPhotoAutoPlan` fall back to a blank book for
  // essentially every real photo book. See `lib/photo-book-autolayout.ts`'s hero-exclusion
  // comment in `buildPhotoBookAutoLayout`.

  it('never places the auto-picked hero anywhere inside a section, single-section book', () => {
    const photos = [
      photo({ assetId: 'a', position: 0, takenAt: new Date(t0), width: 4000, height: 3000 }),
      photo({ assetId: 'b', position: 1, takenAt: new Date(t0 + HOUR), width: 1200, height: 900 }),
      photo({ assetId: 'c', position: 2, takenAt: new Date(t0 + 2 * HOUR), width: 1200, height: 900 }),
    ];
    const { plan } = buildPhotoBookAutoLayout(baseInput(photos));
    expect(plan.cover.heroAssetId).toBe('a'); // highest resolution, no pin/carry-over
    const interior = plan.sections.flatMap((s) => s.pages.flatMap((p) => p.assetIds));
    expect(interior).not.toContain('a');
  });

  it('never places a pinned cover hero anywhere inside a section, even if it would also have been the local opener', () => {
    const photos = [
      photo({ assetId: 'a', position: 0, takenAt: new Date(t0), width: 4000, height: 3000 }),
      photo({ assetId: 'b', position: 1, takenAt: new Date(t0 + HOUR), width: 1200, height: 900 }),
    ];
    const { plan } = buildPhotoBookAutoLayout({ ...baseInput(photos), coverAssetId: 'a' });
    expect(plan.cover.heroAssetId).toBe('a');
    const interior = plan.sections.flatMap((s) => s.pages.flatMap((p) => p.assetIds));
    expect(interior).not.toContain('a');
  });

  it('drops a section entirely, rather than emitting an empty one, when its only photo is the hero', () => {
    const photos = [photo({ assetId: 'only', position: 0, takenAt: new Date(t0), width: 2000, height: 1500 })];
    const { plan } = buildPhotoBookAutoLayout(baseInput(photos));
    expect(plan.cover.heroAssetId).toBe('only');
    expect(plan.sections).toEqual([]);
  });
});

describe('buildPhotoBookAutoLayout — plan consistency (regression)', () => {
  // The regression class that let the exclusivity bug through PR2 review: every plan the
  // producer emits, for a realistic spread of book sizes, must pass
  // `checkPhotoBookPlanConsistency` (`lib/photo-book-plan.ts`) with zero problems — no
  // asset placed twice, nothing referencing a photo outside the book, no empty sections,
  // every page's arity matching its template.

  function checkConsistency(input: PhotoBookAutoLayoutInput) {
    const { plan, culled } = buildPhotoBookAutoLayout(input);
    const culledIds = new Set(culled.map((c) => c.assetId));
    const allAssetIds = input.photos.map((p) => p.assetId);
    const availableAssetIds = allAssetIds.filter((id) => !culledIds.has(id));
    const problems = checkPhotoBookPlanConsistency(plan, { availableAssetIds, allAssetIds });
    return { plan, problems };
  }

  function randomish(n: number, seed: number): number {
    // Deterministic pseudo-random-ish jitter, no `Math.random()` — keeps the test stable.
    return ((seed * 9301 + 49297) * (n + 1)) % 233280;
  }

  it('is consistent for a single small section', () => {
    const photos = Array.from({ length: 5 }, (_, i) =>
      photo({
        assetId: `p${i}`,
        position: i,
        takenAt: new Date(t0 + i * HOUR),
        width: 800 + (randomish(i, 1) % 2000),
        height: 600 + (randomish(i, 2) % 1500),
        blurScore: 50 + (randomish(i, 3) % 150),
      }),
    );
    const { plan, problems } = checkConsistency(baseInput(photos));
    expect(problems).toEqual([]);
    const interior = plan.sections.flatMap((s) => s.pages.flatMap((p) => p.assetIds));
    if (plan.cover.heroAssetId) expect(interior).not.toContain(plan.cover.heroAssetId);
  });

  it('is consistent for a handful of photos (fewer than a full section)', () => {
    const photos = [
      photo({ assetId: 'x', position: 0, takenAt: new Date(t0), width: 1600, height: 1200 }),
      photo({ assetId: 'y', position: 1, takenAt: new Date(t0 + HOUR), width: 1200, height: 1600 }),
    ];
    const { plan, problems } = checkConsistency(baseInput(photos));
    expect(problems).toEqual([]);
    const interior = plan.sections.flatMap((s) => s.pages.flatMap((p) => p.assetIds));
    if (plan.cover.heroAssetId) expect(interior).not.toContain(plan.cover.heroAssetId);
  });

  it('is consistent for a single photo (whole book collapses to just a cover)', () => {
    const photos = [photo({ assetId: 'solo', position: 0, takenAt: new Date(t0), width: 2400, height: 1600 })];
    const { plan, problems } = checkConsistency(baseInput(photos));
    expect(problems).toEqual([]);
    expect(plan.cover.heroAssetId).toBe('solo');
    expect(plan.sections).toEqual([]);
  });

  it('is consistent across multiple date/GPS-separated sections', () => {
    const clusters = [0, 1, 2].map((cluster) =>
      Array.from({ length: 6 }, (_, i) =>
        photo({
          assetId: `c${cluster}-${i}`,
          position: cluster * 6 + i,
          takenAt: new Date(t0 + cluster * 3 * DAY + i * HOUR),
          width: 1000 + (randomish(i, cluster + 10) % 3000),
          height: 800 + (randomish(i, cluster + 20) % 2200),
          blurScore: 40 + (randomish(i, cluster + 30) % 160),
          phash: (i % 3 === 0 ? 'a' : 'f').repeat(16),
        }),
      ),
    ).flat();
    const { plan, problems } = checkConsistency(baseInput(clusters));
    expect(problems).toEqual([]);
    expect(plan.sections.length).toBeGreaterThan(1);
    const interior = plan.sections.flatMap((s) => s.pages.flatMap((p) => p.assetIds));
    if (plan.cover.heroAssetId) expect(interior).not.toContain(plan.cover.heroAssetId);
  });

  it('is consistent for a large, many-photo book spanning many sections', () => {
    const photos = Array.from({ length: 120 }, (_, i) => {
      const cluster = Math.floor(i / 12);
      return photo({
        assetId: `l${i}`,
        position: i,
        takenAt: new Date(t0 + cluster * 2 * DAY + (i % 12) * HOUR),
        gpsLat: 48 + cluster * 2,
        gpsLng: 11 + cluster * 2,
        width: 900 + (randomish(i, 40) % 3500),
        height: 700 + (randomish(i, 50) % 2800),
        blurScore: 30 + (randomish(i, 60) % 170),
      });
    });
    const { plan, problems } = checkConsistency(baseInput(photos));
    expect(problems).toEqual([]);
    expect(plan.sections.length).toBeGreaterThan(1);
    const interior = plan.sections.flatMap((s) => s.pages.flatMap((p) => p.assetIds));
    if (plan.cover.heroAssetId) expect(interior).not.toContain(plan.cover.heroAssetId);
  });

  it('is consistent with an explicit cover pin that would otherwise collide with a section opener', () => {
    const photos = Array.from({ length: 8 }, (_, i) =>
      photo({
        assetId: `q${i}`,
        position: i,
        takenAt: new Date(t0 + i * HOUR),
        width: 4000, // identical resolution — every photo is an equally strong "best photo" candidate
        height: 3000,
      }),
    );
    const { plan, problems } = checkConsistency({ ...baseInput(photos), coverAssetId: 'q3' });
    expect(problems).toEqual([]);
    expect(plan.cover.heroAssetId).toBe('q3');
    const interior = plan.sections.flatMap((s) => s.pages.flatMap((p) => p.assetIds));
    expect(interior).not.toContain('q3');
  });
});

describe('computeCandidateSections', () => {
  it('is the exact grouping buildPhotoBookAutoLayout uses for its own sections', () => {
    // 8 photos/cluster (16 total) — comfortably clears the section-count cap
    // (ceil(16 / SECTION_CAP_DIVISOR=8) = 2), so this isolates boundary detection.
    const cluster1 = Array.from({ length: 8 }, (_, i) =>
      photo({ assetId: `a${i}`, position: i, takenAt: new Date(t0 + i * HOUR) }),
    );
    const cluster2 = Array.from({ length: 8 }, (_, i) =>
      photo({ assetId: `b${i}`, position: 8 + i, takenAt: new Date(t0 + 3 * DAY + i * HOUR) }),
    );
    const sections = computeCandidateSections([...cluster1, ...cluster2]);
    expect(sections).toHaveLength(2);
    expect(sections[0].map((p) => p.assetId)).toEqual(cluster1.map((p) => p.assetId));
    expect(sections[1].map((p) => p.assetId)).toEqual(cluster2.map((p) => p.assetId));
  });

  it('returns an empty array for no photos', () => {
    expect(computeCandidateSections([])).toEqual([]);
  });
});

describe('buildPhotoBookAutoLayout — score-aware culling (PR3)', () => {
  it('is a complete no-op when no photo has analysis (backward compatibility)', () => {
    // Same fixture as the existing "culls a clearly-blurry photo" test — asserting the
    // score-aware cullers don't change anything when `analysis` is absent anywhere.
    const photos = [
      photo({ assetId: 'sharp1', position: 0, takenAt: new Date(t0), blurScore: 100 }),
      photo({ assetId: 'sharp2', position: 1, takenAt: new Date(t0 + 60_000), blurScore: 90 }),
      photo({ assetId: 'blurry', position: 2, takenAt: new Date(t0 + 120_000), blurScore: 5 }),
    ];
    const { culled } = buildPhotoBookAutoLayout(baseInput(photos));
    expect(culled).toEqual([{ assetId: 'blurry', reason: 'blurry' }]);
  });

  it('culls an eyes-closed photo when a sharp-eyed sibling exists in the same section', () => {
    const photos = [
      photo({ assetId: 'open', position: 0, takenAt: new Date(t0), analysis: analysis({ eyesClosed: false }) }),
      photo({ assetId: 'closed', position: 1, takenAt: new Date(t0 + 60_000), analysis: analysis({ eyesClosed: true }) }),
      photo({ assetId: 'other', position: 2, takenAt: new Date(t0 + 120_000), analysis: analysis({ eyesClosed: false }) }),
    ];
    const { culled } = buildPhotoBookAutoLayout({ ...baseInput(photos), coverAssetId: 'unrelated-cover' });
    expect(culled).toContainEqual({ assetId: 'closed', reason: 'eyes-closed' });
  });

  it('never culls an eyes-closed photo when nothing in the section has open eyes', () => {
    const photos = [
      photo({ assetId: 'a', position: 0, takenAt: new Date(t0), analysis: analysis({ eyesClosed: true }) }),
      photo({ assetId: 'b', position: 1, takenAt: new Date(t0 + 60_000), analysis: analysis({ eyesClosed: true }) }),
    ];
    const { culled } = buildPhotoBookAutoLayout(baseInput(photos));
    expect(culled.filter((c) => c.reason === 'eyes-closed')).toEqual([]);
  });

  it('never eyes-closed-culls a photo with no analysis, even alongside scored siblings', () => {
    const photos = [
      photo({ assetId: 'unscored', position: 0, takenAt: new Date(t0) }),
      photo({ assetId: 'open', position: 1, takenAt: new Date(t0 + 60_000), analysis: analysis({ eyesClosed: false }) }),
    ];
    const { culled } = buildPhotoBookAutoLayout(baseInput(photos));
    expect(culled.some((c) => c.assetId === 'unscored')).toBe(false);
  });

  it('drops the lowest-aestheticScore surplus of an oversized, mostly-scored section', () => {
    // 45 photos, all scored, one section (same-hour timestamps) — comfortably over
    // MAX_SCORED_SECTION_PHOTOS (40), so the 5 lowest-scored should be dropped.
    const photos = Array.from({ length: 45 }, (_, i) =>
      photo({
        assetId: `p${i}`,
        position: i,
        takenAt: new Date(t0 + i * 1000),
        analysis: analysis({ aestheticScore: i / 10 }), // 0.0 .. 4.4, strictly increasing
      }),
    );
    const { culled } = buildPhotoBookAutoLayout({ ...baseInput(photos), coverAssetId: 'unrelated-cover' });
    const lowQuality = culled.filter((c) => c.reason === 'low-quality');
    expect(lowQuality).toHaveLength(5);
    // The 5 lowest-scored (p0..p4) are exactly the ones dropped.
    expect(lowQuality.map((c) => c.assetId).sort()).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
  });

  it('does not trim an oversized section when too few of its photos are scored', () => {
    const photos = Array.from({ length: 45 }, (_, i) =>
      photo({
        assetId: `p${i}`,
        position: i,
        takenAt: new Date(t0 + i * 1000),
        // Only score a small minority — under the 80% threshold.
        analysis: i < 5 ? analysis({ aestheticScore: 1 }) : undefined,
      }),
    );
    const { culled } = buildPhotoBookAutoLayout(baseInput(photos));
    expect(culled.filter((c) => c.reason === 'low-quality')).toEqual([]);
  });

  it('does not trim a section at or under the cap even if fully scored', () => {
    const photos = Array.from({ length: 40 }, (_, i) =>
      photo({ assetId: `p${i}`, position: i, takenAt: new Date(t0 + i * 1000), analysis: analysis({ aestheticScore: i / 10 }) }),
    );
    const { culled } = buildPhotoBookAutoLayout(baseInput(photos));
    expect(culled.filter((c) => c.reason === 'low-quality')).toEqual([]);
  });
});

describe('buildPhotoBookAutoLayout — score-aware hero/opener selection (PR3)', () => {
  it('prefers a coverCandidate photo over a higher-resolution non-candidate', () => {
    const photos = [
      photo({ assetId: 'big', position: 0, takenAt: new Date(t0), width: 4000, height: 3000, analysis: analysis({ coverCandidate: false, aestheticScore: 9 }) }),
      photo({ assetId: 'candidate', position: 1, takenAt: new Date(t0 + HOUR), width: 800, height: 600, analysis: analysis({ coverCandidate: true, aestheticScore: 6 }) }),
    ];
    const { plan } = buildPhotoBookAutoLayout(baseInput(photos));
    expect(plan.cover.heroAssetId).toBe('candidate');
  });

  it('among non-candidates, prefers the higher aestheticScore over resolution', () => {
    const photos = [
      photo({ assetId: 'big-lower-score', position: 0, takenAt: new Date(t0), width: 4000, height: 3000, analysis: analysis({ aestheticScore: 4 }) }),
      photo({ assetId: 'small-higher-score', position: 1, takenAt: new Date(t0 + HOUR), width: 800, height: 600, analysis: analysis({ aestheticScore: 8 }) }),
    ];
    const { plan } = buildPhotoBookAutoLayout(baseInput(photos));
    expect(plan.cover.heroAssetId).toBe('small-higher-score');
  });

  it('falls back to the pure resolution heuristic when nothing in the pool is analyzed', () => {
    const photos = [
      photo({ assetId: 'big', position: 0, takenAt: new Date(t0), width: 4000, height: 3000 }),
      photo({ assetId: 'small', position: 1, takenAt: new Date(t0 + HOUR), width: 400, height: 300 }),
    ];
    const { plan } = buildPhotoBookAutoLayout(baseInput(photos));
    expect(plan.cover.heroAssetId).toBe('big');
  });

  it('treats an unscored photo as neutral (score 5), not as worthless', () => {
    const photos = [
      photo({ assetId: 'unscored', position: 0, takenAt: new Date(t0), width: 4000, height: 3000 }),
      photo({ assetId: 'low-scored', position: 1, takenAt: new Date(t0 + HOUR), width: 800, height: 600, analysis: analysis({ aestheticScore: 1 }) }),
    ];
    const { plan } = buildPhotoBookAutoLayout(baseInput(photos));
    // Neutral (5) beats an explicit low score (1) — the unscored photo wins.
    expect(plan.cover.heroAssetId).toBe('unscored');
  });

  it('an explicit cover pin still always wins over scores', () => {
    const photos = [
      photo({ assetId: 'a', position: 0, takenAt: new Date(t0), analysis: analysis({ coverCandidate: true, aestheticScore: 10 }) }),
      photo({ assetId: 'b', position: 1, takenAt: new Date(t0 + HOUR), analysis: analysis({ coverCandidate: false, aestheticScore: 1 }) }),
    ];
    const { plan } = buildPhotoBookAutoLayout({ ...baseInput(photos), coverAssetId: 'b' });
    expect(plan.cover.heroAssetId).toBe('b');
  });
});

describe('buildPhotoBookAutoLayout — plan consistency with analysis present (regression)', () => {
  // Extends PR2's consistency regression coverage to the analysis-present path: every
  // culling/hero-selection decision score-aware logic makes must still leave a plan that
  // passes checkPhotoBookPlanConsistency, and must never reintroduce the duplicate-hero
  // bug (docs/PHOTO_BOOK_PLAN.md PR3 scope).

  function checkConsistency(input: PhotoBookAutoLayoutInput) {
    const { plan, culled } = buildPhotoBookAutoLayout(input);
    const culledIds = new Set(culled.map((c) => c.assetId));
    const allAssetIds = input.photos.map((p) => p.assetId);
    const availableAssetIds = allAssetIds.filter((id) => !culledIds.has(id));
    const problems = checkPhotoBookPlanConsistency(plan, { availableAssetIds, allAssetIds });
    return { plan, problems };
  }

  function randomish(n: number, seed: number): number {
    return ((seed * 9301 + 49297) * (n + 1)) % 233280;
  }

  it('is consistent for a fully-analyzed, oversized single section (triggers every culler)', () => {
    const photos = Array.from({ length: 60 }, (_, i) =>
      photo({
        assetId: `p${i}`,
        position: i,
        takenAt: new Date(t0 + i * 1000),
        width: 800 + (randomish(i, 1) % 3000),
        height: 600 + (randomish(i, 2) % 2200),
        blurScore: 20 + (randomish(i, 3) % 180),
        phash: (i % 7 === 0 ? 'a' : (randomish(i, 4) % 16).toString(16)).repeat(16),
        analysis: analysis({
          aestheticScore: (randomish(i, 5) % 100) / 10,
          eyesClosed: i % 4 === 0,
          coverCandidate: i % 11 === 0,
        }),
      }),
    );
    const { plan, problems } = checkConsistency(baseInput(photos));
    expect(problems).toEqual([]);
    const interior = plan.sections.flatMap((s) => s.pages.flatMap((p) => p.assetIds));
    if (plan.cover.heroAssetId) expect(interior).not.toContain(plan.cover.heroAssetId);
  });

  it('is consistent across multiple sections with a mix of analyzed and unanalyzed photos', () => {
    const clusters = [0, 1, 2].map((cluster) =>
      Array.from({ length: 8 }, (_, i) =>
        photo({
          assetId: `c${cluster}-${i}`,
          position: cluster * 8 + i,
          takenAt: new Date(t0 + cluster * 3 * DAY + i * HOUR),
          width: 1000 + (randomish(i, cluster + 10) % 3000),
          height: 800 + (randomish(i, cluster + 20) % 2200),
          blurScore: 40 + (randomish(i, cluster + 30) % 160),
          // Only half of each cluster gets a vision score — the mixed-analysis case.
          analysis: i % 2 === 0 ? analysis({ aestheticScore: (randomish(i, cluster + 40) % 100) / 10, eyesClosed: i % 6 === 0 }) : undefined,
        }),
      ),
    ).flat();
    const { plan, problems } = checkConsistency(baseInput(clusters));
    expect(problems).toEqual([]);
    const interior = plan.sections.flatMap((s) => s.pages.flatMap((p) => p.assetIds));
    if (plan.cover.heroAssetId) expect(interior).not.toContain(plan.cover.heroAssetId);
  });

  it('is consistent when every photo in a section is eyes-closed except the pinned cover', () => {
    const photos = Array.from({ length: 6 }, (_, i) =>
      photo({
        assetId: `q${i}`,
        position: i,
        takenAt: new Date(t0 + i * HOUR),
        analysis: analysis({ eyesClosed: i !== 0 }),
      }),
    );
    const { plan, problems } = checkConsistency({ ...baseInput(photos), coverAssetId: 'q0' });
    expect(problems).toEqual([]);
    expect(plan.cover.heroAssetId).toBe('q0');
  });

  it('is consistent for a large, many-photo, fully-analyzed book spanning many sections', () => {
    const photos = Array.from({ length: 150 }, (_, i) => {
      const cluster = Math.floor(i / 15);
      return photo({
        assetId: `l${i}`,
        position: i,
        takenAt: new Date(t0 + cluster * 2 * DAY + (i % 15) * HOUR),
        gpsLat: 48 + cluster * 2,
        gpsLng: 11 + cluster * 2,
        width: 900 + (randomish(i, 40) % 3500),
        height: 700 + (randomish(i, 50) % 2800),
        blurScore: 30 + (randomish(i, 60) % 170),
        analysis: analysis({
          aestheticScore: (randomish(i, 70) % 100) / 10,
          eyesClosed: i % 5 === 0,
          coverCandidate: i % 23 === 0,
        }),
      });
    });
    const { plan, problems } = checkConsistency(baseInput(photos));
    expect(problems).toEqual([]);
    expect(plan.sections.length).toBeGreaterThan(1);
    const interior = plan.sections.flatMap((s) => s.pages.flatMap((p) => p.assetIds));
    if (plan.cover.heroAssetId) expect(interior).not.toContain(plan.cover.heroAssetId);
  });
});
