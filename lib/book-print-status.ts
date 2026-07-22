import type { BookStatus } from './books';

/**
 * Whether a book's stored print PDF (`previewS3Key`/`printS3Key`) can be trusted to
 * match its CURRENT content — the order screen's "show quote + Download" gate
 * (`app/(app)/books/[bookId]/order/page.tsx` + `order-view.tsx`), and the photo-book
 * builder's own "Download PDF" / "Order" gates (`photo-book-builder.tsx`).
 *
 * Deliberately free of any `db`/`env` import (like `lib/photo-book-ops.ts`) so it can be
 * imported by value into client components ('use client' files can only safely import
 * runtime code from lib/books.ts as types, since that module pulls in the database).
 *
 * `ordered` books are always considered ready: once ordered they're locked (no further
 * content mutation is possible — `editablePhotoBook`/`editableBook` reject everything
 * but deletion), so whatever PDF exists is final.
 *
 * For every other status, only `preview_ready` counts, and — for photo books only —
 * `layoutStale` must also be false. Story books never need that second check: every
 * content-changing mutation (`updateBook`, `setBookStories`, `lib/books.ts`) already
 * downgrades `status` back to `draft` via `invalidatePreview()`, so `preview_ready`
 * alone means fresh. Photo-book mutations (`addBookPhotos`, `setPhotoExcluded`,
 * `updatePhotoBookLayout`) do the same downgrade now, but `layoutStale` is kept here as
 * a belt-and-braces check for the one race that downgrade can't close: a mutation
 * landing WHILE a render is already in flight (`status: 'rendering'`) can't downgrade a
 * status that isn't `preview_ready` yet, and when that render later completes
 * (`renderBook`/`renderPhotoBook`, `lib/book-render.ts`) it always sets
 * `status: 'preview_ready'` unconditionally — leaving `layoutStale: true` on an
 * otherwise-"ready"-looking book until the next render clears it.
 */
export function isBookPrintFresh(
  engine: 'legacy' | 'unified',
  status: BookStatus,
  layoutStale: boolean,
): boolean {
  if (status === 'ordered') return true;
  if (status !== 'preview_ready') return false;
  // `layoutStale` is only maintained by the unified pipeline; the legacy story path
  // relies on `invalidatePreview()` alone. Keyed on the ENGINE, not `books.kind` —
  // a story-entry book on the unified engine must honour its stale flag too.
  return engine === 'legacy' || !layoutStale;
}
