import { describe, expect, it } from 'vitest';
import { canAccessPhotoBookStep } from './photo-book-step-gate';

describe('canAccessPhotoBookStep', () => {
  it('always allows step 0 (upload)', () => {
    expect(canAccessPhotoBookStep(0, false, null)).toBe(true);
  });

  it('blocks step 1+ (create) until analysis is complete', () => {
    expect(canAccessPhotoBookStep(1, false, null)).toBe(false);
    expect(canAccessPhotoBookStep(1, true, null)).toBe(true);
  });

  it('blocks step 2 (order) until the book has been generated, even with analysis done', () => {
    expect(canAccessPhotoBookStep(2, true, null)).toBe(false);
    expect(canAccessPhotoBookStep(2, true, '2026-07-21T00:00:00.000Z')).toBe(true);
  });

  it('blocks step 2 (order) when analysis is also incomplete', () => {
    expect(canAccessPhotoBookStep(2, false, '2026-07-21T00:00:00.000Z')).toBe(false);
  });

  it('accepts a Date for generatedAt, not just a string', () => {
    expect(canAccessPhotoBookStep(2, true, new Date())).toBe(true);
  });
});
