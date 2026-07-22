import type { PhotoBookStyle } from '@/lib/photo-book-plan';
import { PHOTO_BOOK_STYLES } from '@/lib/photo-book-plan';

/**
 * Style suites (docs/PHOTO_BOOK_PLAN.md §7): a photo book's `style` id maps to a complete,
 * code-defined design — cover composition, typography, palette, page background, photo
 * treatment (mat/frame/radius/shadow), and divider design — expressed as a CSS-variables
 * map, exactly like `THEME_TOKENS` in `lib/book-layout.ts` for story books. Suites are
 * closed and code-defined: users pick a suite, never a font or a color.
 *
 * All 6 (`PHOTO_BOOK_STYLES` in `lib/photo-book-plan.ts`): `classic`, `modern`, `gallery`
 * (PR2) plus `heirloom`, `bold`, `journal` (PR5).
 *
 * Fonts (PR5, docs/PHOTO_BOOK_PLAN.md §7/§8): every suite now pairs a self-hosted,
 * SIL-OFL-licensed heading/body typeface (`lib/photo-book-fonts.ts`'s `PHOTO_STYLE_FONTS`,
 * files under `public/fonts/`) instead of PR2's system-font stacks — the Chromium print
 * render has no network access, and the live preview must show the identical glyphs the
 * PDF will, so `fontHeading`/`fontBody` below name the self-hosted family FIRST, with the
 * same system-font stack PR2 used as a defensive fallback (covers the sliver of time
 * before a browser's `@font-face` request resolves, and keeps this file's values legible
 * even if `public/fonts/` were ever misconfigured).
 *
 * Photo treatment extras (`dividerOrnament`, `photoTape`/`photoTapeColor`) are optional,
 * CSS-variable-driven flourishes a suite can opt into — see their use in
 * `lib/photo-book-layout.ts` (`.pb-divider h2::before/::after`, `.ph-frame::before`) —
 * rather than new per-suite markup, so the shared renderer stays the same for every suite.
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
  /** ── Flowing story text (unified-book plan) — every suite typesets chapters: ── */
  /** Body font size of flowed text, e.g. '10.5pt'. */
  bodySize: string;
  bodyLineHeight: string;
  /** Vertical gap between paragraphs (mm value with unit). */
  paragraphGap: string;
  /** First-letter scale of a section's opening paragraph; 1 = no drop cap. */
  dropCapScale: number;
  /** Justified + hyphenated (serif suites) vs. left-ragged (sans/typewriter suites). */
  bodyJustify: boolean;
  /** Running page number on TEXT pages ('center' = @bottom-center margin box; 'none' =
   *  no folio). Photo pages are numberless by construction — the default page has no
   *  margins, hence no margin boxes. Structural, not a CSS variable (it decides whether
   *  the margin-box rule is emitted at all). */
  pageNumberStyle: 'center' | 'none';
  /** Decorative flourish above/below a section divider's title (heirloom's "ornamental
   *  dividers", docs/PHOTO_BOOK_PLAN.md §7) — a plain hairline rule drawn by
   *  `.pb-divider h2::before/::after` in `lib/photo-book-layout.ts`, shown only when true.
   *  Optional/undefined = off, so PR2's 3 suites don't need to opt out explicitly. */
  dividerOrnament?: boolean;
  /** A small washi-tape accent across the top of matted/framed photos (journal's
   *  "taped-photo mats") — `.ph-frame::before` in `lib/photo-book-layout.ts`, shown only
   *  when true, colored by `photoTapeColor`. */
  photoTape?: boolean;
  photoTapeColor?: string;
}

