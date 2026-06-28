import type { DatePrecision } from '@/lib/stories';

/** Human label for a fuzzy event date, e.g. "1998", "March 1998", "12 March 1998". */
export function formatEventDate(
  date: Date | string | null | undefined,
  precision: DatePrecision | null | undefined,
): string | null {
  if (!date || !precision) return null;
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return null;

  switch (precision) {
    case 'year':
      return new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'UTC' }).format(d);
    case 'circa':
      return `around ${new Intl.DateTimeFormat('en', {
        year: 'numeric',
        timeZone: 'UTC',
      }).format(d)}`;
    case 'month':
      return new Intl.DateTimeFormat('en', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(d);
    case 'day':
      return new Intl.DateTimeFormat('en', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(d);
    default:
      return null;
  }
}
