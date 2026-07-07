'use server';

import { revalidatePath } from 'next/cache';
import { applyStoryEdit, resetStoryForRetry, shareStoryToChronicle } from '@/lib/stories';
import { enqueueStyle } from '@/lib/queue';
import { requireUser } from '@/lib/session';
import { getMembership } from '@/lib/chronicles';
import { canContribute, type AccessRole } from '@/lib/permissions';

/** Re-queue a failed story for styling and refresh its detail page. */
export async function retryStory(storyId: string) {
  await resetStoryForRetry(storyId);
  await enqueueStyle({ storyId });
  revalidatePath(`/stories/${storyId}`);
}

/** Save a manual edit of a story (title/summary/body/year) from its detail page. */
export async function updateStoryDetails(input: {
  storyId: string;
  title: string;
  summary: string;
  body: string;
  eventYear: number | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  const result = await applyStoryEdit({
    storyId: input.storyId,
    userId: user.id,
    title: input.title,
    summary: input.summary.trim() || null,
    body: input.body,
    eventYear: input.eventYear,
  });
  if (result.ok) {
    revalidatePath(`/stories/${input.storyId}`);
    revalidatePath('/stories');
  }
  return result;
}

/** Share an existing story into another chronicle (requires contributor+ in the target). */
export async function shareStory(storyId: string, chronicleId: string) {
  const user = await requireUser();
  const membership = await getMembership(chronicleId, user.id);
  if (!membership || !canContribute(membership.accessRole as AccessRole)) {
    throw new Error('You cannot share into that chronicle.');
  }
  await shareStoryToChronicle(storyId, chronicleId, user.id);
  revalidatePath(`/stories/${storyId}`);
}
