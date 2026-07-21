import { describe, expect, it } from 'vitest';
import { computeCandidateSections, type AutoLayoutPhoto } from '@/lib/photo-book-autolayout';
import {
  DEFAULT_PHOTO_BOOK_GROUPING,
  groupingInstruction,
  parsePhotoGrouping,
  PHOTO_BOOK_GROUPINGS,
} from '@/lib/photo-book-grouping';
import type { PhotoAnalysis } from '@/lib/photo-analysis';

function analysis(tags: string[]): PhotoAnalysis {
  return {
    aestheticScore: 6,
    sharpness: 'sharp',
    eyesClosed: false,
    peopleCount: 2,
    sceneTags: tags,
    shortDescription: tags.join(', '),
    coverCandidate: false,
  };
}

let seq = 0;
function photo(overrides: Partial<AutoLayoutPhoto> = {}): AutoLayoutPhoto {
  seq += 1;
  return {
    assetId: `a${seq}`,
    width: 4000,
    height: 3000,
    position: seq,
    takenAt: new Date(`2025-06-${String((seq % 27) + 1).padStart(2, '0')}T12:00:00Z`),
    gpsLat: null,
    gpsLng: null,
    phash: null,
    blurScore: null,
    ...overrides,
  };
}

/** Which group each assetId landed in, for order-independent assertions. */
function groupOf(groups: AutoLayoutPhoto[][], assetId: string): number {
  return groups.findIndex((g) => g.some((p) => p.assetId === assetId));
}

describe('parsePhotoGrouping', () => {
  it('round-trips every known grouping and defaults everything else', () => {
    for (const g of PHOTO_BOOK_GROUPINGS) expect(parsePhotoGrouping(g)).toBe(g);
    expect(parsePhotoGrouping(null)).toBe(DEFAULT_PHOTO_BOOK_GROUPING);
    expect(parsePhotoGrouping('by-vibes')).toBe(DEFAULT_PHOTO_BOOK_GROUPING);
    expect(DEFAULT_PHOTO_BOOK_GROUPING).toBe('chronological');
  });
});

describe('groupingInstruction', () => {
  it('gives each grouping its own instruction', () => {
    const texts = PHOTO_BOOK_GROUPINGS.map(groupingInstruction);
    expect(new Set(texts).size).toBe(texts.length);
    expect(groupingInstruction('topic')).toMatch(/TOPIC/);
    expect(groupingInstruction('location')).toMatch(/PLACE/);
  });
});

// Book sizes here are deliberately >= ~16 photos: `capSectionCount` allows roughly one
// section per 8 photos (`SECTION_CAP_DIVISOR`), so a 6-photo book is legitimately a
// single section in EVERY grouping mode — including the chronological one that predates
// this feature. Small fixtures would be testing that cap, not the grouping.
describe('computeCandidateSections — chronological', () => {
  it('is the default and still splits on a big time gap', () => {
    const photos = [
      ...Array.from({ length: 8 }, (_, i) =>
        photo({ assetId: `day1-${i}`, takenAt: new Date(`2025-06-01T${String(8 + i).padStart(2, '0')}:00:00Z`) }),
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        photo({ assetId: `day9-${i}`, takenAt: new Date(`2025-06-09T${String(8 + i).padStart(2, '0')}:00:00Z`) }),
      ),
    ];
    const groups = computeCandidateSections(photos);
    expect(groups).toHaveLength(2);
    expect(groupOf(groups, 'day1-0')).not.toBe(groupOf(groups, 'day9-0'));
    // Explicit and default agree — the default must not change behaviour for old books.
    expect(computeCandidateSections(photos, 'chronological')).toEqual(groups);
  });
});

