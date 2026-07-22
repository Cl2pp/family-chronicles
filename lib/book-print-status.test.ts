import { describe, expect, it } from 'vitest';
import { isBookPrintFresh } from './book-print-status';
import type { BookStatus } from './books';

const NOT_PREVIEW_READY: BookStatus[] = ['draft', 'rendering', 'render_failed'];

describe('isBookPrintFresh', () => {
  it('is fresh for an ordered book regardless of staleness', () => {
    expect(isBookPrintFresh('ordered', false)).toBe(true);
    expect(isBookPrintFresh('ordered', true)).toBe(true);
  });

  it('is never fresh outside preview_ready/ordered', () => {
    for (const status of NOT_PREVIEW_READY) {
      expect(isBookPrintFresh(status, false)).toBe(false);
      expect(isBookPrintFresh(status, true)).toBe(false);
    }
  });

  it('a preview_ready book is fresh only when its plan has not gone stale', () => {
    // Every book maintains `layoutStale` now that one engine renders them all — the
    // old kind/engine parameter existed only for the retired story path, which relied
    // on `invalidatePreview()` alone.
    expect(isBookPrintFresh('preview_ready', false)).toBe(true);
    expect(isBookPrintFresh('preview_ready', true)).toBe(false);
  });
});
