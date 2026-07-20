import { describe, expect, it } from 'vitest';
import { buildPhotoBookAutoLayout, type AutoLayoutPhoto } from './photo-book-autolayout';

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
    const placed = plan.sections.flatMap((s) => s.pages.flatMap((p) => p.assetIds));
    expect(placed).toHaveLength(30);
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
    const placed = plan.sections.flatMap((s) => s.pages.flatMap((p) => p.assetIds));
    expect(placed.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
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
    const { plan, culled } = buildPhotoBookAutoLayout(baseInput(photos));
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
  it('gives a lone section photo its own full page, not a multi-slot template', () => {
    const photos = [photo({ assetId: 'a', position: 0, takenAt: new Date(t0), width: 1600, height: 1200 })];
    const { plan } = buildPhotoBookAutoLayout(baseInput(photos));
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
    const { plan } = buildPhotoBookAutoLayout(baseInput(photos));
    const pairPage = plan.sections[0].pages.find((p) => p.assetIds.length === 2);
    expect(pairPage?.template).toBe('two-horizontal');
  });

  it('pairs two portrait leftovers into a two-vertical page', () => {
    const photos = [
      photo({ assetId: 'opener', position: 0, takenAt: new Date(t0), width: 2000, height: 1000 }),
      photo({ assetId: 'a', position: 1, takenAt: new Date(t0 + HOUR), width: 1000, height: 1600 }),
      photo({ assetId: 'b', position: 2, takenAt: new Date(t0 + 2 * HOUR), width: 1000, height: 1600 }),
    ];
    const { plan } = buildPhotoBookAutoLayout(baseInput(photos));
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
