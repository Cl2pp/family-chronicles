import { describe, expect, it } from 'vitest';
import { isBookPrintFresh } from './book-print-status';
import type { BookStatus } from './books';

const NOT_PREVIEW_READY: BookStatus[] = ['draft', 'rendering', 'render_failed'];

describe('isBookPrintFresh', () => {
  it('is fresh for an ordered book regardless of status oddities or staleness', () => {
    expect(isBookPrintFresh('story', 'ordered', false)).toBe(true);
    expect(isBookPrintFresh('photo', 'ordered', true)).toBe(true);
  });

  it('is never fresh outside preview_ready/ordered', () => {
    for (const status of NOT_PREVIEW_READY) {
      expect(isBookPrintFresh('story', status, false)).toBe(false);
      expect(isBookPrintFresh('photo', status, false)).toBe(false);
      expect(isBookPrintFresh('photo', status, true)).toBe(false);
    }
  });

  it('a preview_ready story book is fresh regardless of layoutStale', () => {
    // Story-book mutations always downgrade `status` back to `draft` on any content
    // change (`invalidatePreview`), so `layoutStale` alone should never gate a story
    // book here — this documents that the predicate intentionally ignores it for them.
    expect(isBookPrintFresh('story', 'preview_ready', false)).toBe(true);
    expect(isBookPrintFresh('story', 'preview_ready', true)).toBe(true);
  });

  it('a preview_ready photo book is fresh only when not layoutStale', () => {
    expect(isBookPrintFresh('photo', 'preview_ready', false)).toBe(true);
    expect(isBookPrintFresh('photo', 'preview_ready', true)).toBe(false);
  });
});
