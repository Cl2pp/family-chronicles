import type { ChatCompletionContentPart, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { db } from '@/db';
import { assets, bookPhotos } from '@/db/schema';
import { env } from '@/lib/env';
import { openrouter, OPENROUTER_ROUTING } from '@/lib/ai/client';
import { encodePhotoForVision } from '@/lib/vision-image';
import { enqueuePhotoVision } from '@/lib/queue';
import {
  PHOTO_VISION_BATCH_SIZE,
  parseVisionBatchResponse,
  splitIntoVisionBatches,
} from '@/lib/photo-analysis';

/**
 * The `photo-vision` worker job (docs/PHOTO_BOOK_PLAN.md §4): batched AI scoring of
 * book photos. Pure batch-splitting/JSON-parsing lives in `lib/photo-analysis.ts`
 * (unit-tested there, see the module comment for why); this file is the DB/S3/model
 * orchestration around it — the counterpart of `lib/photo-meta.ts` for the deterministic
 * pass, and structurally close to `lib/book-ai-layout.ts`'s request-building, except a
 * scoring batch throws on failure (instead of returning `null`) so the worker's bounded
 * `photoVision` queue retry (`lib/queue.ts`) can re-run it — see `runPhotoVisionBatch`'s
 * doc comment for the retry-shrinking mechanic that makes that safe to do per-batch
 * rather than per-photo.
 */

const SYSTEM_PROMPT = `You are a fast, no-nonsense photo scorer for "Familienwerk", a private family memoir app. You are shown several family photos, each preceded by a line naming its assetId. For EACH photo shown, output one JSON object with these exact fields:

{
  "assetId": "<the id given just before that photo>",
  "aestheticScore": <0-10>,       // composition, light, the moment itself — a plain snapshot is 3-5, a genuinely great shot is 8+
  "sharpness": "sharp" | "soft" | "blurry",
  "eyesClosed": true | false,     // true if ANY clearly visible face has closed/blinking eyes; false if there are no faces or every visible eye is open
  "peopleCount": <integer>,       // how many people are in the photo, 0 if none
  "sceneTags": ["..."],           // 1-4 short lowercase tags, e.g. "beach", "birthday", "food", "group photo"
  "shortDescription": "...",      // one short, plain English sentence describing what's in the photo — do not guess names
  "coverCandidate": true | false  // true only for a warm, clear, well-composed photo of people that would make a great book cover
}

Reply with ONLY a JSON array of these objects, one per photo shown, in any order. No markdown code fences, no explanation before or after — nothing but the JSON array.`;

/** Builds the vision request for one batch: a short instruction plus each photo,
 *  labeled by its assetId immediately before the image (mirrors how
 *  `lib/book-ai-layout.ts` labels images in its chapter walk). Photos that can't be
 *  read/decoded (`encodePhotoForVision` returns null) are silently dropped from the
 *  request — `sentIds` tells the caller which ones actually went out, so it can treat
 *  the rest as failed for this attempt without waiting on a response that will never
 *  mention them. */
async function buildVisionMessages(
  photos: { assetId: string; s3Key: string; thumbS3Key: string | null }[],
): Promise<{ messages: ChatCompletionMessageParam[]; sentIds: string[] }> {
  const userParts: ChatCompletionContentPart[] = [
    {
      type: 'text',
      text: `Score these ${photos.length} family photo${photos.length === 1 ? '' : 's'}. Reply with the JSON array only.`,
    },
  ];
  const sentIds: string[] = [];
  for (const photo of photos) {
    const dataUri = await encodePhotoForVision(photo);
    if (!dataUri) continue;
    userParts.push({ type: 'text', text: `assetId: ${photo.assetId}` });
    userParts.push({ type: 'image_url', image_url: { url: dataUri } });
    sentIds.push(photo.assetId);
  }
  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userParts },
    ],
    sentIds,
  };
}

/** Marks the given book photos' vision pass as permanently failed — called once the
 *  `photoVision` queue's bounded retries are exhausted for them (mirrors
 *  `markPhotoMetaFailed`). Guarded to `analysisStatus != 'done'` so a race with a
 *  concurrent successful write can never downgrade a completed score back to failed. */
export async function markPhotoVisionFailed(assetIds: string[]): Promise<void> {
  if (assetIds.length === 0) return;
  await db
    .update(bookPhotos)
    .set({ analysisStatus: 'failed', updatedAt: new Date() })
    .where(and(inArray(bookPhotos.assetId, assetIds), ne(bookPhotos.analysisStatus, 'done')));
}

