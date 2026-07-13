import sharp from 'sharp';
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

/** iPhone camera formats — sharp's prebuilt libvips has no HEVC codec for these. */
const HEIC_TYPES = new Set(['image/heic', 'image/heif']);

/**
 * Downscale one stored photo into a WebP thumbnail for grids and banners, and
 * record it on every asset row that references the original object.
 *
 * The full-size original stays untouched (raw inputs are kept forever) — the
 * lightbox still loads it; only list/grid views switch to the thumbnail.
 *
 * HEIC/HEIF (iPhone camera originals) can't be decoded by sharp's prebuilt
 * binaries, so they go through libheif's WASM decoder first — which also makes
 * these photos visible in Chrome/Firefox at all (they can't render HEIC).
 *
 * Idempotent: once the asset rows carry a `thumbS3Key`, it's a no-op — safe
 * under pg-boss retries. A photo that still can't be decoded is skipped; the
 * UI falls back to the original, as before.
 */
export async function generateThumbnail(s3Key: string): Promise<'done' | 'skipped'> {
  const [asset] = await db
    .select({ kind: assets.kind, thumbS3Key: assets.thumbS3Key, mimeType: assets.mimeType })
    .from(assets)
    .where(eq(assets.s3Key, s3Key))
    .limit(1);
  if (!asset || asset.kind !== 'photo' || asset.thumbS3Key) return 'skipped';

  const original = await getObjectBuffer(s3Key);
  const isHeic = HEIC_TYPES.has(asset.mimeType.split(';')[0].trim().toLowerCase());
  let thumb: Buffer;
  try {
    // libheif applies the HEIC container's rotation itself; EXIF-carrying
    // formats (JPEG) need sharp's .rotate() to bake the orientation in.
    const pipeline = isHeic
      ? await (async () => {
          const { width, height, data } = await decodeHeic({ buffer: original });
          return sharp(Buffer.from(data), { raw: { width, height, channels: 4 } });
        })()
      : sharp(original).rotate();
    const maxEdge = isHeic ? HEIC_MAX_EDGE : THUMB_MAX_EDGE;
    thumb = await pipeline
      .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
  } catch (err) {
    console.error(`[thumbnail] cannot decode ${s3Key}, keeping original only:`, err);
    return 'skipped';
  }

  const thumbKey = buildKey('thumbs', '.webp');
  await putObjectBuffer(thumbKey, thumb, 'image/webp');
  await db.update(assets).set({ thumbS3Key: thumbKey }).where(eq(assets.s3Key, s3Key));
  return 'done';
}
