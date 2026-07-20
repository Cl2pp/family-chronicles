import sharp, { type Sharp } from 'sharp';
import decodeHeic from 'heic-decode';
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

/** iPhone camera formats — sharp's prebuilt libvips has no HEVC codec for these
 *  (mirrors `HEIC_TYPES` in `lib/thumbnails.ts`). */
const HEIC_TYPES = new Set(['image/heic', 'image/heif']);

function isHeic(mimeType: string): boolean {
  return HEIC_TYPES.has(mimeType.split(';')[0].trim().toLowerCase());
}

/**
 * Decode one photo into an upright sharp pipeline, ready to `.clone()` into as many
 * downstream pixel transforms as needed without re-decoding the original. Mirrors
 * `lib/thumbnails.ts`'s HEIC handling exactly: sharp's prebuilt libvips has no HEVC
 * pixel codec, so HEIC/HEIF (the dominant iPhone camera format) is decoded through
 * libheif's WASM decoder first — otherwise `computeDHash`/`computeBlurScore` throw on
 * every photo an iPhone actually produces. libheif already applies the container's
 * rotation; every other, EXIF-carrying format still needs sharp's `.rotate()`.
 *
 * Exported so `lib/photo-meta.ts` can decode a photo once and hand the same pipeline
 * to both `computeDHash` and `computeBlurScore` — decoding a HEIC original is the
 * expensive step here, and running it twice (once per metric) would double that cost
 * per photo for no reason.
 */
export async function decodeForAnalysis(buffer: Buffer, mimeType: string): Promise<Sharp> {
  if (isHeic(mimeType)) {
    const { width, height, data } = await decodeHeic({ buffer });
    return sharp(Buffer.from(data), { raw: { width, height, channels: 4 } });
  }
  return sharp(buffer, { failOn: 'none' }).rotate();
}

/**
 * Perceptual hash (dHash): downscale to 9×8 greyscale, compare each pixel to its
 * right neighbor, pack the 64 comparison bits into a 16-hex-digit string. Near-
 * duplicate photos land on hashes with a small Hamming distance (see
 * `hammingDistance`) — pure code, no AI, ~20 lines.
 *
 * Takes an already-`decodeForAnalysis`'d image (`.clone()`d internally) rather than
 * raw bytes, so callers that also need `computeBlurScore` decode the original once.
 */
export async function computeDHash(image: Sharp): Promise<string> {
  const { data } = await image
    .clone()
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
 *
 * Takes an already-`decodeForAnalysis`'d image (`.clone()`d internally) rather than
 * raw bytes — see `computeDHash`.
 */
export async function computeBlurScore(image: Sharp): Promise<number> {
  const { data, info } = await image
    .clone()
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
