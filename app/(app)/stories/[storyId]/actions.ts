'use server';

import { revalidatePath } from 'next/cache';
import {
  addStoryAssets,
  applyStoryEdit,
  canUserEditStory,
  deleteStoryForUser,
  resetStoryForRetry,
  shareStoryToChronicle,
} from '@/lib/stories';
import { enqueueStyle } from '@/lib/queue';
import { requireUser } from '@/lib/session';
import { getMembership } from '@/lib/chronicles';
import { canContribute, type AccessRole } from '@/lib/permissions';
import { buildKey, presignPut } from '@/lib/s3';

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

/** Permanently delete a story (author or chronicle owner only). */
export async function deleteStory(
  storyId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  const result = await deleteStoryForUser(storyId, user.id);
  if (result.ok) revalidatePath('/stories');
  return result;
}

/** A presigned URL the browser uses to PUT a new story photo straight to storage. */
export async function presignStoryPhotoUpload(input: {
  storyId: string;
  mimeType: string;
  filename?: string;
}): Promise<{ url: string; s3Key: string }> {
  const user = await requireUser();
  if (!(await canUserEditStory(input.storyId, user.id))) {
    throw new Error("Only the story's author or a chronicle owner can add photos.");
  }
  const s3Key = buildKey('stories/photos', input.filename ?? input.mimeType.replace('/', '.'));
  const url = await presignPut(s3Key, input.mimeType);
  return { url, s3Key };
}

/** Attach already-uploaded photos to a story and refresh its pages. */
export async function addStoryPhotos(input: {
  storyId: string;
  photos: { s3Key: string; mimeType: string; bytes: number }[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  if (!(await canUserEditStory(input.storyId, user.id))) {
    return { ok: false, error: "Only the story's author or a chronicle owner can add photos." };
  }
  await addStoryAssets(
    input.storyId,
    input.photos.map((p) => ({ kind: 'photo' as const, ...p })),
  );
  revalidatePath(`/stories/${input.storyId}`);
  revalidatePath('/stories');
  return { ok: true };
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
