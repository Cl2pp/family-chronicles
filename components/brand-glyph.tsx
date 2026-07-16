/**
 * Familienwerk brand mark — three "voices" drawn as head + body bars, the
 * youngest in the accent green. Pure SVG, no client JS. Shared by the landing
 * page and the in-app chrome, so it lives in components/ rather than a route.
 */

type GlyphVariant = 'ink' | 'onDark' | 'onGreen';

const GLYPH_COLORS: Record<GlyphVariant, { c1: string; c2: string; o2: number; c3: string }> = {
  ink: { c1: '#17211C', c2: '#17211C', o2: 0.6, c3: '#12C24A' },
  onDark: { c1: '#FFFFFF', c2: '#FFFFFF', o2: 0.65, c3: '#7BE84B' },
  onGreen: { c1: '#FFFFFF', c2: '#FFFFFF', o2: 0.75, c3: '#0C8038' },
};

/** The Familienwerk logo mark. */
export function BrandGlyph({ size = 26, variant = 'ink' }: { size?: number; variant?: GlyphVariant }) {
  const { c1, c2, o2, c3 } = GLYPH_COLORS[variant];
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <circle cx="18" cy="13" r="5.5" fill={c1} />
      <rect x="13" y="22" width="10" height="28" rx="5" fill={c1} />
      <circle cx="32" cy="19" r="5.5" fill={c2} opacity={o2} />
      <rect x="27" y="28" width="10" height="22" rx="5" fill={c2} opacity={o2} />
      <circle cx="46" cy="27" r="5.5" fill={c3} />
      <rect x="41" y="36" width="10" height="14" rx="5" fill={c3} />
    </svg>
  );
}

/** Three voice bars — the "record / speak" glyph. */
export function MicGlyph({ size = 16, color = '#fff' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <rect x="16" y="26" width="6" height="12" rx="3" fill={color} />
      <rect x="29" y="18" width="6" height="28" rx="3" fill={color} />
      <rect x="42" y="23" width="6" height="18" rx="3" fill={color} />
    </svg>
  );
}

/** A single person node for the family-tree illustration. */
export function PersonGlyph({ size = 28, color = '#12C24A' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8.5" r="4" fill={color} />
      <path d="M4 21 a8 8 0 0 1 16 0 Z" fill={color} />
    </svg>
  );
}
