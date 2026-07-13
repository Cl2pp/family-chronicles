import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { assets, messageAttachments } from '@/db/schema';
import { buildKey, getObjectBuffer, putObjectBuffer } from '@/lib/s3';

const execFileAsync = promisify(execFile);

/**
 * MediaRecorder output Safari/iOS cannot decode. Anything the browser recorded as
 * WebM/Ogg (always Opus) gets re-encoded; AAC/MP3/WAV already play everywhere.
 */
const NEEDS_TRANSCODE = new Set(['audio/webm', 'audio/ogg']);

function baseType(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase();
}

/**
 * Re-encode one stored voice note as AAC-in-MP4 (`.m4a`) so it plays on every
 * browser — Safari and iOS render WebM/Opus recordings as silence.
 *
 * The new object replaces the old one in every referencing row (chat attachments and
 * story assets share s3 keys); the superseded WebM is left for the orphan sweeper.
 * Idempotent: once no row carries a transcodable type for this key, it's a no-op —
 * safe under pg-boss retries.
 */
export async function transcodeAudioObject(s3Key: string): Promise<'done' | 'skipped'> {
  const [attachment] = await db
    .select({ mimeType: messageAttachments.mimeType })
    .from(messageAttachments)
    .where(eq(messageAttachments.s3Key, s3Key))
    .limit(1);
  const [asset] = await db
    .select({ mimeType: assets.mimeType })
    .from(assets)
    .where(eq(assets.s3Key, s3Key))
    .limit(1);
  const mimeType = attachment?.mimeType ?? asset?.mimeType;
  if (!mimeType || !NEEDS_TRANSCODE.has(baseType(mimeType))) return 'skipped';

  const original = await getObjectBuffer(s3Key);
  const dir = await mkdtemp(join(tmpdir(), 'transcode-'));
  try {
    const ext = baseType(mimeType) === 'audio/ogg' ? '.ogg' : '.webm';
    const inPath = join(dir, `in${ext}`);
    const outPath = join(dir, 'out.m4a');
    await writeFile(inPath, original);
    // Voice notes are mono speech — 96 kbps AAC is transparent for this content.
    await execFileAsync('ffmpeg', [
      '-y',
      '-i', inPath,
      '-vn',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-movflags', '+faststart',
      outPath,
    ]);
    const converted = await readFile(outPath);

    const newKey = buildKey('chat/audio', '.m4a');
    await putObjectBuffer(newKey, converted, 'audio/mp4');

    await db.transaction(async (tx) => {
      await tx
        .update(messageAttachments)
        .set({ s3Key: newKey, mimeType: 'audio/mp4', bytes: converted.length })
        .where(eq(messageAttachments.s3Key, s3Key));
      await tx
        .update(assets)
        .set({ s3Key: newKey, mimeType: 'audio/mp4', bytes: converted.length })
        .where(eq(assets.s3Key, s3Key));
    });
    return 'done';
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
