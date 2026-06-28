'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { getMembership, canEdit } from '@/lib/chronicles';
import {
  addPhotos,
  createTextStory,
  createVoiceStory,
  getStoryWithSubmitter,
  resetStoryForRetry,
  type PhotoInput,
} from '@/lib/stories';
import { enqueueStyle, enqueueTranscribe } from '@/lib/queue';
import { buildKey, presignPut } from '@/lib/s3';

async function requireEditor(chronicleId: string, userId: string) {
  const membership = await getMembership(chronicleId, userId);
  if (!membership || !canEdit(membership.role)) {
    throw new Error('You do not have permission to do that.');
  }
}

const photoInputSchema = z.object({
  s3Key: z.string().min(1),
  mimeType: z.string().min(1),
  bytes: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

const createSchema = z.object({
  chronicleId: z.string().uuid(),
  title: z.string().min(1, 'Give the story a title').max(200),
  body: z.string().min(1, 'Write something first').max(20000),
  eventDate: z.string().nullable().optional(),
  eventDatePrecision: z.enum(['day', 'month', 'year']).nullable().optional(),
  photos: z.array(photoInputSchema).max(20).optional(),
});

export async function createTextStoryAction(input: {
  chronicleId: string;
  title: string;
  body: string;
  eventDate?: string | null;
  eventDatePrecision?: 'day' | 'month' | 'year' | null;
  photos?: PhotoInput[];
}) {
  const user = await requireUser();
  const data = createSchema.parse(input);
  await requireEditor(data.chronicleId, user.id);

  const eventDate = data.eventDate ? new Date(data.eventDate) : null;
  const story = await createTextStory({
    chronicleId: data.chronicleId,
    userId: user.id,
    title: data.title.trim(),
    body: data.body.trim(),
    eventDate: eventDate && !Number.isNaN(eventDate.getTime()) ? eventDate : null,
    eventDatePrecision: eventDate ? data.eventDatePrecision ?? 'day' : null,
    photos: data.photos,
  });

  await enqueueStyle({ storyId: story.id });
  revalidatePath(`/chronicles/${data.chronicleId}`);
  redirect(`/chronicles/${data.chronicleId}/stories/${story.id}`);
}

const uploadSchema = z.object({
  chronicleId: z.string().uuid(),
  kind: z.enum(['audio', 'photo']),
  contentType: z.string().min(1).max(120),
  filename: z.string().min(1).max(200),
});

/** Authorize, then hand back a presigned URL the browser PUTs the file to. */
export async function createUploadUrlAction(input: {
  chronicleId: string;
  kind: 'audio' | 'photo';
  contentType: string;
  filename: string;
}): Promise<{ key: string; url: string }> {
  const user = await requireUser();
  const { chronicleId, kind, contentType, filename } = uploadSchema.parse(input);
  await requireEditor(chronicleId, user.id);

  const key = buildKey(`chronicles/${chronicleId}/${kind}`, filename);
  const url = await presignPut(key, contentType);
  return { key, url };
}

const voiceSchema = z.object({
  chronicleId: z.string().uuid(),
  title: z.string().min(1, 'Give the story a title').max(200),
  eventDate: z.string().nullable().optional(),
  eventDatePrecision: z.enum(['day', 'month', 'year']).nullable().optional(),
  s3Key: z.string().min(1),
  mimeType: z.string().min(1),
  bytes: z.number().int().nonnegative().optional(),
  durationSec: z.number().int().nonnegative().optional(),
  photos: z.array(photoInputSchema).max(20).optional(),
});

export async function createVoiceStoryAction(input: {
  chronicleId: string;
  title: string;
  eventDate?: string | null;
  eventDatePrecision?: 'day' | 'month' | 'year' | null;
  s3Key: string;
  mimeType: string;
  bytes?: number;
  durationSec?: number;
  photos?: PhotoInput[];
}) {
  const user = await requireUser();
  const data = voiceSchema.parse(input);
  await requireEditor(data.chronicleId, user.id);

  const eventDate = data.eventDate ? new Date(data.eventDate) : null;
  const { story, asset } = await createVoiceStory({
    chronicleId: data.chronicleId,
    userId: user.id,
    title: data.title.trim(),
    eventDate: eventDate && !Number.isNaN(eventDate.getTime()) ? eventDate : null,
    eventDatePrecision: eventDate ? data.eventDatePrecision ?? 'day' : null,
    s3Key: data.s3Key,
    mimeType: data.mimeType,
    bytes: data.bytes ?? null,
    durationSec: data.durationSec ?? null,
    photos: data.photos,
  });

  await enqueueTranscribe({ storyId: story.id, assetId: asset.id });
  revalidatePath(`/chronicles/${data.chronicleId}`);
  redirect(`/chronicles/${data.chronicleId}/stories/${story.id}`);
}

const addPhotosSchema = z.object({
  chronicleId: z.string().uuid(),
  storyId: z.string().uuid(),
  photos: z.array(photoInputSchema).min(1).max(20),
});

export async function addPhotosAction(input: {
  chronicleId: string;
  storyId: string;
  photos: PhotoInput[];
}) {
  const user = await requireUser();
  const data = addPhotosSchema.parse(input);
  await requireEditor(data.chronicleId, user.id);

  const story = await getStoryWithSubmitter(data.chronicleId, data.storyId);
  if (!story) throw new Error('Story not found');

  await addPhotos(data.storyId, data.photos);
  revalidatePath(`/chronicles/${data.chronicleId}/stories/${data.storyId}`);
}

export async function retryStylingAction(input: { chronicleId: string; storyId: string }) {
  const user = await requireUser();
  await requireEditor(input.chronicleId, user.id);

  const story = await getStoryWithSubmitter(input.chronicleId, input.storyId);
  if (!story) throw new Error('Story not found');

  await resetStoryForRetry(story.id);
  await enqueueStyle({ storyId: story.id });
  revalidatePath(`/chronicles/${input.chronicleId}/stories/${input.storyId}`);
}
