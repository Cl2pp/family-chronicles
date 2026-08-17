import { describe, expect, it, vi } from 'vitest';

/**
 * `lib/books.ts` is DB-backed, so this file mocks the two leaves that would otherwise be
 * touched on import — `@/lib/env` (validating the whole process environment) and `@/db`
 * (opening a Postgres pool) — the same trick `lib/photo-book-ai-layout.test.ts` uses.
 * What's covered here is deliberately narrow: the mutation guards that reject bad input
 * BEFORE any query runs, so a canned `editablePhotoBook` lookup is all the fixture needed.
 */

vi.mock('@/lib/env', () => ({ env: {} }));

/** A drizzle query builder stub: every chained call returns itself, and awaiting it yields
 *  the one row `editablePhotoBook` selects. Built inside the factory because `vi.mock` is
 *  hoisted above every top-level binding in this file.
 *
 *  CAVEAT: it stubs READS only — there is no `update`/`insert`, so any code path that
 *  reaches a write throws here. That is the hard boundary on what this file can cover: the
 *  guards that reject bad input BEFORE the first write, and nothing past them. A test for
 *  what actually gets persisted needs a real (or far fuller) database double. */
vi.mock('@/db', () => {
  const queryBuilder: Record<string, unknown> = {};
  for (const method of ['select', 'from', 'where', 'limit', 'orderBy', 'innerJoin', 'leftJoin']) {
    queryBuilder[method] = () => queryBuilder;
  }
  queryBuilder.then = (resolve: (rows: unknown[]) => unknown) =>
    resolve([{ chronicleId: 'chronicle-1', layoutPlan: null, status: 'draft' }]);
  return { db: queryBuilder };
});

/** CAVEAT: this REPLACES the whole module, not just `getMembership`. If `lib/books.ts` ever
 *  imports anything else from `@/lib/chronicles`, that import lands as `undefined` and the
 *  failure shows up as a confusing "x is not a function" somewhere unrelated rather than as
 *  a missing mock — add the new export here when that happens. */
vi.mock('@/lib/chronicles', () => ({
  getMembership: async () => ({ chronicleId: 'chronicle-1', userId: 'user-1', accessRole: 'owner' }),
}));

import { setBirthdayCoverPhotos } from './books';
import { BIRTHDAY_COVER_PHOTO_MAX } from './photo-book-plan';

describe('setBirthdayCoverPhotos', () => {
  const call = (assetIds: string[]) =>
    setBirthdayCoverPhotos({ bookId: 'book-1', userId: 'user-1', assetIds });

  it('refuses a selection larger than the cover grid holds', async () => {
    const tooMany = Array.from({ length: BIRTHDAY_COVER_PHOTO_MAX + 1 }, (_, i) => `a${i}`);
    const result = await call(tooMany);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain(`at most ${BIRTHDAY_COVER_PHOTO_MAX} photos`);
  });

  it('counts DISTINCT photos, so a duplicated id does not eat a cover slot', async () => {
    // `assetIds` is de-duplicated before the cap is applied; 5 ids that are only 4 photos
    // must get past the guard (it fails later, on the book's real photo set, not here).
    const withDuplicate = [...Array.from({ length: BIRTHDAY_COVER_PHOTO_MAX }, (_, i) => `a${i}`), 'a0'];
    const result = await call(withDuplicate);
    expect(result.ok === false && result.error).toBe('Every cover photo must be included in this book.');
  });
});
