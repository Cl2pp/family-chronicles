import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PhotoBookStyle } from '@/lib/photo-book-plan';

/**
 * Self-hosted webfonts for the photo-book style suites (docs/PHOTO_BOOK_PLAN.md §7/§8):
 * every suite gets a distinct, open-licensed (SIL OFL 1.1) typeface pairing so the live
 * builder preview (browser, `screen` variant) and the Chromium print render (worker,
 * `preview`/`print` PDF variants) show IDENTICAL glyphs — no dependency on whatever fonts
 * happen to be installed on the viewer's OS or in the worker's Docker image.
 *
 * Font choice + acquisition: all 8 families below are Google Fonts, fetched as static
 * woff2 instances (Latin/Latin-1 subset — covers English and German, incl. ä/ö/ü/ß) via
 * Google's `fonts.googleapis.com/css2` endpoint and vendored under `public/fonts/`
 * (license text + per-file attribution: `public/fonts/LICENSE.txt`). Each suite pairs a
 * heading face with a body face (sometimes the same family at two weights, sometimes two
 * different families for more contrast):
 *
 *   classic   — Playfair Display 700 (headings) / 400 (body) — refined editorial serif
 *   modern    — Inter 700 / 400 — clean geometric sans
 *   gallery   — Work Sans 600 / 400 — minimal, airy sans; photos do the talking
 *   heirloom  — Cormorant Garamond 600 / 400 — delicate old-world serif
 *   bold      — Archivo Black 400 (headings) / Archivo 400 (body) — heavy display face
 *               paired with its own humanist sans for body text
 *   journal   — Caveat 700 (headings, handwritten) / Courier Prime 400 (body, typewriter)
 *
 * Two consumers, one source of truth (`PHOTO_STYLE_FONTS` below):
 *  - `screenFontFaceCss` (pure, no I/O): emits `@font-face` rules pointing at
 *    `/fonts/<file>` — Next.js serves `public/` as static files, so the browser fetches
 *    them same-origin. Used by the `screen` variant (the live builder preview).
 *  - `embeddedFontFaceCss` (impure — reads local files, memoized): emits `@font-face`
 *    rules with the font bytes inlined as base64 `data:` URIs. Used by the `preview`/
 *    `print` PDF variants: the worker's Chromium instance renders fully offline (same
 *    reasoning as embedding photos as data URIs in `lib/book-render.ts` — it can't reach
 *    the web process's `/fonts/*` route from inside the render), so the PDF must carry
 *    its own font bytes exactly like it carries its own photo bytes.
 */

export interface PhotoBookFontFace {
  family: string;
  weight: number;
  style?: 'normal' | 'italic';
  /** Filename under public/fonts/. */
  file: string;
}

export const PHOTO_STYLE_FONTS: Record<PhotoBookStyle, PhotoBookFontFace[]> = {
  classic: [
    { family: 'Playfair Display', weight: 400, file: 'playfair-display-400.woff2' },
    { family: 'Playfair Display', weight: 700, file: 'playfair-display-700.woff2' },
  ],
  modern: [
    { family: 'Inter', weight: 400, file: 'inter-400.woff2' },
    { family: 'Inter', weight: 700, file: 'inter-700.woff2' },
  ],
  gallery: [
    { family: 'Work Sans', weight: 400, file: 'work-sans-400.woff2' },
    { family: 'Work Sans', weight: 600, file: 'work-sans-600.woff2' },
  ],
  heirloom: [
    { family: 'Cormorant Garamond', weight: 400, file: 'cormorant-garamond-400.woff2' },
    { family: 'Cormorant Garamond', weight: 600, file: 'cormorant-garamond-600.woff2' },
  ],
  bold: [
    { family: 'Archivo Black', weight: 400, file: 'archivo-black-400.woff2' },
    { family: 'Archivo', weight: 400, file: 'archivo-400.woff2' },
  ],
  journal: [
    { family: 'Caveat', weight: 700, file: 'caveat-700.woff2' },
    { family: 'Courier Prime', weight: 400, file: 'courier-prime-400.woff2' },
  ],
};

function fontFaceRule(f: PhotoBookFontFace, src: string): string {
  return `@font-face { font-family: '${f.family}'; font-weight: ${f.weight}; font-style: ${f.style ?? 'normal'}; font-display: swap; src: url(${src}) format('woff2'); }`;
}

/** Pure — builds `@font-face` rules that point at the static `/fonts/<file>` URL. No disk
 *  or network I/O here (that's the browser's job once it renders the HTML), so this is
 *  safe to call on every preview request and from unit tests alike. */
export function screenFontFaceCss(style: PhotoBookStyle): string {
  return PHOTO_STYLE_FONTS[style].map((f) => fontFaceRule(f, `/fonts/${f.file}`)).join('\n');
}

/** Module-level cache: the font files never change at runtime, so a worker process
 *  handling many render jobs (or a batch of books) only pays the disk read + base64
 *  encode once per file, not once per render. */
const dataUriCache = new Map<string, string>();

function fontDataUri(file: string): string {
  let uri = dataUriCache.get(file);
  if (!uri) {
    const bytes = readFileSync(join(process.cwd(), 'public', 'fonts', file));
    uri = `data:font/woff2;base64,${bytes.toString('base64')}`;
    dataUriCache.set(file, uri);
  }
  return uri;
}

/** Impure (reads `public/fonts/*.woff2` off disk) — builds `@font-face` rules with the
 *  font bytes embedded as base64 `data:` URIs, for the PDF variants Chromium renders
 *  offline in the worker (`preview` and `print`, see `lib/book-render.ts`'s photo-book
 *  render path). Throws if a suite's font files aren't present — that's a deploy-time bug
 *  (missing `public/fonts/*`), not a runtime condition to silently degrade from: better a
 *  loud render failure than a print PDF quietly falling back to tofu/system fonts. */
export function embeddedFontFaceCss(style: PhotoBookStyle): string {
  return PHOTO_STYLE_FONTS[style].map((f) => fontFaceRule(f, fontDataUri(f.file))).join('\n');
}
