import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { books, stories } from '@/db/schema';
import {
  getBoss,
  QUEUES,
  SWEEP_ORPHANS_CRON,
  type DesignBookJob,
  type RenderBookJob,
  type StyleJob,
  type ThumbnailJob,
  type TranscodeJob,
} from '@/lib/queue';
import { markRenderFailed, renderBook } from '@/lib/book-render';
import { proposeLayoutPlan } from '@/lib/book-ai-layout';
import { backfillDimensionsFromOriginals, buildAndPersistAutoPlan, loadBook } from '@/lib/book-content';
import { styleStory } from '@/lib/ai/openrouter';
import { styleContextForStory } from '@/lib/stories';
import { sweepOrphanedObjects } from '@/lib/orphans';
import { transcodeAudioObject } from '@/lib/transcode';
import { generateThumbnail } from '@/lib/thumbnails';

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
 * error, etc. — `proposeLayoutPlan` never throws, it returns null). Either way the
 * job always ends with `design_requested_at` cleared so the builder's poll stops, and
 * a fresh plan in place — the "Design my book" button never leaves the book worse off
 * than before it was clicked, only either improved or unchanged.
 */
async function handleDesignBook(data: DesignBookJob) {
  const { bookId } = data;
  try {
    const plan = await proposeLayoutPlan(bookId);
    if (plan) {
      await db
        .update(books)
        .set({
          layoutPlan: plan,
          layoutSource: 'ai',
          layoutStale: false,
          designRequestedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(books.id, bookId));
      console.log(`[worker] AI-designed book ${bookId}`);
      return;
    }

    console.log(`[worker] AI design pass for ${bookId} produced no usable plan — falling back to auto layout`);
    const loaded = await loadBook(bookId);
    await backfillDimensionsFromOriginals(loaded.allPhotosById);
    await buildAndPersistAutoPlan(bookId, loaded);
    await db.update(books).set({ designRequestedAt: null }).where(eq(books.id, bookId));
  } catch (err) {
    console.error(`[worker] design-book failed for ${bookId}:`, err);
    // Best effort: still clear the flag so the builder's poll doesn't spin forever, and
    // still try to leave a fresh auto plan in place rather than a stale/broken one.
    try {
      const loaded = await loadBook(bookId);
      await backfillDimensionsFromOriginals(loaded.allPhotosById);
      await buildAndPersistAutoPlan(bookId, loaded);
    } catch (fallbackErr) {
      console.error(`[worker] auto-layout fallback also failed for ${bookId}:`, fallbackErr);
    }
    await db.update(books).set({ designRequestedAt: null }).where(eq(books.id, bookId));
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

  await boss.work(QUEUES.sweepOrphans, async () => {
    await handleSweepOrphans();
  });
  await boss.schedule(QUEUES.sweepOrphans, SWEEP_ORPHANS_CRON);

  console.log(
    '[worker] ready — listening for style + transcode + thumbnail + render-book + design-book jobs; orphan sweep scheduled',
  );
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
