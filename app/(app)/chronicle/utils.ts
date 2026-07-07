/** UTC year of a date-ish value, or null. */
export function yearOf(d: Date | string | null | undefined): number | null {
  if (!d) return null;
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return null;
  return date.getUTCFullYear();
}

/** "1948–2019", "1948–", "–2019", or "". */
export function lifeSpan(bornOn: Date | string | null, diedOn: Date | string | null): string {
  const born = yearOf(bornOn);
  const died = yearOf(diedOn);
  if (born && died) return `${born}–${died}`;
  if (born) return `${born}–`;
  if (died) return `–${died}`;
  return '';
}

/** Up-to-two-letter initials for an avatar fallback. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
