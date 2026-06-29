'use server';

import { revalidatePath } from 'next/cache';
import { resetStoryForRetry, shareStoryToFamily } from '@/lib/stories';
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