export const PHOTO_STYLE_TOKENS: Record<PhotoBookStyle, PhotoStyleTokens> = {
  classic: {
    id: 'classic',
    label: 'Classic',
    fontHeading: "'Playfair Display', Georgia, 'Noto Serif', 'DejaVu Serif', serif",
    fontBody: "'Playfair Display', Georgia, 'Noto Serif', 'DejaVu Serif', serif",
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
    bodySize: '10.5pt',
    bodyLineHeight: '1.55',
    paragraphGap: '3.2mm',
    dropCapScale: 1.6,
    bodyJustify: true,
    pageNumberStyle: 'center',
  },
  modern: {
    id: 'modern',
    label: 'Modern',
    fontHeading:
      "'Inter', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif",
    fontBody: "'Inter', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif",
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
    bodySize: '10pt',
    bodyLineHeight: '1.6',
    paragraphGap: '4.2mm',
    dropCapScale: 1,
    bodyJustify: false,
    pageNumberStyle: 'center',
  },
  gallery: {
    id: 'gallery',
    label: 'Gallery',
    fontHeading: "'Work Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif",
    fontBody: "'Work Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif",
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
    bodySize: '9.5pt',
    bodyLineHeight: '1.6',
    paragraphGap: '4mm',
    dropCapScale: 1,
    bodyJustify: false,
    pageNumberStyle: 'none',
  },
  heirloom: {
    id: 'heirloom',
    label: 'Heirloom',
    fontHeading: "'Cormorant Garamond', Georgia, 'Noto Serif', serif",
    fontBody: "'Cormorant Garamond', Georgia, 'Noto Serif', serif",
    colorText: '#2b2116',
    colorMuted: '#8a7a5c',
    pageBg: '#f7f1e3',
    coverBg: '#f0e6cf',
    coverHeadingColor: '#2b2116',
    coverMutedColor: '#8a7a5c',
    coverBackBg: '#f0e6cf',
    coverBackTextColor: '#8a7a5c',
    dividerBg: '#f0e6cf',
    dividerTextColor: '#2b2116',
    photoMatMm: 6,
    photoRadius: '0mm',
    photoShadow: '0 2mm 6mm rgba(60, 45, 20, 0.18)',
    photoFrameBorder: 'rgba(140, 120, 80, 0.35)',
    captionColor: '#8a7a5c',
    bodySize: '11pt',
    bodyLineHeight: '1.6',
    paragraphGap: '3.5mm',
    dropCapScale: 1.8,
    bodyJustify: true,
    pageNumberStyle: 'center',
    dividerOrnament: true,
  },
  bold: {
    id: 'bold',
    label: 'Bold',
    fontHeading: "'Archivo Black', Arial, sans-serif",
    fontBody: "'Archivo', Arial, sans-serif",
    colorText: '#f5f5f5',
    colorMuted: '#b8b8b8',
    pageBg: '#111111',
    coverBg: '#000000',
    coverHeadingColor: '#ffffff',
    coverMutedColor: '#c9c9c9',
    coverBackBg: '#000000',
    coverBackTextColor: '#c9c9c9',
    dividerBg: '#000000',
    dividerTextColor: '#ffffff',
    photoMatMm: 0,
    photoRadius: '0mm',
    photoShadow: 'none',
    photoFrameBorder: '',
    captionColor: '#b8b8b8',
    bodySize: '10pt',
    bodyLineHeight: '1.55',
    paragraphGap: '4mm',
    dropCapScale: 1,
    bodyJustify: false,
    pageNumberStyle: 'center',
  },
  journal: {
    id: 'journal',
    label: 'Journal',
    fontHeading: "'Caveat', cursive",
    fontBody: "'Courier Prime', 'Courier New', monospace",
    colorText: '#3a2f22',
    colorMuted: '#8a7c68',
    pageBg: '#f4ecd8',
    coverBg: '#e8dcb8',
    coverHeadingColor: '#3a2f22',
    coverMutedColor: '#8a7c68',
    coverBackBg: '#e8dcb8',
    coverBackTextColor: '#8a7c68',
    dividerBg: '#e8dcb8',
    dividerTextColor: '#3a2f22',
    photoMatMm: 4,
    photoRadius: '0mm',
    photoShadow: '0 2mm 5mm rgba(40, 30, 15, 0.25)',
    photoFrameBorder: 'rgba(80, 60, 30, 0.25)',
    captionColor: '#8a7c68',
    bodySize: '10pt',
    bodyLineHeight: '1.5',
    paragraphGap: '4mm',
    dropCapScale: 1,
    bodyJustify: false,
    pageNumberStyle: 'none',
    photoTape: true,
    photoTapeColor: 'rgba(214, 188, 133, 0.75)',
  },
};

/** Style swatches for the builder's picker (`photo-book-builder.tsx`). */
export const PHOTO_STYLE_LIST: PhotoStyleTokens[] = PHOTO_BOOK_STYLES.map((id) => PHOTO_STYLE_TOKENS[id]);
