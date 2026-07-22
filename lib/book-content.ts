import sharp from 'sharp';

/**
 * Shared, content-agnostic book helpers: the trim sizes every renderer measures against,
 * and the small pure functions that turn story rows into printable shape. The loaders
 * and plan resolution that used to live here belonged to the retired story engine and
 * went with it — `lib/photo-book-content.ts` is the one loader now.
 */

/** Trim size in millimetres per book format. */
export const TRIM: Record<string, { w: number; h: number }> = {
  'hardcover-21x28': { w: 210, h: 280 },
  'hardcover-20x20': { w: 200, h: 200 },
};

export function eventLabel(date: Date | null, precision: string | null): string | null {
  if (!date) return null;
  const year = date.getUTCFullYear();
  if (precision === 'circa') return `ca. ${year}`;
  return String(year);
}

export function paragraphs(body: string): string[] {
  return body
    .split(/\n{2,}|\r\n{2,}/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
}

export function wordCount(paragraph: string): number {
  return paragraph.split(/\s+/).filter(Boolean).length;
}

/** A photo's pixel dimensions with EXIF orientation applied — a portrait shot stored
 *  landscape-with-a-rotation-tag must measure as portrait, or every layout decision made
 *  from its aspect ratio is wrong. */
export async function orientedDimensions(
  buffer: Buffer,
): Promise<{ width: number; height: number } | null> {
  const meta = await sharp(buffer, { failOn: 'none' }).metadata();
  if (!meta.width || !meta.height) return null;
  const swapped = meta.orientation != null && meta.orientation >= 5 && meta.orientation <= 8;
  return swapped ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height };
}
