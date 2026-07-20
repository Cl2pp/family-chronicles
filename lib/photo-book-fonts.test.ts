import { describe, expect, it } from 'vitest';
import { PHOTO_BOOK_STYLES } from './photo-book-plan';
import { PHOTO_STYLE_FONTS, embeddedFontFaceCss, screenFontFaceCss } from './photo-book-fonts';

/**
 * Font parity checks (docs/PHOTO_BOOK_PLAN.md §7/§8): every style suite must resolve to
 * `@font-face` rules for both the live preview (`screen`, a `/fonts/*` URL — no I/O) and
 * the Chromium print render (`embedded`, a base64 `data:` URI read from the real files
 * checked into `public/fonts/`) — these tests read the actual files, so a missing/renamed
 * font file fails the suite here instead of surfacing as tofu in a print PDF later.
 */
describe('photo-book-fonts', () => {
  it('defines at least one font face for every style suite', () => {
    for (const style of PHOTO_BOOK_STYLES) {
      expect(PHOTO_STYLE_FONTS[style].length).toBeGreaterThan(0);
    }
  });

  it('screenFontFaceCss references a /fonts/ URL for every face, per style', () => {
    for (const style of PHOTO_BOOK_STYLES) {
      const css = screenFontFaceCss(style);
      for (const face of PHOTO_STYLE_FONTS[style]) {
        expect(css).toContain(`/fonts/${face.file}`);
        expect(css).toContain(`font-family: '${face.family}'`);
        expect(css).toContain(`font-weight: ${face.weight}`);
      }
    }
  });

  it('embeddedFontFaceCss inlines every face as a base64 woff2 data URI, per style', () => {
    for (const style of PHOTO_BOOK_STYLES) {
      const css = embeddedFontFaceCss(style);
      for (const face of PHOTO_STYLE_FONTS[style]) {
        expect(css).toContain(`font-family: '${face.family}'`);
        expect(css).toMatch(/data:font\/woff2;base64,[A-Za-z0-9+/]+=*/);
      }
      // Never falls back to referencing a network/public URL for the print path.
      expect(css).not.toContain('/fonts/');
      expect(css).not.toContain('https://');
    }
  });

  it('no two style suites use the exact same font-family pairing (visual distinctiveness)', () => {
    const pairings = PHOTO_BOOK_STYLES.map((style) =>
      PHOTO_STYLE_FONTS[style]
        .map((f) => f.family)
        .sort()
        .join('|'),
    );
    expect(new Set(pairings).size).toBe(pairings.length);
  });
});
