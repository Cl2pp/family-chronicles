import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';

export const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

/**
 * Build a collision-free object key. `ext` comes from the MIME allowlist in
 * `lib/uploads.ts` — never from a client-supplied filename.
 */
export function buildKey(prefix: string, ext: string): string {
  return `${prefix}/${randomUUID()}${ext}`;
}

/**
 * Presigned URL the browser uses to PUT a file directly to storage.
 *
 * Both `Content-Type` and `Content-Length` are forced into the signature via
 * `signableHeaders`, so the client must send back exactly what we signed:
 *
 * - Without signing `content-type`, the presigner leaves it unsigned and a client can
 *   PUT `text/html` under a `.png` key — storage would then serve that back as HTML.
 * - Without `content-length`, a client can under-report its size to slip past the cap
 *   in `lib/uploads.ts` and upload something arbitrarily large.
 *
 * Browsers set `Content-Length` from the `Blob` body automatically; callers must set
 * `Content-Type` to the canonical type the presign action returned.
 */
export function presignPut(key: string, contentType: string, contentLength: number, expiresIn = 900) {
  return getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
    }),
    { expiresIn, signableHeaders: new Set(['content-type', 'content-length']) },
  );
}

/**
 * Presigned URL for reading a private object (audio playback, photos).
 *
 * Pass `contentType` to pin how the object comes back, overriding whatever type is
 * stored on it. `presignPut` now signs the type, but objects written before that can
 * still carry an attacker-chosen `Content-Type` — this stops one being served as HTML.
 */
export function presignGet(key: string, contentType?: string, expiresIn = 3600) {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      ResponseContentType: contentType,
    }),
    { expiresIn },
  );
}

/** Download an object into memory (used by the worker to feed Whisper). */
export async function getObjectBuffer(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  if (!res.Body) throw new Error(`Object not found: ${key}`);
  const bytes = await res.Body.transformToByteArray();
  return Buffer.from(bytes);
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}

export interface StoredObject {
  key: string;
  lastModified: Date | null;
}

/** Every object under a prefix, paging through the listing (used by the orphan sweeper). */
export async function listObjects(prefix: string): Promise<StoredObject[]> {
  const out: StoredObject[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: env.S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) out.push({ key: obj.Key, lastModified: obj.LastModified ?? null });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}
