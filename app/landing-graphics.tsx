/**
 * Static brand illustrations for the landing page — pure SVG, no client JS.
 * The logo mark is "Familienstimmen": three people drawn as voice bars, the
 * youngest rendered in the accent green.
 */

type GlyphVariant = 'ink' | 'onDark' | 'onGreen';

const GLYPH_COLORS: Record<GlyphVariant, { c1: string; c2: string; o2: number; c3: string }> = {
  ink: { c1: '#17211C', c2: '#17211C', o2: 0.6, c3: '#12C24A' },
  onDark: { c1: '#FFFFFF', c2: '#FFFFFF', o2: 0.65, c3: '#7BE84B' },
  onGreen: { c1: '#FFFFFF', c2: '#FFFFFF', o2: 0.75, c3: '#0C8038' },
};

/** The Familienwerk mark — three "voices" as head + body bars. */
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

const G = '#12C24A';

export function IconSpeak() {
  return (
    <svg width="30" height="30" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <rect x="16" y="26" width="6" height="12" rx="3" fill={G} />
      <rect x="29" y="16" width="6" height="32" rx="3" fill={G} />
      <rect x="42" y="22" width="6" height="20" rx="3" fill={G} />
    </svg>
  );
}

export function IconMemoir() {
  return (
    <svg width="30" height="30" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <rect x="14" y="14" width="36" height="8" rx="4" fill={G} />
      <rect x="14" y="28" width="28" height="8" rx="4" fill="#17211C" opacity="0.55" />
      <rect x="14" y="42" width="20" height="8" rx="4" fill="#17211C" opacity="0.3" />
    </svg>
  );
}

export function IconPhotos() {
  return (
    <svg width="30" height="30" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <rect x="10" y="12" width="26" height="26" rx="6" fill="#17211C" opacity="0.5" />
      <rect x="24" y="24" width="30" height="28" rx="6" fill={G} />
    </svg>
  );
}

export function IconChat() {
  return (
    <svg width="30" height="30" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <path
        d="M14 20 a8 8 0 0 1 8-8 h20 a8 8 0 0 1 8 8 v12 a8 8 0 0 1-8 8 H30 L18 50 q-4 3-4-2 Z"
        fill={G}
      />
      <rect x="21" y="18" width="20" height="5" rx="2.5" fill="#fff" />
      <rect x="21" y="27" width="13" height="5" rx="2.5" fill="#fff" opacity="0.75" />
    </svg>
  );
}

/** A single person node for the family-tree illustration. */
export function PersonGlyph({ size = 28, color = G }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8.5" r="4" fill={color} />
      <path d="M4 21 a8 8 0 0 1 16 0 Z" fill={color} />
    </svg>
  );
}

/**
 * Hero illustration: a spoken note → AI shaping → a printed book, as one
 * responsive SVG (scales cleanly from phone to desktop).
 */
export function HeroArt() {
  return (
    <svg
      viewBox="0 0 468 150"
      width="100%"
      style={{ maxWidth: 520, height: 'auto', display: 'block', margin: '0 auto' }}
      role="img"
      aria-label="A spoken note becomes a story and then a printed book"
    >
      <defs>
        <filter id="fwCardShadow" x="-20%" y="-20%" width="140%" height="160%">
          <feDropShadow dx="0" dy="4" stdDeviation="6" floodColor="#17211C" floodOpacity="0.08" />
        </filter>
        <filter id="fwBookShadow" x="-30%" y="-20%" width="170%" height="160%">
          <feDropShadow dx="0" dy="8" stdDeviation="7" floodColor="#0C8038" floodOpacity="0.25" />
        </filter>
      </defs>

      {/* Note card */}
      <g filter="url(#fwCardShadow)">
        <rect x="6" y="22" width="118" height="106" rx="14" fill="#fff" />
      </g>
      <g transform="translate(21 36)">
        <rect x="2" y="2" width="80" height="40" rx="12" fill="#E9FAE5" />
        <path d="M14 40 L14 53 L29 40 Z" fill="#E9FAE5" />
        <rect x="16" y="17" width="4" height="10" rx="2" fill={G} />
        <rect x="24" y="13" width="4" height="18" rx="2" fill={G} />
        <rect x="32" y="9" width="4" height="26" rx="2" fill={G} />
        <rect x="40" y="15" width="4" height="14" rx="2" fill={G} />
        <rect x="48" y="11" width="4" height="22" rx="2" fill={G} />
        <rect x="56" y="17" width="4" height="10" rx="2" fill={G} />
        <rect x="64" y="14" width="4" height="16" rx="2" fill={G} />
      </g>
      <rect x="24" y="100" width="76" height="6" rx="3" fill="#E3E8E4" />
      <rect x="24" y="110" width="52" height="6" rx="3" fill="#EDF1EE" />

      {/* Arrow 1 */}
      <g transform="translate(132 68)">
        <circle cx="4" cy="7" r="2.5" fill={G} />
        <circle cx="14" cy="7" r="2.5" fill={G} />
        <circle cx="24" cy="7" r="2.5" fill={G} />
        <path d="M33 1 L40 7 L33 13" fill="none" stroke={G} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      </g>

      {/* AI / sparkle card */}
      <g filter="url(#fwCardShadow)">
        <rect x="188" y="18" width="100" height="114" rx="14" fill="#fff" />
      </g>
      <g transform="translate(207 30)">
        <circle cx="32" cy="30" r="21" fill="#E9FAE5" />
        <path d="M32 12 L36.5 25.5 L50 30 L36.5 34.5 L32 48 L27.5 34.5 L14 30 L27.5 25.5 Z" fill={G} />
        <path d="M49 9 L51 15 L57 17 L51 19 L49 25 L47 19 L41 17 L47 15 Z" fill={G} opacity="0.55" />
      </g>
      <rect x="206" y="102" width="66" height="6" rx="3" fill="#E3E8E4" />
      <rect x="206" y="112" width="44" height="6" rx="3" fill="#EDF1EE" />

      {/* Arrow 2 */}
      <g transform="translate(296 68)">
        <circle cx="4" cy="7" r="2.5" fill={G} />
        <circle cx="14" cy="7" r="2.5" fill={G} />
        <circle cx="24" cy="7" r="2.5" fill={G} />
        <path d="M33 1 L40 7 L33 13" fill="none" stroke={G} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      </g>

      {/* Book */}
      <g transform="translate(352 26) scale(1.08)" filter="url(#fwBookShadow)">
        <rect x="10" y="4" width="78" height="78" rx="8" fill={G} />
        <rect x="10" y="4" width="9" height="78" rx="4.5" fill="#0C8038" />
        <rect x="28" y="15" width="52" height="35" rx="6" fill="#fff" opacity="0.95" />
        <circle cx="39" cy="26" r="4.5" fill="#7BE84B" />
        <path d="M32 46 L45 33 L54 41 L63 31 L76 46 Z" fill="#A9EE93" />
        <rect x="28" y="58" width="52" height="5" rx="2.5" fill="#fff" opacity="0.95" />
        <rect x="28" y="68" width="36" height="5" rx="2.5" fill="#fff" opacity="0.6" />
      </g>
    </svg>
  );
}
