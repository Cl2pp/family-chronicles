/**
 * Shared between `app/api/pagedjs-polyfill/route.ts` (serves the file) and the
 * `screen` variant of `lib/book-layout.ts` (references the URL). The version
 * string is only a cache-buster query param — bump it whenever the `pagedjs`
 * dependency in package.json is upgraded. It can't be read from
 * `pagedjs/package.json` at build time: that package's `exports` map doesn't
 * expose `./package.json`, so a static import of it fails module resolution.
 */
export const PAGEDJS_VERSION = '0.4.3';

export const PAGEDJS_POLYFILL_URL = `/api/pagedjs-polyfill?v=${PAGEDJS_VERSION}`;
