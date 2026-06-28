import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '@/db';
import { assets, events, stories, user } from '@/db/schema';

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
  eventId: stories.eventId,
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

/** Photo counts per story for a chronicle (for thumbnails/badges in lists). */
export async function listPhotoCounts(chronicleId: string) {
  return db
    .select({ storyId: assets.storyId, count: sql<number>`count(*)::int` })
    .from(assets)
    .innerJoin(stories, eq(assets.storyId, stories.id))
    .where(and(eq(stories.chronicleId, chronicleId), eq(assets.kind, 'photo')))
    .groupBy(assets.storyId);
}

/** Minimal {id,title} list of other stories (for the "link another telling" picker). */
export async function listStoryOptions(chronicleId: string, excludeStoryId: string) {
  return db
    .select({ id: stories.id, title: stories.title })
    .from(stories)
    .where(and(eq(stories.chronicleId, chronicleId), ne(stories.id, excludeStoryId)))
    .orderBy(desc(stories.createdAt));
}

/** Sibling stories sharing an event (other tellings of the same occurrence). */
export async function listEventSiblings(
  chronicleId: string,
  eventId: string,
  excludeStoryId: string,
) {
  return db
    .select({ id: stories.id, title: stories.title, status: stories.status })
    .from(stories)
    .where(
      and(
        eq(stories.chronicleId, chronicleId),
        eq(stories.eventId, eventId),
        ne(stories.id, excludeStoryId),
      ),
    );
}

/** Link two stories as tellings of the same event (creating the event if needed). */
export async function linkStories(chronicleId: string, storyIdA: string, storyIdB: string) {
  return db.transaction(async (tx) => {
    const a = await tx.query.stories.findFirst({
      where: and(eq(stories.id, storyIdA), eq(stories.chronicleId, chronicleId)),
    });
    const b = await tx.query.stories.findFirst({
      where: and(eq(stories.id, storyIdB), eq(stories.chronicleId, chronicleId)),
    });
    if (!a || !b) throw new Error('Story not found');

    let eventId = a.eventId ?? b.eventId;
    if (!eventId) {
      const [ev] = await tx
        .insert(events)
        .values({
          chronicleId,
          title: a.title,
          approxDate: a.eventDate ?? b.eventDate ?? null,
        })
        .returning();
      eventId = ev.id;
    }

    await tx
      .update(stories)
      .set({ eventId, updatedAt: new Date() })
      .where(inArray(stories.id, [storyIdA, storyIdB]));
    return eventId;
  });
}

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
