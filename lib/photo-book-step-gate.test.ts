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

describe('canAccessPhotoBookStep — content gate (unified builder)', () => {
  it('blocks step 2 for an empty book even though analysis is vacuously complete', () => {
    // Zero photos means `analysisComplete` is trivially true; without the content check
    // a brand-new book would walk straight into "Create book" with nothing to lay out.
    expect(canAccessPhotoBookStep(1, true, null, false)).toBe(false);
  });

  it('allows step 2 for a text-only book (stories attached, no photos)', () => {
    expect(canAccessPhotoBookStep(1, true, null, true)).toBe(true);
  });

  it('still blocks step 2 while photos are analyzing, content or not', () => {
    expect(canAccessPhotoBookStep(1, false, null, true)).toBe(false);
  });

  it('defaults to has-content so existing callers are unaffected', () => {
    expect(canAccessPhotoBookStep(1, true, null)).toBe(true);
  });
});
