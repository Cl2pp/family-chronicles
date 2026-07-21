import sharp from 'sharp';
import { getObjectBuffer } from '@/lib/s3';

/**
 * Shared "encode a stored photo as a vision-input data URI" helper, used by both new
 * PR3 AI call sites (`lib/photo-vision.ts`'s per-photo scoring batches and
 * `lib/photo-book-ai-layout.ts`'s design pass). Mirrors `lib/book-ai-layout.ts`'s
 * private `photoVisionDataUri` exactly — same 768px/JPEG-80 treatment, same
 * thumbnail-first-then-original fallback, same "never a presigned URL" reasoning
 * (OpenRouter/Anthropic fetch `image_url` values themselves, which requires the object
 * store to be a publicly reachable HTTPS endpoint — untrue for local/self-hosted MinIO
 * and any firewalled deployment; data URIs work everywhere).
 *
 * Deliberately NOT imported by `lib/book-ai-layout.ts` itself — that file, and the
 * story-book AI design pass it implements, are out of scope for this PR and stay
 * byte-for-byte untouched; this is a fresh module the two new PR3 files share instead of
 * duplicating the same ~15 lines twice.
 */

/** Longest edge sent as vision input — plenty for scoring/design judgment without
 *  shipping camera originals. */
export const VISION_MAX_EDGE = 768;
const VISION_JPEG_QUALITY = 80;

export interface VisionImageSource {
  s3Key: string;
  thumbS3Key?: string | null;
}

/**
 * Encodes a photo as a base64 JPEG data URI for vision input: reads the downscaled
 * thumbnail when one exists (smaller, faster, plenty for scoring/design judgment), else
 * the original, normalizing to JPEG so every model in front of OpenRouter can read it
 * regardless of source format (HEIC, orientation-tagged JPEG, etc.).
 *
 * Returns `null` (never throws) when neither source can be read/decoded — the caller
 * treats that photo as unscoreable for this attempt rather than failing the whole batch.
 */
export async function encodePhotoForVision(photo: VisionImageSource): Promise<string | null> {
  const sources = photo.thumbS3Key ? [photo.thumbS3Key, photo.s3Key] : [photo.s3Key];
  for (const key of sources) {
    try {
      const buffer = await getObjectBuffer(key);
      const out = await sharp(buffer, { failOn: 'none' })
        .rotate()
        .resize({ width: VISION_MAX_EDGE, height: VISION_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: VISION_JPEG_QUALITY, mozjpeg: true })
        .toBuffer();
      return `data:image/jpeg;base64,${out.toString('base64')}`;
    } catch (e) {
      console.warn(`[vision-image] failed to encode ${key} for vision, trying next source:`, e);
    }
  }
  return null;
}
