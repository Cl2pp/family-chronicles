import 'dotenv/config';
import { eq } from 'drizzle-orm';
import type { JobWithMetadata } from 'pg-boss';
import { db } from '@/db';
import { books, stories } from '@/db/schema';
import {
  getBoss,
  QUEUES,
  SWEEP_ORPHANS_CRON,
  type DesignBookJob,
  type DesignPhotoBookJob,
  type PhotoMetaJob,
  type PhotoVisionJob,
  type RenderBookJob,
  type StyleJob,
  type ThumbnailJob,
  type TranscodeJob,
} from '@/lib/queue';
import { markRenderFailed, renderBook } from '@/lib/book-render';
import { proposePhotoBookPlan } from '@/lib/photo-book-ai-layout';
import { validatePhotoBookPlan } from '@/lib/photo-book-plan';
import type { PhotoBookDesignStage } from '@/lib/photo-book-design-stage';
import { buildAndPersistPhotoAutoPlan, loadPhotoBook } from '@/lib/photo-book-content';
import { styleStory } from '@/lib/ai/openrouter';
import { styleContextForStory } from '@/lib/stories';
import { sweepOrphanedObjects } from '@/lib/orphans';
import { transcodeAudioObject } from '@/lib/transcode';
import { generateThumbnail } from '@/lib/thumbnails';
import { analyzePhotoMeta, markPhotoMetaFailed } from '@/lib/photo-meta';
import { markPhotoVisionFailed, runPhotoVisionBatch } from '@/lib/photo-vision';

