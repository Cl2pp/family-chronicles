import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { assets, bookPhotos } from '@/db/schema';
import { getObjectBuffer } from '@/lib/s3';
import { orientedDimensions } from '@/lib/book-content';
import { computeBlurScore, computeDHash, decodeForAnalysis, readExif } from '@/lib/photo-hash';

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
 * `analysisStatus`/`analysis` on success — those otherwise track the vision pass (a
 * later PR). The one exception is `markPhotoMetaFailed` below, called by the worker
 * once this job's bounded retries are exhausted — see its own comment.
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

  // Decode once (the expensive step for HEIC — see decodeForAnalysis) and hand the
  // same pipeline to both metrics via their internal .clone().
  const image = await decodeForAnalysis(buffer, asset.mimeType);
  const [exif, phash, blurScore] = await Promise.all([
    readExif(buffer),
    computeDHash(image),
    computeBlurScore(image),
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

/**
 * Called by the worker (`handlePhotoMeta` in `worker/index.ts`) once `photo-meta`'s
 * bounded retries (queue-level `retryLimit`, `lib/queue.ts`) are exhausted for a
 * photo — i.e. it is genuinely, repeatedly undecodable (corrupt upload, a format
 * sharp/libheif can't handle even after the HEIC fix). Without this, such a photo's
 * `phash` stays null forever and the builder's "X / Y analyzed" poll
 * (`photo-book-builder.tsx`, `router.refresh()` every 4s) never terminates.
 *
 * This reuses `analysisStatus`, whose enum/column is otherwise owned end-to-end by
 * the `photo-vision` pass (a later PR) — see the comment on `photoAnalysisStatus` in
 * `db/schema.ts`. Here `'failed'` means *only* "the deterministic photo-meta pass
 * gave up on this photo"; it says nothing about vision. PR3 (photo-vision) must
 * treat a photo that arrives already `'failed'` as untouched by vision, not as a
 * vision failure, and reset/advance the status itself when it starts scoring.
 * Idempotent: safe to call more than once for the same photo.
 */
export async function markPhotoMetaFailed(assetId: string): Promise<void> {
  await db
    .update(bookPhotos)
    .set({ analysisStatus: 'failed', updatedAt: new Date() })
    .where(eq(bookPhotos.assetId, assetId));
}
