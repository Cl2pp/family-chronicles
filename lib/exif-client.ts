import { parse } from 'exifr';

/**
 * Browser-side EXIF peek for the bulk photo uploader (docs/PHOTO_BOOK_PLAN.md §3):
 * capture time + GPS, read client-side so the grid can show a rough chronological
 * order while uploads are still in flight. These are HINTS only — the worker's
 * `photo-meta` job re-extracts EXIF from the original server-side as the
 * authoritative value (HEIC parsing in-browser is spotty, and `exifr` here only
 * reads a minimal tag subset).
 */
export interface ClientExifHint {
  takenAt: Date | null;
  gpsLat: number | null;
  gpsLng: number | null;
}

/** Best-effort — a photo with no/unreadable EXIF just yields nulls, never throws. */
export async function readClientExif(file: File): Promise<ClientExifHint> {
  try {
    const tags = await parse(file, {
      pick: ['DateTimeOriginal', 'CreateDate', 'latitude', 'longitude'],
    });
    const takenAtRaw: unknown = tags?.DateTimeOriginal ?? tags?.CreateDate ?? null;
    const takenAt =
      takenAtRaw instanceof Date && !Number.isNaN(takenAtRaw.getTime()) ? takenAtRaw : null;
    const gpsLat = typeof tags?.latitude === 'number' ? tags.latitude : null;
    const gpsLng = typeof tags?.longitude === 'number' ? tags.longitude : null;
    return { takenAt, gpsLat, gpsLng };
  } catch {
    return { takenAt: null, gpsLat: null, gpsLng: null };
  }
}
