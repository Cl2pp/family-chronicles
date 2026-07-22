import { describe, expect, it } from 'vitest';
import { groupingCoverage, type GroupingCoveragePhoto } from '@/lib/photo-book-grouping';

function photo(overrides: Partial<GroupingCoveragePhoto> = {}): GroupingCoveragePhoto {
  return { excluded: false, hasLocation: true, hasAnalysis: true, ...overrides };
}

describe('groupingCoverage', () => {
  it('always supports chronological — it needs nothing from the photos', () => {
    const photos = [photo({ hasLocation: false, hasAnalysis: false })];
    expect(groupingCoverage(photos, 'chronological')).toEqual({ supported: 1, total: 1, sufficient: true });
  });

  it('reports the real GPS shortfall (the production book had none of 36)', () => {
    const photos = Array.from({ length: 36 }, () => photo({ hasLocation: false }));
    expect(groupingCoverage(photos, 'location')).toEqual({ supported: 0, total: 36, sufficient: false });
  });

  it('counts only photos that are still in the layout', () => {
    const photos = [
      photo({ hasLocation: true }),
      photo({ hasLocation: false, excluded: true }),
      photo({ hasLocation: false, excluded: true }),
    ];
    // Two unlocated photos are excluded, so the one remaining photo is full coverage.
    expect(groupingCoverage(photos, 'location')).toEqual({ supported: 1, total: 1, sufficient: true });
  });

  it('accepts a set that is half covered and rejects one just under', () => {
    const half = [photo({ hasAnalysis: true }), photo({ hasAnalysis: false })];
    expect(groupingCoverage(half, 'topic').sufficient).toBe(true);
    const under = [photo({ hasAnalysis: true }), photo({ hasAnalysis: false }), photo({ hasAnalysis: false })];
    expect(groupingCoverage(under, 'topic').sufficient).toBe(false);
  });

  it('treats an empty book as fine rather than dividing by zero', () => {
    expect(groupingCoverage([], 'location')).toEqual({ supported: 0, total: 0, sufficient: true });
  });
});
