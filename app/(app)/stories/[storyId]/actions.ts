'use server';

import { revalidatePath } from 'next/cache';
import { applyStoryEdit, resetStoryForRetry, shareStoryToFamily } from '@/lib/stories';
import { enqueueStyle } from '@/lib/queue';
import { requireUser } from '@/lib/session';
import { getMembership } from '@/lib/families';
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

/** Share an existing story into another family (requires contributor+ in the target). */
export async function shareStory(storyId: string, familyId: string) {
  const user = await requireUser();
  const membership = await getMembership(familyId, user.id);
  if (!membership || !canContribute(membership.accessRole as AccessRole)) {
    throw new Error('You cannot share into that family.');
  }
  await shareStoryToFamily(storyId, familyId, user.id);
  revalidatePath(`/stories/${storyId}`);
}
