import sharp, { type Sharp } from 'sharp';
import decodeHeic from 'heic-decode';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { buildKey, getObjectBuffer, putObjectBuffer } from '@/lib/s3';

/**
 * Longest edge of a generated thumbnail. Banners and gallery tiles render at
 * ≤ ~320 CSS px, so 640 covers 2× displays without shipping camera originals.
 */
const THUMB_MAX_EDGE = 640;

/**
 * HEIC/HEIF thumbnails are made bigger: only Safari can display the original,
 * so for every other browser the thumbnail IS the lightbox image too.
 */
const HEIC_MAX_EDGE = 1600;

/**
 * Longest edge of a photo book's "display" rendition (docs/PHOTO_BOOK_PLAN.md §8) — the
 * live preview's `full-bleed`/`full-framed`/`divider` slots need more than 640px on a
 * laptop screen; multi-photo grids still use the 640px thumbnail. Same size as
 * `HEIC_MAX_EDGE` (not a coincidence: it's "the size HEIC thumbs already use", per the
 * plan) but a distinct constant/column because it applies to every format, not just HEIC,
 * and only to book-owned photos.
 */
const DISPLAY_MAX_EDGE = 1600;

/** iPhone camera formats — sharp's prebuilt libvips has no HEVC codec for these. */
const HEIC_TYPES = new Set(['image/heic', 'image/heif']);

/**
 * Downscale one stored photo into a WebP thumbnail for grids and banners (every photo),
 * and — for photos owned by a photo book (`assets.book_id` set) — an additional ~1600px
 * "display" rendition for the live preview's full-page slots. Records whichever it
 * generates on the asset row that references the original object.
 *
 * The full-size original stays untouched (raw inputs are kept forever) — the lightbox
 * still loads it; only list/grid views (and, for photo books, the full-page preview
 * slots) switch to a downscaled rendition.
 *
 * HEIC/HEIF (iPhone camera originals) can't be decoded by sharp's prebuilt binaries, so
 * they go through libheif's WASM decoder first — which also makes these photos visible
 * in Chrome/Firefox at all (they can't render HEIC). Decoded once and reused for both
 * renditions (mirrors `decodeForAnalysis` in `lib/photo-hash.ts`), since re-decoding a
 * HEIC original a second time is the expensive step here.
 *
 * Idempotent per rendition: a rendition whose column is already set is skipped, so
 * pg-boss retries — and a book photo that already has a thumbnail from before this
 * function generated display renditions — are harmless; each missing rendition is
 * backfilled independently. Returns `'skipped'` only when NEITHER rendition was needed.
 * A photo that can't be decoded at all is skipped entirely; the UI falls back to the
 * original, as before.
 */
export async function generateThumbnail(s3Key: string): Promise<'done' | 'skipped'> {
  const [asset] = await db
    .select({
      kind: assets.kind,
      thumbS3Key: assets.thumbS3Key,
      displayS3Key: assets.displayS3Key,
      mimeType: assets.mimeType,
      bookId: assets.bookId,
    })
    .from(assets)
    .where(eq(assets.s3Key, s3Key))
    .limit(1);
  if (!asset || asset.kind !== 'photo') return 'skipped';

  const needsThumb = !asset.thumbS3Key;
  const needsDisplay = asset.bookId != null && !asset.displayS3Key;
  if (!needsThumb && !needsDisplay) return 'skipped';

  const original = await getObjectBuffer(s3Key);
  const isHeic = HEIC_TYPES.has(asset.mimeType.split(';')[0].trim().toLowerCase());
  let decoded: Sharp;
  try {
    // libheif applies the HEIC container's rotation itself; EXIF-carrying
    // formats (JPEG) need sharp's .rotate() to bake the orientation in.
    decoded = isHeic
      ? await (async () => {
          const { width, height, data } = await decodeHeic({ buffer: original });
          return sharp(Buffer.from(data), { raw: { width, height, channels: 4 } });
        })()
      : sharp(original).rotate();
  } catch (err) {
    console.error(`[thumbnail] cannot decode ${s3Key}, keeping original only:`, err);
    return 'skipped';
  }

  const set: Partial<typeof assets.$inferInsert> = {};

  if (needsThumb) {
    const maxEdge = isHeic ? HEIC_MAX_EDGE : THUMB_MAX_EDGE;
    const thumb = await decoded
      .clone()
      .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
    set.thumbS3Key = buildKey('thumbs', '.webp');
    await putObjectBuffer(set.thumbS3Key, thumb, 'image/webp');
  }

  if (needsDisplay) {
    const display = await decoded
      .clone()
      .resize(DISPLAY_MAX_EDGE, DISPLAY_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    set.displayS3Key = buildKey('displays', '.webp');
    await putObjectBuffer(set.displayS3Key, display, 'image/webp');
  }

  await db.update(assets).set(set).where(eq(assets.s3Key, s3Key));
  return 'done';
}
