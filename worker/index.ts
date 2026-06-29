import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { assets, stories } from '@/db/schema';
import { getBoss, QUEUES, enqueueStyle, type TranscribeJob, type StyleJob } from '@/lib/queue';
import { getObjectBuffer } from '@/lib/s3';
import { transcribeAudio } from '@/lib/ai/groq';
import { styleStory } from '@/lib/ai/openrouter';
import { styleGuideForStory } from '@/lib/stories';

async function markFailed(storyId: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[worker] story ${storyId} failed:`, message);
  await db
    .update(stories)
    .set({ status: 'failed', errorMessage: message, updatedAt: new Date() })
    .where(eq(stories.id, storyId));
}

/** Transcribe a voice asset, store the transcript, then queue styling. */
async function handleTranscribe(data: TranscribeJob) {
  const { storyId, assetId } = data;
  try {
    const asset = await db.query.assets.findFirst({ where: eq(assets.id, assetId) });
    if (!asset) throw new Error(`Asset ${assetId} not found`);

    const buffer = await getObjectBuffer(asset.s3Key);
    const filename = asset.s3Key.split('/').pop() ?? 'audio';
    const transcript = await transcribeAudio(buffer, filename, asset.mimeType);

    await db
      .update(stories)
      .set({ bodyOriginal: transcript, updatedAt: new Date() })
      .where(eq(stories.id, storyId));

    await enqueueStyle({ storyId });
    console.log(`[worker] transcribed story ${storyId}`);
  } catch (err) {
    await markFailed(storyId, err);
  }
}

/** Rewrite a story's raw text into the family-memoir voice. */
async function handleStyle(data: StyleJob) {
  const { storyId } = data;
  try {
    const story = await db.query.stories.findFirst({ where: eq(stories.id, storyId) });
    if (!story) throw new Error(`Story ${storyId} not found`);
    if (!story.bodyOriginal?.trim()) throw new Error('No source text to style');

    const styleGuide = await styleGuideForStory(storyId);

    const styled = await styleStory({
      original: story.bodyOriginal,
      styleGuide,
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

async function main() {
  const boss = await getBoss();

  await boss.work<TranscribeJob>(QUEUES.transcribe, async (jobs) => {
    for (const job of jobs) await handleTranscribe(job.data);
  });

  await boss.work<StyleJob>(QUEUES.style, async (jobs) => {
    for (const job of jobs) await handleStyle(job.data);
  });

  console.log('[worker] ready — listening for transcribe + style jobs');
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
