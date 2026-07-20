import { db } from '@/db';
import { assets, messageAttachments, people, user } from '@/db/schema';
import { deleteObject, listObjects } from '@/lib/s3';

/**
 * Every prefix the browser can PUT into via a presigned URL. An object lands here the
 * moment we sign for it — but the DB row that gives it meaning is only written *after*
 * the upload succeeds. Close the tab in between (or drop the photo from the composer
 * tray before sending) and the object is stranded with nothing pointing at it.
 *
 * Note this is the only kind of orphan there is. Photos from a *discarded* draft are
 * NOT orphans: their `message_attachments` rows keep rendering in the chat history, so
 * deleting them would leave broken thumbnails in the conversation.
 */
// `thumbs/`/`displays/` are worker-written, not browser-uploaded, but sweeping them the
// same way reclaims renditions whose asset rows are gone (e.g. after a story delete
// raced). `displays/` is the photo-book "display" rendition (lib/thumbnails.ts,
// docs/PHOTO_BOOK_PLAN.md §8). `books/photos/` is the bulk photo-book uploader's prefix
// (lib/books.ts, addBookPhotos) — same abandoned-upload risk as `stories/photos/`.
const SWEPT_PREFIXES = [
  'chat/photos/',
  'chat/audio/',
  'stories/photos/',
  'books/photos/',
  'avatars/',
  'thumbs/',
  'displays/',
];

/**
 * How long an object may sit unreferenced before it counts as abandoned. Comfortably
 * longer than a presigned PUT's 15-minute validity, so an upload that is still in
 * flight — or whose row is written moments later — is never swept.
 */
const GRACE_MS = 24 * 60 * 60 * 1000;

/** Every object key the database still points at. */
async function referencedKeys(): Promise<Set<string>> {
  const [attachmentRows, assetRows, thumbRows, displayRows, personRows, userRows] = await Promise.all([
    db.select({ key: messageAttachments.s3Key }).from(messageAttachments),
    db.select({ key: assets.s3Key }).from(assets),
    db.select({ key: assets.thumbS3Key }).from(assets),
    db.select({ key: assets.displayS3Key }).from(assets),
    db.select({ key: people.avatarS3Key }).from(people),
    db.select({ key: user.image }).from(user),
  ]);
  const keys = new Set<string>();
  for (const rows of [attachmentRows, assetRows, thumbRows, displayRows, personRows, userRows]) {
    for (const r of rows) if (r.key) keys.add(r.key);
  }
  return keys;
}

/**
 * Delete stored objects that no database row references and that are older than the
 * grace period. Returns how many were removed.
 *
 * Ordering matters: the referenced set is read *before* the object listing. If a row is
 * written while we sweep, we see the row (and skip the object) rather than the reverse.
 */
export async function sweepOrphanedObjects(now = Date.now()): Promise<number> {
  const keep = await referencedKeys();
  const cutoff = now - GRACE_MS;

  let deleted = 0;
  for (const prefix of SWEPT_PREFIXES) {
    const objects = await listObjects(prefix);
    for (const obj of objects) {
      if (keep.has(obj.key)) continue;
      // No timestamp means we can't prove it's old enough — leave it alone.
      if (!obj.lastModified || obj.lastModified.getTime() > cutoff) continue;
      try {
        await deleteObject(obj.key);
        deleted++;
      } catch (err) {
        console.error(`[sweep] failed to delete ${obj.key}:`, err);
      }
    }
  }
  return deleted;
}
