/**
 * Hand-built SVG illustrations for the marketing page. Static server-rendered
 * markup; colors reference Mantine theme CSS variables so they track the brand
 * palette (light-mode only app).
 */

/** Hero pipeline: a spoken/typed memory → AI shaping → a finished book. */
export function PipelineGraphic() {
  return (
    <svg
      viewBox="0 0 760 260"
      role="img"
      aria-label="A voice or text memory becomes a written story and then a printed book"
      style={{ width: '100%', height: 'auto', display: 'block' }}
    >
      <defs>
        <linearGradient id="pg-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--mantine-color-brand-0)" />
          <stop offset="1" stopColor="var(--mantine-color-slate-0)" />
        </linearGradient>
        <linearGradient id="pg-book" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--mantine-color-brand-5)" />
          <stop offset="1" stopColor="var(--mantine-color-brand-7)" />
        </linearGradient>
      </defs>

      <rect x="0" y="0" width="760" height="260" rx="20" fill="url(#pg-bg)" />

      {/* Stage 1 — input (voice + text) */}
      <g transform="translate(60 70)">
        <rect width="150" height="120" rx="16" fill="white" stroke="var(--mantine-color-slate-2)" />
        {/* speech bubble */}
        <rect x="22" y="26" width="106" height="42" rx="12" fill="var(--mantine-color-brand-1)" />
        <path d="M40 68 l0 14 l16 -14 Z" fill="var(--mantine-color-brand-1)" />
        {/* waveform */}
        <g stroke="var(--mantine-color-brand-6)" strokeWidth="3" strokeLinecap="round">
          <path d="M38 47 v-8" />
          <path d="M48 51 v-16" />
          <path d="M58 54 v-22" />
          <path d="M68 51 v-16" />
          <path d="M78 48 v-10" />
          <path d="M88 52 v-18" />
          <path d="M98 50 v-14" />
          <path d="M108 47 v-8" />
        </g>
        {/* text lines */}
        <g stroke="var(--mantine-color-slate-3)" strokeWidth="4" strokeLinecap="round">
          <path d="M26 88 h98" />
          <path d="M26 100 h74" />
        </g>
      </g>

      {/* Arrow 1 */}
      <Arrow x={218} />

      {/* Stage 2 — AI shaping */}
      <g transform="translate(305 70)">
        <rect width="150" height="120" rx="16" fill="white" stroke="var(--mantine-color-slate-2)" />
        <circle cx="75" cy="52" r="26" fill="var(--mantine-color-brand-0)" />
        <Sparkle x={75} y={52} s={1.15} />
        <Sparkle x={102} y={34} s={0.6} />
        <Sparkle x={49} y={70} s={0.55} />
        <g stroke="var(--mantine-color-slate-3)" strokeWidth="4" strokeLinecap="round">
          <path d="M30 96 h90" />
          <path d="M30 106 h64" />
        </g>
      </g>

      {/* Arrow 2 */}
      <Arrow x={463} />

      {/* Stage 3 — printed book */}
      <g transform="translate(550 62)">
        <rect x="8" y="8" width="150" height="136" rx="12" fill="var(--mantine-color-slate-2)" opacity="0.6" />
        <rect width="150" height="136" rx="12" fill="url(#pg-book)" />
        <rect x="16" y="16" width="118" height="104" rx="6" fill="white" opacity="0.14" />
        {/* little framed photo + lines on the cover */}
        <rect x="26" y="28" width="98" height="46" rx="4" fill="white" opacity="0.9" />
        <path d="M26 62 l22 -18 l16 12 l18 -14 l42 30 v6 H26 Z" fill="var(--mantine-color-brand-2)" />
        <circle cx="44" cy="40" r="6" fill="var(--mantine-color-brand-4)" />
        <g stroke="white" strokeWidth="4" strokeLinecap="round" opacity="0.9">
          <path d="M26 90 h98" />
          <path d="M26 102 h74" />
        </g>
        {/* spine */}
        <rect x="0" y="0" width="10" height="136" rx="4" fill="var(--mantine-color-brand-8)" />
      </g>
    </svg>
  );
}

