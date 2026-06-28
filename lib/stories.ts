import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { assets, stories, user } from '@/db/schema';

export type DatePrecision = 'day' | 'month' | 'year' | 'circa';

export interface PhotoInput {
  s3Key: string;
  mimeType: string;
  bytes?: number | null;
  width?: number | null;
  height?: number | null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function photoAssetValues(storyId: string, photos: PhotoInput[]) {
  return photos.map((p) => ({
    storyId,
    kind: 'photo' as const,
    s3Key: p.s3Key,
    mimeType: p.mimeType,
    bytes: p.bytes ?? null,
    width: p.width ?? null,
    height: p.height ?? null,
  }));
}

async function insertPhotoAssets(tx: Tx, storyId: string, photos: PhotoInput[]) {
  if (photos.length === 0) return;
  await tx.insert(assets).values(photoAssetValues(storyId, photos));
}

export async function createTextStory(input: {
  chronicleId: string;
  userId: string;
  title: string;
  body: string;
  eventDate: Date | null;
  eventDatePrecision: DatePrecision | null;
  photos?: PhotoInput[];
}) {
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(stories)
      .values({
        chronicleId: input.chronicleId,
        submittedBy: input.userId,
        title: input.title,
        bodyOriginal: input.body,
        inputType: 'text',
        status: 'processing',
        eventDate: input.eventDate,
        eventDatePrecision: input.eventDatePrecision,
      })
      .returning();
    await insertPhotoAssets(tx, created.id, input.photos ?? []);
    return created;
  });
}

/** Attach photos to an existing story (used from the story detail page). */
export async function addPhotos(storyId: string, photos: PhotoInput[]) {
  if (photos.length === 0) return;
  await db.insert(assets).values(photoAssetValues(storyId, photos));
}

/** Create a voice story plus its audio asset (atomic). */
export async function createVoiceStory(input: {
  chronicleId: string;
  userId: string;
  title: string;
  eventDate: Date | null;
  eventDatePrecision: DatePrecision | null;
  s3Key: string;
  mimeType: string;
  bytes?: number | null;
  durationSec?: number | null;
  photos?: PhotoInput[];
}) {
  return db.transaction(async (tx) => {
    const [story] = await tx
      .insert(stories)
      .values({
        chronicleId: input.chronicleId,
        submittedBy: input.userId,
        title: input.title,
        inputType: 'voice',
        status: 'processing',
        eventDate: input.eventDate,
        eventDatePrecision: input.eventDatePrecision,
      })
      .returning();

    const [asset] = await tx
      .insert(assets)
      .values({
        storyId: story.id,
        kind: 'audio',
        s3Key: input.s3Key,
        mimeType: input.mimeType,
        bytes: input.bytes ?? null,
        durationSec: input.durationSec ?? null,
      })
      .returning();

    await insertPhotoAssets(tx, story.id, input.photos ?? []);
    return { story, asset };
  });
}

/** All assets for a story (audio + photos). */
export async function listAssets(storyId: string) {
  return db.select().from(assets).where(eq(assets.storyId, storyId));
}

const storyListColumns = {
  id: stories.id,
  title: stories.title,
  status: stories.status,
  inputType: stories.inputType,
  bodyOriginal: stories.bodyOriginal,
  bodyStyled: stories.bodyStyled,
  eventDate: stories.eventDate,
  eventDatePrecision: stories.eventDatePrecision,
  createdAt: stories.createdAt,
  submitterName: user.name,
};

export async function listStories(chronicleId: string) {
  return db
    .select(storyListColumns)
    .from(stories)
    .innerJoin(user, eq(stories.submittedBy, user.id))
    .where(eq(stories.chronicleId, chronicleId))
    .orderBy(desc(stories.createdAt));
}

export type StoryListItem = Awaited<ReturnType<typeof listStories>>[number];

/** A single story scoped to its chronicle (404 guard), with submitter name. */
export async function getStoryWithSubmitter(chronicleId: string, storyId: string) {
  const rows = await db
    .select({
      ...storyListColumns,
      errorMessage: stories.errorMessage,
      submittedBy: stories.submittedBy,
    })
    .from(stories)
    .innerJoin(user, eq(stories.submittedBy, user.id))
    .where(and(eq(stories.id, storyId), eq(stories.chronicleId, chronicleId)))
    .limit(1);
  return rows[0];
}

export async function resetStoryForRetry(storyId: string) {
  await db
    .update(stories)
    .set({ status: 'processing', errorMessage: null, updatedAt: new Date() })
    .where(eq(stories.id, storyId));
}
