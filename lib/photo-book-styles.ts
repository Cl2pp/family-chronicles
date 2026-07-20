import type { PhotoBookStyle } from '@/lib/photo-book-plan';
import { PHOTO_BOOK_STYLES } from '@/lib/photo-book-plan';

/**
 * Style suites (docs/PHOTO_BOOK_PLAN.md §7): a photo book's `style` id maps to a complete,
 * code-defined design — cover composition, typography, palette, page background, photo
 * treatment (mat/frame/radius/shadow), and divider design — expressed as a CSS-variables
 * map, exactly like `THEME_TOKENS` in `lib/book-layout.ts` for story books. Suites are
 * closed and code-defined: users pick a suite, never a font or a color.
 *
 * PR2 ships 3 of the eventual 6 (`PHOTO_BOOK_STYLES` in `lib/photo-book-plan.ts`):
 * `classic`, `modern`, `gallery`. `heirloom`, `bold`, `journal` land in PR5.
 *
 * Fonts: PR2 renders ONLY the `screen` (live-preview) variant — the Chromium print
 * render is PR5's `render-book` photo branch. Self-hosting webfonts (`public/fonts` +
 * `@font-face`, so the eventual print PDF never depends on a network font, matching the
 * plan's requirement) is deferred to that PR, when print/preview glyph parity actually
 * matters. For now every suite uses a robust system font stack — the same choice
 * `lib/book-layout.ts`'s `THEME_TOKENS` already makes for story books (Georgia /
 * system-ui, with the worker Docker image's `font-dejavu`/`font-noto` as the eventual
 * Chromium fallback) — so the preview renders correctly in any browser today without
 * shipping font files this PR never uses for print.
 */

export interface PhotoStyleTokens {
  id: PhotoBookStyle;
  /** Shown in the builder's style picker. */
  label: string;
  fontHeading: string;
  fontBody: string;
  colorText: string;
  colorMuted: string;
  /** Page background — most suites are a near-white paper tone; `gallery` is pure white. */
  pageBg: string;
  /** Front-cover background (behind/around the hero photo). */
  coverBg: string;
  coverHeadingColor: string;
  coverMutedColor: string;
  /** Back-cover background — PR2's auto-layouter never places photos there (see
   *  `lib/photo-book-autolayout.ts`), so this alone is the entire back-cover design. */
  coverBackBg: string;
  coverBackTextColor: string;
  /** Section-divider page background/text. */
  dividerBg: string;
  dividerTextColor: string;
  /** Photo treatment: a mat (white border) width in mm, 0 = no mat (`gallery`); corner
   *  radius; drop shadow; hairline frame border color, '' = none. */
  photoMatMm: number;
  photoRadius: string;
  photoShadow: string;
  photoFrameBorder: string;
  captionColor: string;
}

export const PHOTO_STYLE_TOKENS: Record<PhotoBookStyle, PhotoStyleTokens> = {
  classic: {
    id: 'classic',
    label: 'Classic',
    fontHeading: "Georgia, 'Noto Serif', 'DejaVu Serif', serif",
    fontBody: "Georgia, 'Noto Serif', 'DejaVu Serif', serif",
    colorText: '#1e2430',
    colorMuted: '#5a6372',
    pageBg: '#faf8f4',
    coverBg: '#f4efe6',
    coverHeadingColor: '#1a1712',
    coverMutedColor: '#8d8471',
    coverBackBg: '#f4efe6',
    coverBackTextColor: '#8d8471',
    dividerBg: '#f4efe6',
    dividerTextColor: '#1a1712',
    photoMatMm: 3,
    photoRadius: '1mm',
    photoShadow: '0 3mm 8mm rgba(20, 20, 20, 0.15)',
    photoFrameBorder: 'rgba(30, 36, 48, 0.14)',
    captionColor: '#5a6372',
  },
  modern: {
    id: 'modern',
    label: 'Modern',
    fontHeading: "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif",
    fontBody: "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif",
    colorText: '#1c1c1e',
    colorMuted: '#6b6f76',
    pageBg: '#ffffff',
    coverBg: '#f6f5f1',
    coverHeadingColor: '#141414',
    coverMutedColor: '#7a7d84',
    coverBackBg: '#141414',
    coverBackTextColor: '#f6f5f1',
    dividerBg: '#141414',
    dividerTextColor: '#ffffff',
    photoMatMm: 0,
    photoRadius: '0mm',
    photoShadow: 'none',
    photoFrameBorder: '',
    captionColor: '#6b6f76',
  },
  gallery: {
    id: 'gallery',
    label: 'Gallery',
    fontHeading: "'Helvetica Neue', Helvetica, Arial, sans-serif",
    fontBody: "'Helvetica Neue', Helvetica, Arial, sans-serif",
    colorText: '#111111',
    colorMuted: '#767676',
    pageBg: '#ffffff',
    coverBg: '#ffffff',
    coverHeadingColor: '#111111',
    coverMutedColor: '#767676',
    coverBackBg: '#ffffff',
    coverBackTextColor: '#767676',
    dividerBg: '#ffffff',
    dividerTextColor: '#111111',
    photoMatMm: 0,
    photoRadius: '0mm',
    photoShadow: 'none',
    photoFrameBorder: '',
    captionColor: '#767676',
  },
};

/** Style swatches for the builder's picker (`photo-book-builder.tsx`). */
export const PHOTO_STYLE_LIST: PhotoStyleTokens[] = PHOTO_BOOK_STYLES.map((id) => PHOTO_STYLE_TOKENS[id]);
