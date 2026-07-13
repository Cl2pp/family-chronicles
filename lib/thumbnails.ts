import sharp from 'sharp';
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
 * Downscale one stored photo into a WebP thumbnail for grids and banners, and
 * record it on every asset row that references the original object.
 *
 * The full-size original stays untouched (raw inputs are kept forever) — the
 * lightbox still loads it; only list/grid views switch to the thumbnail.
 *
 * Idempotent: once the asset rows carry a `thumbS3Key`, it's a no-op — safe
 * under pg-boss retries. A photo sharp can't decode (e.g. HEIC without codec
 * support) is skipped; the UI falls back to the original, as before.
 */
export async function generateThumbnail(s3Key: string): Promise<'done' | 'skipped'> {
  const [asset] = await db
    .select({ kind: assets.kind, thumbS3Key: assets.thumbS3Key })
    .from(assets)
    .where(eq(assets.s3Key, s3Key))
    .limit(1);
  if (!asset || asset.kind !== 'photo' || asset.thumbS3Key) return 'skipped';

  const original = await getObjectBuffer(s3Key);
  let thumb: Buffer;
  try {
    thumb = await sharp(original)
      // Bake in the EXIF orientation — phone photos would otherwise render sideways.
      .rotate()
      .resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
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
