import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextResponse } from 'next/server';

/**
 * Self-hosts the Paged.js polyfill (no CDN — the app is a PWA and must work
 * without third-party origins in its CSP). Read once per server process and
 * cached in memory; the response itself carries a long-lived, immutable cache
 * header because the URL is version-pinned (see lib/pagedjs.ts) — a `pagedjs`
 * upgrade changes the query string, not the file at this path, so browsers
 * never need to revalidate.
 *
 * Located via a plain filesystem path rather than `require.resolve`/`import`:
 * `pagedjs`'s package.json `exports` field only defines the package root (as
 * import-condition aliases, not subpaths), so `pagedjs/dist/...` is not a
 * resolvable specifier — Node and Turbopack both reject it. The file
 * genuinely exists on disk at this path once `npm install` has run, since
 * this app is never deployed with `output: 'standalone'` (the whole
 * repo — node_modules included — ships as-is, see Dockerfile).
 */

const POLYFILL_PATH = join(process.cwd(), 'node_modules/pagedjs/dist/paged.polyfill.min.js');

let cached: Buffer | null = null;

export async function GET() {
  if (!cached) {
    cached = await readFile(POLYFILL_PATH);
  }
  return new NextResponse(new Uint8Array(cached), {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
