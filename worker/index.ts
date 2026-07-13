import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { stories } from '@/db/schema';
import { getBoss, QUEUES, SWEEP_ORPHANS_CRON, type StyleJob, type TranscodeJob } from '@/lib/queue';
import { styleStory } from '@/lib/ai/openrouter';
import { styleContextForStory } from '@/lib/stories';
import { sweepOrphanedObjects } from '@/lib/orphans';
import { transcodeAudioObject } from '@/lib/transcode';

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

  await boss.work(QUEUES.sweepOrphans, async () => {
    await handleSweepOrphans();
  });
  await boss.schedule(QUEUES.sweepOrphans, SWEEP_ORPHANS_CRON);

  console.log('[worker] ready — listening for style + transcode jobs; orphan sweep scheduled');
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
