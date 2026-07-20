import sharp from 'sharp';
import { parse as exifrParse } from 'exifr';

/**
 * Pure, dependency-light photo metadata helpers used by the `photo-meta` worker job
 * (`lib/photo-meta.ts`). Split out from the job itself so these can be unit-tested
 * without pulling in `db`/`lib/env` (which require a full runtime configuration —
 * see `lib/photo-meta.test.ts` … `lib/photo-hash.test.ts`).
 */

/** Longest edge fed to the dHash/blur convolutions — plenty for both; keeps the
 *  raw-pixel buffers small regardless of the original's resolution. */
const ANALYSIS_MAX_EDGE = 256;

/**
 * Perceptual hash (dHash): downscale to 9×8 greyscale, compare each pixel to its
 * right neighbor, pack the 64 comparison bits into a 16-hex-digit string. Near-
 * duplicate photos land on hashes with a small Hamming distance (see
 * `hammingDistance`) — pure code, no AI, ~20 lines.
 */
export async function computeDHash(buffer: Buffer): Promise<string> {
  const { data } = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .greyscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let bits = '';
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = data[row * 9 + col];
      const right = data[row * 9 + col + 1];
      bits += left < right ? '1' : '0';
    }
  }

  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/** Hamming distance between two same-length hex dHashes — the near-duplicate metric
 *  layout-time dedup clustering (a later PR) will threshold on. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) throw new Error('Cannot compare hashes of different lengths.');
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}

/**
 * Variance of the Laplacian over a greyscale downscale — a standard, cheap blur
 * proxy: sharp edges produce a high-variance second derivative, blur flattens it.
 * Lower scores mean blurrier. Pure code, no dependency beyond sharp.
 */
export async function computeBlurScore(buffer: Buffer): Promise<number> {
  const { data, info } = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .greyscale()
    .resize(ANALYSIS_MAX_EDGE, ANALYSIS_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  if (width < 3 || height < 3) return 0;

  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const laplacian =
        data[idx - width] + data[idx + width] + data[idx - 1] + data[idx + 1] - 4 * data[idx];
      sum += laplacian;
      sumSq += laplacian * laplacian;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export interface ExifSummary {
  takenAt: Date | null;
  gpsLat: number | null;
  gpsLng: number | null;
}

/** Best-effort EXIF read — a photo with no/garbled EXIF (screenshots, re-saved
 *  images) just yields nulls, it's never a hard failure. */
export async function readExif(buffer: Buffer): Promise<ExifSummary> {
  try {
    const tags = await exifrParse(buffer, {
      pick: ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'latitude', 'longitude'],
    });
    const takenAtRaw: unknown = tags?.DateTimeOriginal ?? tags?.CreateDate ?? tags?.ModifyDate ?? null;
    const takenAt =
      takenAtRaw instanceof Date && !Number.isNaN(takenAtRaw.getTime()) ? takenAtRaw : null;
    const gpsLat = typeof tags?.latitude === 'number' ? tags.latitude : null;
    const gpsLng = typeof tags?.longitude === 'number' ? tags.longitude : null;
    return { takenAt, gpsLat, gpsLng };
  } catch (err) {
    console.error('[photo-hash] EXIF read failed, continuing without it:', err);
    return { takenAt: null, gpsLat: null, gpsLng: null };
  }
}