async function markFailed(storyId: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[worker] story ${storyId} failed:`, message);
  await db
    .update(stories)
    .set({ status: 'failed', errorMessage: message, updatedAt: new Date() })
    .where(eq(stories.id, storyId));
}

/** Rewrite a story's raw text into the family-memoir voice. */
async function handleStyle(data: StyleJob) {
  const { storyId } = data;
  try {
    const story = await db.query.stories.findFirst({ where: eq(stories.id, storyId) });
    if (!story) throw new Error(`Story ${storyId} not found`);
    if (!story.bodyOriginal?.trim()) throw new Error('No source text to style');

    const { styleGuide, storyLanguage } = await styleContextForStory(storyId);

    const styled = await styleStory({
      original: story.bodyOriginal,
      styleGuide,
      language: storyLanguage,
      title: story.title,
    });

    await db
      .update(stories)
      .set({ bodyStyled: styled, status: 'ready', errorMessage: null, updatedAt: new Date() })
      .where(eq(stories.id, storyId));

    console.log(`[worker] styled story ${storyId}`);
  } catch (err) {
    await markFailed(storyId, err);
  }
}

/** Re-encode a voice note so it plays on every browser (Safari can't decode WebM/Opus). */
async function handleTranscode(data: TranscodeJob) {
  try {
    const result = await transcodeAudioObject(data.s3Key);
    console.log(`[worker] transcode ${data.s3Key}: ${result}`);
  } catch (err) {
    // Playback falls back to the original file — worse, but nothing is lost.
    console.error(`[worker] transcode failed for ${data.s3Key}:`, err);
  }
}

/** Typeset a book into preview + print PDFs. */
async function handleRenderBook(data: RenderBookJob) {
  const { bookId } = data;
  try {
    await renderBook(bookId);
    console.log(`[worker] rendered book ${bookId}`);
  } catch (err) {
    console.error(`[worker] book render failed for ${bookId}:`, err);
    await markRenderFailed(bookId, err);
  }
}

/**
 * Run the AI design pass and persist whatever plan results: the AI's plan on success,
 * or a freshly-built auto-layout plan when the pass fails (invalid output, request
 * error, etc. — `proposePhotoBookPlan` never throws, it returns null). Either way the
 * job always ends with `design_requested_at` cleared so the builder's poll stops, and
 * a fresh plan in place — the "Design my book" button never leaves the book worse off
 * than before it was clicked, only either improved or unchanged.
 */
async function handleDesignBook(data: DesignBookJob) {
  // The legacy `design-book` queue stays registered for one release so jobs enqueued
  // before the unified deploy still drain; every enqueue site targets the unified
  // handler now.
  //
  // Defense in depth for exactly that drain window: a job queued before the deploy could
  // land on a book whose stored plan migration 0025 hasn't converted yet. Designing it
  // would overwrite that plan. A plan that doesn't validate as a unified one is left
  // alone — the migration (or the next regenerate) will deal with it.
  const [row] = await db
    .select({ layoutPlan: books.layoutPlan })
    .from(books)
    .where(eq(books.id, data.bookId))
    .limit(1);
  if (row?.layoutPlan != null && !validatePhotoBookPlan(row.layoutPlan).ok) {
    console.log(`[worker] design-book skipped for ${data.bookId}: its stored plan is not a unified plan`);
    await db.update(books).set({ designRequestedAt: null }).where(eq(books.id, data.bookId));
    return;
  }
  await handleDesignPhotoBook({ bookId: data.bookId });
}

/**
 * Run the photo-book AI design pass and persist whatever plan results — the photo-book
 * counterpart of `handleDesignBook`, same contract: the AI's plan on success, a freshly
 * built auto-layout plan on failure (`proposePhotoBookPlan` never throws, it returns
 * null), and `design_requested_at` always cleared at the end so the builder's poll
 * stops. "Design my book" never leaves the book worse off than before it was clicked.
 *
 * Every exit path also stamps `generated_at` — the builder Step 2 gate for "has this book
 * ever been generated" (docs/PHOTO_BOOK_PLAN.md builder restructure, PR6). Success and the
 * auto-layout fallback BOTH count: either way the book now has a complete, viewable plan,
 * which is all the gate cares about — it's not a signal that the AI pass specifically
 * succeeded (that's what `layoutSource` is for). Once set it is never cleared again by a
 * later regeneration, only re-stamped with a fresh timestamp.
 */
async function handleDesignPhotoBook(data: DesignPhotoBookJob) {
  const { bookId } = data;
  // Published to `books.design_stage` as the pass progresses so the builder's Step 2 can
  // show a live checklist instead of an indefinite spinner (`lib/photo-book-design-stage.ts`).
  // Never allowed to fail the job: a progress update is cosmetic.
  const onStage = async (stage: PhotoBookDesignStage) => {
    await db
      .update(books)
      .set({ designStage: stage })
      .where(eq(books.id, bookId))
      .catch((e) => console.warn(`[worker] could not record design stage '${stage}' for ${bookId}:`, e));
  };

  try {
    const plan = await proposePhotoBookPlan(bookId, { onStage });
    if (plan) {
      await db
        .update(books)
        .set({
          layoutPlan: plan,
          layoutSource: 'ai',
          layoutStale: false,
          designRequestedAt: null,
          designStage: null,
          generatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(books.id, bookId));
      console.log(`[worker] AI-designed photo book ${bookId}`);
      return;
    }

    console.log(`[worker] AI design pass for photo book ${bookId} produced no usable plan — falling back to auto layout`);
    await onStage('finalizing');
    const loaded = await loadPhotoBook(bookId);
    await buildAndPersistPhotoAutoPlan(bookId, loaded);
    await db
      .update(books)
      .set({ designRequestedAt: null, designStage: null, generatedAt: new Date() })
      .where(eq(books.id, bookId));
  } catch (err) {
    console.error(`[worker] design-photo-book failed for ${bookId}:`, err);
    let fellBackOk = false;
    try {
      const loaded = await loadPhotoBook(bookId);
      await buildAndPersistPhotoAutoPlan(bookId, loaded);
      fellBackOk = true;
    } catch (fallbackErr) {
      console.error(`[worker] auto-layout fallback also failed for photo book ${bookId}:`, fallbackErr);
    }
    // Only stamp `generatedAt` if the fallback actually produced a plan — if BOTH the AI
    // pass and the fallback failed, the book still has nothing to show, so the builder
    // should keep showing the config-only "not generated yet" view rather than a "book"
    // that's actually empty/broken.
    await db
      .update(books)
      .set({ designRequestedAt: null, designStage: null, ...(fellBackOk ? { generatedAt: new Date() } : {}) })
      .where(eq(books.id, bookId));
  }
}

/**
 * Score one batch (~10) of book photos with the vision model (docs/PHOTO_BOOK_PLAN.md
 * §4). Same retry/settle shape as `handlePhotoMeta`: `runPhotoVisionBatch` throws
 * whenever the batch, as a whole, didn't fully succeed (see its doc comment for why a
 * whole-batch retry is safe and even self-narrowing); this only marks the batch's
 * still-unscored photos permanently `'failed'` once the `photoVision` queue's bounded
 * retries (`lib/queue.ts`) are exhausted, so the builder's analysis-progress poll can
 * terminate instead of waiting forever on a handful of stubborn photos.
 */
async function handlePhotoVision(job: JobWithMetadata<PhotoVisionJob>) {
  const { assetIds } = job.data;
  try {
    await runPhotoVisionBatch(assetIds);
    console.log(`[worker] photo-vision scored batch of ${assetIds.length} photo(s)`);
  } catch (err) {
    const attempt = job.retryCount + 1;
    const maxAttempts = job.retryLimit + 1;
    console.error(
      `[worker] photo-vision failed for a batch of ${assetIds.length} photo(s) (attempt ${attempt}/${maxAttempts}):`,
      err,
    );
    if (job.retryCount >= job.retryLimit) {
      await markPhotoVisionFailed(assetIds).catch((markErr) =>
        console.error(`[worker] failed to mark photo-vision batch as failed:`, markErr),
      );
    }
    throw err;
  }
}

/** Downscale a stored photo so lists and grids don't ship camera originals. */
async function handleThumbnail(data: ThumbnailJob) {
  try {
    const result = await generateThumbnail(data.s3Key);
    console.log(`[worker] thumbnail ${data.s3Key}: ${result}`);
  } catch (err) {
    // Views fall back to the full-size original — slower, but nothing is lost.
    console.error(`[worker] thumbnail failed for ${data.s3Key}:`, err);
  }
}

/**
 * Extract deterministic metadata (dimensions, EXIF, phash, blur score) for one book
 * photo. Cheap and idempotent — safe to run at normal worker concurrency.
 *
 * Retries are bounded by the `photo-meta` queue's `retryLimit`/`retryDelay`
 * (`lib/queue.ts`), so a transient S3/network error recovers on its own. Errors are
 * rethrown (not swallowed) so pg-boss actually counts and schedules those retries —
 * once they're exhausted, this marks the photo settled-but-failed
 * (`markPhotoMetaFailed`) so the builder's "X / Y analyzed" poll can terminate
 * instead of waiting forever on a photo that will never decode.
 */
async function handlePhotoMeta(job: JobWithMetadata<PhotoMetaJob>) {
  const { assetId } = job.data;
  try {
    const result = await analyzePhotoMeta(assetId);
    console.log(`[worker] photo-meta ${assetId}: ${result}`);
  } catch (err) {
    const attempt = job.retryCount + 1;
    const maxAttempts = job.retryLimit + 1;
    console.error(`[worker] photo-meta failed for ${assetId} (attempt ${attempt}/${maxAttempts}):`, err);
    if (job.retryCount >= job.retryLimit) {
      await markPhotoMetaFailed(assetId).catch((markErr) =>
        console.error(`[worker] failed to mark photo-meta as failed for ${assetId}:`, markErr),
      );
    }
    throw err;
  }
}

/** Reclaim storage from uploads whose owning row was never written. */
async function handleSweepOrphans() {
  try {
    const deleted = await sweepOrphanedObjects();
    console.log(`[worker] swept ${deleted} orphaned object(s)`);
  } catch (err) {
    // A failed sweep costs disk, not data — never take the worker down for it.
    console.error('[worker] orphan sweep failed:', err);
  }
}

async function main() {
  const boss = await getBoss();

  await boss.work<StyleJob>(QUEUES.style, async (jobs) => {
    for (const job of jobs) await handleStyle(job.data);
  });

  await boss.work<TranscodeJob>(QUEUES.transcode, async (jobs) => {
    for (const job of jobs) await handleTranscode(job.data);
  });

  // Chromium + full-size photos: strictly one render at a time.
  await boss.work<RenderBookJob>(
    QUEUES.renderBook,
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) await handleRenderBook(job.data);
    },
  );

  await boss.work<ThumbnailJob>(QUEUES.thumbnail, async (jobs) => {
    for (const job of jobs) await handleThumbnail(job.data);
  });

  // One model call plus photo downloads: serial, like render-book.
  await boss.work<DesignBookJob>(
    QUEUES.designBook,
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) await handleDesignBook(job.data);
    },
  );

  // includeMetadata: true so handlePhotoMeta can see retryCount/retryLimit and tell
  // a mid-retry failure from the final, exhausted one.
  await boss.work(
    QUEUES.photoMeta,
    { includeMetadata: true } as const,
    async (jobs: JobWithMetadata<PhotoMetaJob>[]) => {
      for (const job of jobs) await handlePhotoMeta(job);
    },
  );

  // Same includeMetadata reasoning as photo-meta above.
  await boss.work(
    QUEUES.photoVision,
    { includeMetadata: true } as const,
    async (jobs: JobWithMetadata<PhotoVisionJob>[]) => {
      for (const job of jobs) await handlePhotoVision(job);
    },
  );

  // One model call plus photo downloads: serial, like design-book.
  await boss.work<DesignPhotoBookJob>(
    QUEUES.designPhotoBook,
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) await handleDesignPhotoBook(job.data);
    },
  );

  await boss.work(QUEUES.sweepOrphans, async () => {
    await handleSweepOrphans();
  });
  await boss.schedule(QUEUES.sweepOrphans, SWEEP_ORPHANS_CRON);

  console.log(
    '[worker] ready — listening for style + transcode + thumbnail + render-book + design-book + photo-meta + photo-vision + design-photo-book jobs; orphan sweep scheduled',
  );
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
