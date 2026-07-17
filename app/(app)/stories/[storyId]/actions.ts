'use server';

import { revalidatePath } from 'next/cache';
import {
  addPeopleToStory,
  addStoryPhotoContribution,
  applyStoryEdit,
  canUserEditStory,
  deleteStoryForUser,
  getStoryForUser,
  listStoryPeople,
  listStoryPeopleCandidates,
  removePeopleFromStory,
  resetStoryForRetry,
  setAssetCaption,
  shareStoryToChronicle,
} from '@/lib/stories';
import { enqueueStyle } from '@/lib/queue';
import { requireUser } from '@/lib/session';
import { getMembership } from '@/lib/chronicles';
import { canContribute, type AccessRole } from '@/lib/permissions';
import { buildKey, presignPut } from '@/lib/s3';
import { validateUpload } from '@/lib/uploads';
import { getPostHogClient } from '@/lib/posthog-server';

/** Re-queue a failed story for styling and refresh its detail page. */
export async function retryStory(storyId: string) {
  const user = await requireUser();
  if (!(await canUserEditStory(storyId, user.id))) {
    throw new Error('You cannot retry this story.');
  }
  await resetStoryForRetry(storyId);
  await enqueueStyle({ storyId });
  revalidatePath(`/stories/${storyId}`);
}

/** Save a manual edit of a story (title/summary/body/date) from its detail page. */
export async function updateStoryDetails(input: {
  storyId: string;
  title: string;
  summary: string;
  body: string;
  eventYear: number | null;
  eventMonth: number | null;
  eventDay: number | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  const result = await applyStoryEdit({
    storyId: input.storyId,
    userId: user.id,
    title: input.title,
    summary: input.summary.trim() || null,
    body: input.body,
    eventYear: input.eventYear,
    eventMonth: input.eventMonth,
    eventDay: input.eventDay,
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
  if (result.ok) {
    revalidatePath('/stories');
    const posthog = getPostHogClient();
    posthog.capture({ distinctId: user.id, event: 'story_deleted', properties: { storyId } });
    await posthog.flush();
  }
  return result;
}

/** A presigned URL the browser uses to PUT a new story photo straight to storage. */
export async function presignStoryPhotoUpload(input: {
  storyId: string;
  mimeType: string;
  bytes: number;
}): Promise<{ url: string; s3Key: string; mimeType: string }> {
  const user = await requireUser();
  if (!(await canUserEditStory(input.storyId, user.id))) {
    throw new Error("Only the story's author or a chronicle owner can add photos.");
  }
  const upload = validateUpload('photo', input.mimeType, input.bytes);
  const s3Key = buildKey('stories/photos', upload.ext);
  const url = await presignPut(s3Key, upload.mimeType, upload.bytes);
  return { url, s3Key, mimeType: upload.mimeType };
}

/** Attach already-uploaded photos to a story and refresh its pages. */
export async function addStoryPhotos(input: {
  storyId: string;
  photos: { s3Key: string; mimeType: string; bytes: number; width?: number; height?: number }[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  if (!(await canUserEditStory(input.storyId, user.id))) {
    return { ok: false, error: "Only the story's author or a chronicle owner can add photos." };
  }
  // The key must be one we signed for a story photo, not a guess at another object.
  if (input.photos.some((p) => !p.s3Key.startsWith('stories/photos/'))) {
    return { ok: false, error: 'Invalid upload.' };
  }
  await addStoryPhotoContribution(
    input.storyId,
    user.id,
    input.photos.map((p) => ({
      kind: 'photo' as const,
      s3Key: p.s3Key,
      mimeType: p.mimeType,
      bytes: p.bytes,
      width: p.width ?? null,
      height: p.height ?? null,
    })),
  );
  revalidatePath(`/stories/${input.storyId}`);
  revalidatePath('/stories');
  const posthog = getPostHogClient();
  posthog.capture({
    distinctId: user.id,
    event: 'story_photos_added',
    properties: { storyId: input.storyId, photo_count: input.photos.length },
  });
  await posthog.flush();
  return { ok: true };
}

/** Set or clear a photo's caption (author or chronicle owner only). */
export async function updatePhotoCaption(input: {
  storyId: string;
  assetId: string;
  caption: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  if (!(await canUserEditStory(input.storyId, user.id))) {
    return { ok: false, error: "Only the story's author or a chronicle owner can edit captions." };
  }
  const caption = input.caption.trim();
  await setAssetCaption(input.storyId, input.assetId, caption || null);
  revalidatePath(`/stories/${input.storyId}`);
  return { ok: true };
}

/**
 * Set exactly which tree members are tagged in a story (the "who's in this story"
 * picker). The story's family tags derive from these people. Editors only, and only
 * people who are in one of the story's chronicles may be tagged.
 */
export async function setStoryPeople(input: {
  storyId: string;
  personIds: string[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  if (!(await canUserEditStory(input.storyId, user.id))) {
    return {
      ok: false,
      error: "Only the story's author or a chronicle owner can change who is in it.",
    };
  }
  const current = (await listStoryPeople(input.storyId)).map((p) => p.id);
  // A new tag must be someone in one of the story's chronicles; already-tagged people
  // are always allowed to stay, even if they have since left the chronicle.
  const candidates = await listStoryPeopleCandidates(input.storyId, user.id);
  const allowed = new Set([...candidates.map((c) => c.id), ...current]);
  const desired = [...new Set(input.personIds)].filter((id) => allowed.has(id));

  const currentSet = new Set(current);
  const desiredSet = new Set(desired);

  const toAdd = desired.filter((id) => !currentSet.has(id));
  const toRemove = current.filter((id) => !desiredSet.has(id));

  await addPeopleToStory(input.storyId, toAdd);
  await removePeopleFromStory(input.storyId, toRemove);

  revalidatePath(`/stories/${input.storyId}`);
  revalidatePath('/stories');
  return { ok: true };
}

/** Share an existing story into another chronicle (requires contributor+ in the target). */
export async function shareStory(storyId: string, chronicleId: string) {
  const user = await requireUser();
  // The actor must be able to READ the story — otherwise a known story id could
  // be shared into one's own open chronicle to bypass the family read gate.
  if (!(await getStoryForUser(storyId, user.id))) {
    throw new Error('You cannot share this story.');
  }
  const membership = await getMembership(chronicleId, user.id);
  if (!membership || !canContribute(membership.accessRole as AccessRole)) {
    throw new Error('You cannot share into that chronicle.');
  }
  await shareStoryToChronicle(storyId, chronicleId, user.id);
  revalidatePath(`/stories/${storyId}`);
}
