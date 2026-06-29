import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { stories } from '@/db/schema';
import { getBoss, QUEUES, type StyleJob } from '@/lib/queue';
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

  await boss.work<StyleJob>(QUEUES.style, async (jobs) => {
    for (const job of jobs) await handleStyle(job.data);
  });

  console.log('[worker] ready — listening for style jobs');
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
