import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { assets, bookPhotos } from '@/db/schema';
import { getObjectBuffer } from '@/lib/s3';
import { orientedDimensions } from '@/lib/book-content';
import { computeBlurScore, computeDHash, readExif } from '@/lib/photo-hash';

/**
 * The `photo-meta` worker job (docs/PHOTO_BOOK_PLAN.md §4): deterministic, no-AI
 * per-photo metadata. Fetches the original from S3 and computes oriented
 * dimensions, EXIF capture time/GPS, a perceptual hash, and a blur score. The
 * pure math lives in `lib/photo-hash.ts` (unit-tested there); this module is the
 * DB/S3-touching orchestration around it.
 */

/**
 * Analyze one book photo: fetch the original from S3, compute oriented dimensions
 * (persisted to `assets`), EXIF capture time/GPS, dHash, and blur score (persisted
 * to `book_photos`). Idempotent — a photo that already has a `phash` is skipped, so
 * pg-boss retries and duplicate enqueues are harmless. Does NOT touch
 * `analysisStatus`/`analysis` — those track the vision pass (a later PR).
 */
export async function analyzePhotoMeta(assetId: string): Promise<'done' | 'skipped'> {
  const [asset] = await db
    .select({
      s3Key: assets.s3Key,
      mimeType: assets.mimeType,
      kind: assets.kind,
      bookId: assets.bookId,
    })
    .from(assets)
    .where(eq(assets.id, assetId))
    .limit(1);
  if (!asset || asset.kind !== 'photo' || !asset.bookId) return 'skipped';

  const [photo] = await db
    .select({ id: bookPhotos.id, phash: bookPhotos.phash })
    .from(bookPhotos)
    .where(eq(bookPhotos.assetId, assetId))
    .limit(1);
  if (!photo || photo.phash) return 'skipped';

  const buffer = await getObjectBuffer(asset.s3Key);

  const dims = await orientedDimensions(buffer);
  if (dims) {
    await db.update(assets).set({ width: dims.width, height: dims.height }).where(eq(assets.id, assetId));
  }

  const [exif, phash, blurScore] = await Promise.all([
    readExif(buffer),
    computeDHash(buffer),
    computeBlurScore(buffer),
  ]);

  await db
    .update(bookPhotos)
    .set({
      takenAt: exif.takenAt,
      gpsLat: exif.gpsLat,
      gpsLng: exif.gpsLng,
      phash,
      blurScore,
      updatedAt: new Date(),
    })
    .where(eq(bookPhotos.id, photo.id));

  return 'done';
}
