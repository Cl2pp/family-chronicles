import { describe, expect, it } from 'vitest';
import { isBookPrintFresh } from './book-print-status';
import type { BookStatus } from './books';

const NOT_PREVIEW_READY: BookStatus[] = ['draft', 'rendering', 'render_failed'];

describe('isBookPrintFresh', () => {
  it('is fresh for an ordered book regardless of status oddities or staleness', () => {
    expect(isBookPrintFresh('legacy', 'ordered', false)).toBe(true);
    expect(isBookPrintFresh('unified', 'ordered', true)).toBe(true);
  });

  it('is never fresh outside preview_ready/ordered', () => {
    for (const status of NOT_PREVIEW_READY) {
      expect(isBookPrintFresh('legacy', status, false)).toBe(false);
      expect(isBookPrintFresh('unified', status, false)).toBe(false);
      expect(isBookPrintFresh('unified', status, true)).toBe(false);
    }
  });

  it('a preview_ready LEGACY book is fresh regardless of layoutStale', () => {
    // The legacy story path never maintained `layoutStale` — it downgrades `status`
    // back to `draft` on any content change (`invalidatePreview`), so the flag alone
    // must not gate those books.
    expect(isBookPrintFresh('legacy', 'preview_ready', false)).toBe(true);
    expect(isBookPrintFresh('legacy', 'preview_ready', true)).toBe(true);
  });

  it('a preview_ready UNIFIED book is fresh only when not layoutStale', () => {
    // Keyed on the engine, not `books.kind`: a story-ENTRY book (kind 'story') now runs
    // on the unified engine, which does maintain `layoutStale`, so it must be honoured —
    // gating on kind here would have served stale print PDFs for every new book.
    expect(isBookPrintFresh('unified', 'preview_ready', false)).toBe(true);
    expect(isBookPrintFresh('unified', 'preview_ready', true)).toBe(false);
  });
});