/**
 * Scores one batch of book photos (≤ `PHOTO_VISION_BATCH_SIZE`, though this accepts any
 * size — the caller decides batching) with the vision model and persists
 * `book_photos.analysis`/`analysis_status`.
 *
 * Idempotent: only photos whose `analysisStatus` isn't already `'done'` are selected —
 * this is what makes retrying the WHOLE batch on partial failure safe and even useful
 * (see below) rather than wasteful: a retry only ever re-sends the photos still missing
 * a score, shrinking automatically as earlier attempts succeed. A photo that arrives
 * already `'failed'` (the interim state `markPhotoMetaFailed` in `lib/photo-meta.ts`
 * sets when the deterministic pass gives up — see that module's comment) is treated as
 * ordinary `'pending'` work here, not as a vision failure to skip.
 *
 * Throws (does not itself decide when to give up) whenever the batch, as a whole,
 * didn't fully succeed:
 *  - the model request itself failed (network/HTTP error) — propagated as-is;
 *  - the response had no usable JSON array at all;
 *  - one or more of the batch's photos ended up without a valid score (missing from the
 *    response, present but schema-invalid, or never sent because it couldn't be
 *    encoded).
 * In every case, whatever DID score successfully is written to the DB before the throw
 * — nothing already-good is discarded. The worker handler (`handlePhotoVision` in
 * `worker/index.ts`, mirroring `handlePhotoMeta`) catches this, and only once the
 * `photoVision` queue's bounded retries (`lib/queue.ts`) are exhausted does it call
 * `markPhotoVisionFailed` for whatever is still not `'done'` — so a single flaky photo
 * in an otherwise-fine batch gets a few free retries (increasingly narrowed to just
 * itself) before it's permanently marked failed and the rest of the book carries on
 * without waiting on it.
 */
export async function runPhotoVisionBatch(assetIds: string[]): Promise<void> {
  if (assetIds.length === 0) return;

  const rows = await db
    .select({
      assetId: assets.id,
      s3Key: assets.s3Key,
      thumbS3Key: assets.thumbS3Key,
      analysisStatus: bookPhotos.analysisStatus,
    })
    .from(bookPhotos)
    .innerJoin(assets, eq(bookPhotos.assetId, assets.id))
    .where(inArray(bookPhotos.assetId, assetIds));

  const pending = rows.filter((r) => r.analysisStatus !== 'done');
  if (pending.length === 0) return;

  await db
    .update(bookPhotos)
    .set({ analysisStatus: 'analyzing', updatedAt: new Date() })
    .where(inArray(bookPhotos.assetId, pending.map((p) => p.assetId)));

  const { messages, sentIds } = await buildVisionMessages(pending);
  const notSent = pending.filter((p) => !sentIds.includes(p.assetId)).map((p) => p.assetId);

  if (sentIds.length === 0) {
    throw new Error(`photo-vision batch: none of ${pending.length} photo(s) could be read/decoded`);
  }

  const completion = await openrouter.chat.completions.create({
    model: env.VISION_MODEL,
    messages,
    ...OPENROUTER_ROUTING,
  });

  const text = completion.choices[0]?.message?.content;
  const parsed = typeof text === 'string' && text.trim() ? parseVisionBatchResponse(text) : null;

  if (!parsed) {
    console.error(
      `[photo-vision] batch produced no usable JSON for ${sentIds.length} photo(s):`,
      typeof text === 'string' ? text.slice(0, 500) : text,
    );
    throw new Error('photo-vision batch: model returned no usable JSON array');
  }

  const succeeded: string[] = [];
  for (const assetId of sentIds) {
    const analysis = parsed.results.get(assetId);
    if (!analysis) continue;
    await db
      .update(bookPhotos)
      .set({ analysis, analysisStatus: 'done', updatedAt: new Date() })
      .where(eq(bookPhotos.assetId, assetId));
    succeeded.push(assetId);
  }

  const missing = sentIds.filter((id) => !succeeded.includes(id));
  const allFailed = [...notSent, ...missing];
  if (allFailed.length > 0) {
    console.error(
      `[photo-vision] ${allFailed.length}/${pending.length} photo(s) in this batch got no valid score:`,
      allFailed,
    );
    throw new Error(`photo-vision batch: ${allFailed.length} photo(s) unscored`);
  }
}

/**
 * Enqueues vision-scoring batches for the given (newly added or otherwise pending)
 * assetIds — the "enqueue helper that splits a book's pending photos into ~10-id
 * batches" (docs/PHOTO_BOOK_PLAN.md PR3 scope). Triggered from `addBookPhotos`
 * (`lib/books.ts`) right after upload, alongside `enqueueThumbnail`/`enqueuePhotoMeta` —
 * idempotent under the uploader's repeated flushes because it's only ever called with
 * assetIds the caller just freshly inserted (never a duplicate/existing id), so a
 * retried flush can't double-enqueue the same photo's scoring.
 */
export async function enqueuePendingPhotoVisionBatches(assetIds: string[]): Promise<void> {
  for (const batch of splitIntoVisionBatches(assetIds, PHOTO_VISION_BATCH_SIZE)) {
    await enqueuePhotoVision({ assetIds: batch });
  }
}