describe('computeCandidateSections — location', () => {
  it('groups by place even when the visits are months apart', () => {
    // Munich in June, Hamburg in July, Munich again in September.
    const munich = { gpsLat: 48.14, gpsLng: 11.58 };
    const hamburg = { gpsLat: 53.55, gpsLng: 9.99 };
    const photos = [
      ...Array.from({ length: 6 }, (_, i) =>
        photo({ assetId: `mun-jun-${i}`, takenAt: new Date(`2025-06-0${i + 1}T12:00:00Z`), ...munich }),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        photo({ assetId: `ham-${i}`, takenAt: new Date(`2025-07-0${i + 1}T12:00:00Z`), ...hamburg }),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        photo({ assetId: `mun-sep-${i}`, takenAt: new Date(`2025-09-0${i + 1}T12:00:00Z`), ...munich }),
      ),
    ];
    const groups = computeCandidateSections(photos, 'location');
    expect(groups).toHaveLength(2);
    // The two Munich visits share a section despite the three-month gap...
    expect(groupOf(groups, 'mun-jun-0')).toBe(groupOf(groups, 'mun-sep-0'));
    // ...and Hamburg is its own.
    expect(groupOf(groups, 'ham-0')).not.toBe(groupOf(groups, 'mun-jun-0'));
    // Chronological mode would have split the same photos by date instead.
    expect(computeCandidateSections(photos, 'chronological').length).toBeGreaterThan(2);
  });

  it('keeps photos without coordinates out of the located sections', () => {
    const photos = [
      ...Array.from({ length: 8 }, (_, i) =>
        photo({ assetId: `gps-${i}`, gpsLat: 48.14, gpsLng: 11.58 }),
      ),
      ...Array.from({ length: 8 }, (_, i) => photo({ assetId: `nogps-${i}` })),
    ];
    const groups = computeCandidateSections(photos, 'location');
    expect(groupOf(groups, 'nogps-0')).not.toBe(groupOf(groups, 'gps-0'));
    expect(groupOf(groups, 'nogps-0')).toBe(groupOf(groups, 'nogps-3'));
  });

  it('places every photo exactly once', () => {
    const photos = Array.from({ length: 12 }, (_, i) =>
      photo({ assetId: `p${i}`, gpsLat: i < 6 ? 48.14 : 53.55, gpsLng: i < 6 ? 11.58 : 9.99 }),
    );
    const placed = computeCandidateSections(photos, 'location').flat().map((p) => p.assetId);
    expect(placed.sort()).toEqual(photos.map((p) => p.assetId).sort());
  });
});

describe('computeCandidateSections — topic', () => {
  it('groups by what the photos show, across dates', () => {
    const photos = [
      ...Array.from({ length: 8 }, (_, i) =>
        photo({
          assetId: `bday-${i}`,
          takenAt: new Date(`2024-0${(i % 9) + 1}-01T12:00:00Z`),
          analysis: analysis(['birthday', 'group photo']),
        }),
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        photo({
          assetId: `beach-${i}`,
          takenAt: new Date(`2025-0${(i % 9) + 1}-01T12:00:00Z`),
          analysis: analysis(['beach', 'group photo']),
        }),
      ),
    ];
    const groups = computeCandidateSections(photos, 'topic');
    expect(groups).toHaveLength(2);
    expect(groupOf(groups, 'bday-0')).toBe(groupOf(groups, 'bday-2'));
    expect(groupOf(groups, 'beach-0')).not.toBe(groupOf(groups, 'bday-0'));
  });

  it('does not let a ubiquitous tag swallow the distinctive ones', () => {
    // Every photo is tagged "family"; only the rarer tag should decide the grouping.
    const photos = [
      ...Array.from({ length: 8 }, (_, i) => photo({ assetId: `dog-${i}`, analysis: analysis(['family', 'dog']) })),
      ...Array.from({ length: 8 }, (_, i) => photo({ assetId: `ski-${i}`, analysis: analysis(['family', 'skiing']) })),
    ];
    const groups = computeCandidateSections(photos, 'topic');
    expect(groupOf(groups, 'dog-0')).not.toBe(groupOf(groups, 'ski-0'));
  });

  it('keeps unscored photos separate rather than guessing', () => {
    const photos = [
      ...Array.from({ length: 8 }, (_, i) => photo({ assetId: `tagged-${i}`, analysis: analysis(['beach']) })),
      ...Array.from({ length: 8 }, (_, i) => photo({ assetId: `untagged-${i}` })),
    ];
    const groups = computeCandidateSections(photos, 'topic');
    expect(groupOf(groups, 'untagged-0')).not.toBe(groupOf(groups, 'tagged-0'));
  });

  it('places every photo exactly once', () => {
    const photos = Array.from({ length: 15 }, (_, i) =>
      photo({ assetId: `p${i}`, analysis: i % 3 === 0 ? undefined : analysis([`tag${i % 4}`]) }),
    );
    const placed = computeCandidateSections(photos, 'topic').flat().map((p) => p.assetId);
    expect(placed.sort()).toEqual(photos.map((p) => p.assetId).sort());
  });
});
