/**
 * What the browser is allowed to PUT straight into storage.
 *
 * Every presign action runs `validateUpload` before signing. Two things matter:
 *
 * 1. The signed `Content-Type` is taken from this allowlist, never from the client's
 *    `File.type` verbatim, so a stored object can only ever be served back as a type
 *    we chose. The bytes are still whatever the client sent — but they can't be
 *    served as `text/html`, which is what would make a bad upload dangerous.
 * 2. The object key's extension is derived from the MIME type, not from the client's
 *    filename, so `evil.php` can never become part of a key.
 */

export type UploadKind = 'photo' | 'audio' | 'avatar';

/** Allowed photo types → the extension we give the stored object. */
const PHOTO_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'image/heif': '.heif',
};

/** Allowed audio types. Whisper accepts all of these. */
const AUDIO_TYPES: Record<string, string> = {
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
};

const RULES: Record<UploadKind, { types: Record<string, string>; maxBytes: number }> = {
  photo: { types: PHOTO_TYPES, maxBytes: 15 * 1024 * 1024 },
  avatar: { types: PHOTO_TYPES, maxBytes: 5 * 1024 * 1024 },
  audio: { types: AUDIO_TYPES, maxBytes: 50 * 1024 * 1024 },
};

export const MAX_PHOTO_BYTES = RULES.photo.maxBytes;
export const MAX_AVATAR_BYTES = RULES.avatar.maxBytes;
export const MAX_AUDIO_BYTES = RULES.audio.maxBytes;

/** Hard cap of photos per photo book (docs/PHOTO_BOOK_PLAN.md §12.1, plan default) —
 *  bounds analysis cost and render memory. Enforced server-side, race-safely, in
 *  `addBookPhotos` (`lib/books.ts`); the bulk uploader reuses this constant for an
 *  instant client-side check, but the server check is the one that actually holds. */
export const MAX_PHOTOS_PER_BOOK = 300;

/** Accept for `<input type="file">`, so the picker matches what the server allows. */
export const PHOTO_ACCEPT = Object.keys(PHOTO_TYPES).join(',');

/** `MediaRecorder` reports `audio/webm;codecs=opus` — strip parameters before matching. */
function baseType(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase();
}

/**
 * The image type an object key's extension implies, for objects whose MIME type we
 * never stored (avatars). Used to pin `presignGet`'s response type: an avatar uploaded
 * before the allowlist existed could be an `image/svg+xml` carrying script.
 */
export function imageTypeForKey(key: string): string {
  const dot = key.lastIndexOf('.');
  const ext = dot === -1 ? '' : key.slice(dot).toLowerCase();
  const match = Object.entries(PHOTO_TYPES).find(([, e]) => e === ext);
  return match ? match[0] : 'application/octet-stream';
}

export interface ValidatedUpload {
  /** The canonical type to sign and store — never the client's raw string. */
  mimeType: string;
  /** Extension for the object key, derived from the type. */
  ext: string;
  /** Byte length the presigned PUT will be locked to. */
  bytes: number;
}

/**
 * Throw unless this upload is a type and size we accept. Returns the canonical
 * values the caller must sign with — using the client's originals would defeat it.
 */
export function validateUpload(kind: UploadKind, mimeType: string, bytes: number): ValidatedUpload {
  const rule = RULES[kind];
  const type = baseType(mimeType);
  const ext = rule.types[type];
  if (!ext) {
    const allowed = Object.keys(rule.types).join(', ');
    throw new Error(`Unsupported file type "${type}". Allowed: ${allowed}.`);
  }
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new Error('Upload size is missing or invalid.');
  }
  if (bytes > rule.maxBytes) {
    const mb = Math.round(rule.maxBytes / (1024 * 1024));
    throw new Error(`That file is too large — the limit is ${mb} MB.`);
  }
  return { mimeType: type, ext, bytes };
}

/**
 * Intrinsic pixel size of an image, read in the browser before upload, so the story
 * page can reserve the right space instead of cropping every photo to a fixed box.
 * Browser-only — `createImageBitmap` doesn't exist on the server.
 */
export async function readDimensions(file: File): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    bitmap.close();
    return { width, height };
  } catch {
    // Not every browser can decode HEIC — the asset just stays sizeless.
    return null;
  }
}