function Arrow({ x }: { x: number }) {
  return (
    <g transform={`translate(${x} 130)`} stroke="var(--mantine-color-brand-5)" fill="none">
      <path d="M0 0 h56" strokeWidth="4" strokeLinecap="round" strokeDasharray="2 9" />
      <path d="M50 -7 l10 7 l-10 7" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}

function Sparkle({ x, y, s = 1 }: { x: number; y: number; s?: number }) {
  return (
    <path
      transform={`translate(${x} ${y}) scale(${s})`}
      d="M0 -16 C1.5 -6 6 -1.5 16 0 C6 1.5 1.5 6 0 16 C-1.5 6 -6 1.5 -16 0 C-6 -1.5 -1.5 -6 0 -16 Z"
      fill="var(--mantine-color-brand-6)"
    />
  );
}

/** Vertical timeline with dated story cards. */
export function TimelineGraphic() {
  const dots = [
    { y: 34, label: '1948', w: 118 },
    { y: 92, label: '1971', w: 96 },
    { y: 150, label: '1994', w: 130 },
    { y: 208, label: '2019', w: 104 },
  ];
  return (
    <svg viewBox="0 0 300 250" role="img" aria-label="A timeline of dated family stories" style={{ width: '100%', height: 'auto' }}>
      <path d="M40 20 V232" stroke="var(--mantine-color-slate-2)" strokeWidth="4" strokeLinecap="round" />
      {dots.map((d) => (
        <g key={d.label} transform={`translate(0 ${d.y})`}>
          <circle cx="40" cy="10" r="8" fill="var(--mantine-color-brand-6)" stroke="white" strokeWidth="3" />
          <rect x="64" y="-6" width={d.w + 60} height="34" rx="9" fill="white" stroke="var(--mantine-color-slate-2)" />
          <text x="78" y="16" fontSize="13" fontWeight="600" fill="var(--mantine-color-brand-7)" fontFamily="inherit">
            {d.label}
          </text>
          <rect x="118" y="4" width={d.w} height="5" rx="2.5" fill="var(--mantine-color-slate-3)" />
        </g>
      ))}
    </svg>
  );
}

/** Small family tree with connected people nodes. */
export function TreeGraphic() {
  return (
    <svg viewBox="0 0 300 250" role="img" aria-label="A family tree of connected people" style={{ width: '100%', height: 'auto' }}>
      <g stroke="var(--mantine-color-slate-3)" strokeWidth="3" fill="none">
        <path d="M110 52 H190 M150 52 V92" />
        <path d="M70 150 V120 H230 V150 M150 92 V120" />
      </g>
      <Node x={110} y={40} tone="6" />
      <Node x={190} y={40} tone="4" />
      <Node x={70} y={168} tone="5" />
      <Node x={150} y={168} tone="7" />
      <Node x={230} y={168} tone="4" />
      {/* family tag chips */}
      <Chip x={40} y={210} label="Müller" />
      <Chip x={128} y={210} label="Weber" />
      <Chip x={210} y={210} label="Ercan" />
    </svg>
  );
}

function Node({ x, y, tone }: { x: number; y: number; tone: string }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r="22" fill="white" stroke={`var(--mantine-color-brand-${tone})`} strokeWidth="3" />
      <circle cx="0" cy="-5" r="7" fill={`var(--mantine-color-brand-${tone})`} />
      <path d="M-12 14 a12 10 0 0 1 24 0" fill={`var(--mantine-color-brand-${tone})`} />
    </g>
  );
}

function Chip({ x, y, label }: { x: number; y: number; label: string }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width="62" height="26" rx="13" fill="var(--mantine-color-brand-1)" />
      <text x="31" y="17" fontSize="12" fontWeight="600" textAnchor="middle" fill="var(--mantine-color-brand-8)" fontFamily="inherit">
        {label}
      </text>
    </g>
  );
}

/** A hardcover book with a photo page — the printable output. */
export function BookGraphic() {
  return (
    <svg viewBox="0 0 300 250" role="img" aria-label="A printed hardcover family book" style={{ width: '100%', height: 'auto' }}>
      <defs>
        <linearGradient id="bg-cover" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--mantine-color-brand-5)" />
          <stop offset="1" stopColor="var(--mantine-color-brand-7)" />
        </linearGradient>
      </defs>
      {/* back cover */}
      <rect x="150" y="48" width="118" height="164" rx="8" fill="var(--mantine-color-brand-8)" />
      {/* left page */}
      <rect x="40" y="40" width="118" height="164" rx="8" fill="url(#bg-cover)" />
      <rect x="52" y="52" width="94" height="140" rx="5" fill="white" opacity="0.12" />
      {/* right page (open, showing content) */}
      <rect x="150" y="40" width="118" height="164" rx="8" fill="white" stroke="var(--mantine-color-slate-2)" />
      <rect x="164" y="56" width="90" height="52" rx="5" fill="var(--mantine-color-brand-1)" />
      <path d="M164 108 l24 -22 l17 14 l20 -16 l29 22 v2 H164 Z" fill="var(--mantine-color-brand-3)" />
      <circle cx="182" cy="72" r="7" fill="var(--mantine-color-brand-4)" />
      <g stroke="var(--mantine-color-slate-3)" strokeWidth="4" strokeLinecap="round">
        <path d="M164 126 h90" />
        <path d="M164 138 h90" />
        <path d="M164 150 h72" />
        <path d="M164 162 h84" />
        <path d="M164 174 h56" />
      </g>
      {/* spine highlight */}
      <rect x="148" y="40" width="4" height="164" fill="var(--mantine-color-brand-9)" opacity="0.5" />
    </svg>
  );
}

/* ── Small feature icons ─────────────────────────────────────────── */

function IconFrame({ children }: { children: React.ReactNode }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const MicIcon = () => (
  <IconFrame>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8" />
  </IconFrame>
);

export const TimelineIcon = () => (
  <IconFrame>
    <path d="M12 3v18" />
    <circle cx="12" cy="7" r="2.2" />
    <circle cx="12" cy="17" r="2.2" />
    <path d="M14 7h6M4 17h6" />
  </IconFrame>
);

export const TreeIcon = () => (
  <IconFrame>
    <circle cx="12" cy="5" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="18" r="2.5" />
    <path d="M12 7.5v3M12 10.5H6v5M12 10.5h6v5" />
  </IconFrame>
);

export const BookIcon = () => (
  <IconFrame>
    <path d="M4 5a2 2 0 0 1 2-2h8v16H6a2 2 0 0 0-2 2V5Z" />
    <path d="M14 3h4a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2h-4" />
  </IconFrame>
);

export const LockIcon = () => (
  <IconFrame>
    <rect x="4" y="10" width="16" height="10" rx="2.5" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </IconFrame>
);

export const QuoteIcon = () => (
  <IconFrame>
    <path d="M8 7c-2.5 0-4 2-4 4.5S5.5 16 8 16m0-9v9H4m14-9c-2.5 0-4 2-4 4.5S15.5 16 18 16m0-9v9h-4" />
  </IconFrame>
);
