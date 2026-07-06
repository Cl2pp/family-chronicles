import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  assets,
  families,
  memberships,
  stories,
  storyFamilies,
  storyPeople,
  user,
} from '@/db/schema';
import { yearToDate } from '@/lib/dates';

export type DatePrecision = 'day' | 'month' | 'year' | 'circa';
export type InputType = 'text' | 'voice' | 'chat';
export type StoryStatus = 'draft' | 'processing' | 'ready' | 'failed';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function linkFamiliesAndPeople(
  tx: Tx,
  storyId: string,
  userId: string,
  familyIds: string[],
  personIds: string[],
) {
  if (familyIds.length) {
    await tx
      .insert(storyFamilies)
      .values(familyIds.map((familyId) => ({ storyId, familyId, sharedBy: userId })))
      .onConflictDoNothing();
  }
  if (personIds.length) {
    await tx
      .insert(storyPeople)
      .values(personIds.map((personId) => ({ storyId, personId })))
      .onConflictDoNothing();
  }
}

/** Create a story shared into one or more families. */
export async function createStory(input: {
  userId: string;
  title: string;
  summary?: string | null;
  bodyOriginal?: string | null;
  bodyStyled?: string | null;
  inputType: InputType;
  status: StoryStatus;
  eventDate?: Date | null;
  eventDatePrecision?: DatePrecision | null;
  conversationId?: string | null;
  familyIds: string[];
  personIds?: string[];
}) {
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(stories)
      .values({
        submittedBy: input.userId,
        title: input.title,
        summary: input.summary ?? null,
        bodyOriginal: input.bodyOriginal ?? null,
        bodyStyled: input.bodyStyled ?? null,
        inputType: input.inputType,
        status: input.status,
        eventDate: input.eventDate ?? null,
        eventDatePrecision: input.eventDatePrecision ?? null,
        conversationId: input.conversationId ?? null,
      })
      .returning();
    await linkFamiliesAndPeople(
      tx,
      created.id,
      input.userId,
      input.familyIds,
      input.personIds ?? [],
    );
    return created;
  });
}

/** Share an existing story into another family. */
export async function shareStoryToFamily(storyId: string, familyId: string, userId: string) {
  await db
    .insert(storyFamilies)
    .values({ storyId, familyId, sharedBy: userId })
    .onConflictDoNothing();
}

export interface AssetInput {
  kind: 'audio' | 'photo';
  s3Key: string;
  mimeType: string;
  bytes?: number | null;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
}

/** Persist audio/photo assets for a story (e.g. copied from an accepted chat). */
export async function addStoryAssets(storyId: string, items: AssetInput[]) {
  if (items.length === 0) return;
  await db.insert(assets).values(
    items.map((a) => ({
      storyId,
      kind: a.kind,
      s3Key: a.s3Key,
      mimeType: a.mimeType,
      bytes: a.bytes ?? null,
      width: a.width ?? null,
      height: a.height ?? null,
      durationSec: a.durationSec ?? null,
    })),
  );
}

export async function listAssets(storyId: string) {
  return db.select().from(assets).where(eq(assets.storyId, storyId));
}

const storyListColumns = {
  id: stories.id,
  title: stories.title,
  summary: stories.summary,
  status: stories.status,
  inputType: stories.inputType,
  bodyOriginal: stories.bodyOriginal,
  bodyStyled: stories.bodyStyled,
  eventDate: stories.eventDate,
  eventDatePrecision: stories.eventDatePrecision,
  createdAt: stories.createdAt,
  submitterName: user.name,
};

export interface StoryListItem {
  id: string;
  title: string;
  summary: string | null;
  status: StoryStatus;
  inputType: InputType;
  bodyOriginal: string | null;
  bodyStyled: string | null;
  eventDate: Date | null;
  eventDatePrecision: DatePrecision | null;
  createdAt: Date;
  submitterName: string;
  familyIds: string[];
  photoCount: number;
}

type StoryRow = Omit<StoryListItem, 'familyIds' | 'photoCount'>;

async function decorateStories(rows: StoryRow[]): Promise<StoryListItem[]> {
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];

  const fam = await db
    .select({ storyId: storyFamilies.storyId, familyId: storyFamilies.familyId })
    .from(storyFamilies)
    .where(inArray(storyFamilies.storyId, ids));
  const famByStory = new Map<string, string[]>();
  for (const f of fam) {
    const arr = famByStory.get(f.storyId) ?? [];
    arr.push(f.familyId);
    famByStory.set(f.storyId, arr);
  }

  const photos = await db
    .select({ storyId: assets.storyId, count: sql<number>`count(*)::int` })
    .from(assets)
    .where(and(inArray(assets.storyId, ids), eq(assets.kind, 'photo')))
    .groupBy(assets.storyId);
  const photoByStory = new Map(photos.map((p) => [p.storyId, p.count]));

  return rows.map((r) => ({
    ...r,
    familyIds: famByStory.get(r.id) ?? [],
    photoCount: photoByStory.get(r.id) ?? 0,
  }));
}

/** Stories across every family the user belongs to (deduped). */
export async function listStoriesForUser(userId: string): Promise<StoryListItem[]> {
  const fams = await db
    .select({ familyId: memberships.familyId })
    .from(memberships)
    .where(eq(memberships.userId, userId));
  const familyIds = fams.map((f) => f.familyId);
  if (familyIds.length === 0) return [];

  const rows = (await db
    .selectDistinct(storyListColumns)
    .from(storyFamilies)
    .innerJoin(stories, eq(storyFamilies.storyId, stories.id))
    .innerJoin(user, eq(stories.submittedBy, user.id))
    .where(inArray(storyFamilies.familyId, familyIds))
    .orderBy(desc(stories.createdAt))) as StoryRow[];
  return decorateStories(rows);
}

/** Families a story is shared into (id + name), for chips. */
export async function familiesForStory(storyId: string) {
  return db
    .select({ id: families.id, name: families.name })
    .from(storyFamilies)
    .innerJoin(families, eq(storyFamilies.familyId, families.id))
    .where(eq(storyFamilies.storyId, storyId));
}

/** A story with submitter, gated to users who can access ≥1 of its families. */
export async function getStoryForUser(storyId: string, userId: string) {
  const rows = await db
    .select({
      ...storyListColumns,
      errorMessage: stories.errorMessage,
      submittedBy: stories.submittedBy,
      conversationId: stories.conversationId,
    })
    .from(stories)
    .innerJoin(user, eq(stories.submittedBy, user.id))
    .where(eq(stories.id, storyId))
    .limit(1);
  const story = rows[0];
  if (!story) return null;

  const access = await db
    .select({ id: storyFamilies.id })
    .from(storyFamilies)
    .innerJoin(memberships, eq(storyFamilies.familyId, memberships.familyId))
    .where(and(eq(storyFamilies.storyId, storyId), eq(memberships.userId, userId)))
    .limit(1);
  if (access.length === 0) return null;

  return story;
}

/** Whether the user may edit a story: its submitter, or an owner of a family it's shared into. */
export async function canUserEditStory(storyId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ submittedBy: stories.submittedBy })
    .from(stories)
    .where(eq(stories.id, storyId))
    .limit(1);
  const story = rows[0];
  if (!story) return false;
  if (story.submittedBy === userId) return true;

  const owner = await db
    .select({ id: storyFamilies.id })
    .from(storyFamilies)
    .innerJoin(memberships, eq(storyFamilies.familyId, memberships.familyId))
    .where(
      and(
        eq(storyFamilies.storyId, storyId),
        eq(memberships.userId, userId),
        eq(memberships.accessRole, 'owner'),
      ),
    )
    .limit(1);
  return owner.length > 0;
}

/**
 * Apply a reviewed edit to a ready story. Only `bodyStyled` (+ title/summary/date) change;
 * `bodyOriginal` and assets stay untouched as the raw source. A finer-grained event date
 * (day/month/circa) is preserved when the year itself didn't change.
 */
export async function applyStoryEdit(input: {
  storyId: string;
  userId: string;
  title: string;
  summary: string | null;
  body: string;
  eventYear: number | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await canUserEditStory(input.storyId, input.userId))) {
    return { ok: false, error: "Only the story's author or a family owner can edit it." };
  }
  const story = await getStoryForUser(input.storyId, input.userId);
  if (!story) return { ok: false, error: 'Story not found.' };
  if (story.status !== 'ready') {
    return { ok: false, error: 'This story can only be edited once it is ready.' };
  }

  const currentYear = story.eventDate ? story.eventDate.getUTCFullYear() : null;
  const set: Partial<typeof stories.$inferInsert> = {
    title: input.title.trim() || story.title,
    summary: input.summary,
    bodyStyled: input.body,
    updatedAt: new Date(),
  };
  if (input.eventYear !== currentYear) {
    set.eventDate = yearToDate(input.eventYear);
    set.eventDatePrecision = input.eventYear ? 'year' : null;
  }
  await db.update(stories).set(set).where(eq(stories.id, input.storyId));
  return { ok: true };
}

export async function resetStoryForRetry(storyId: string) {
  await db
    .update(stories)
    .set({ status: 'processing', errorMessage: null, updatedAt: new Date() })
    .where(eq(stories.id, storyId));
}

/** The styleGuide to use when styling a story: the first family it's shared into. */
export async function styleGuideForStory(storyId: string): Promise<string | null> {
  const rows = await db
    .select({ styleGuide: families.styleGuide })
    .from(storyFamilies)
    .innerJoin(families, eq(storyFamilies.familyId, families.id))
    .where(eq(storyFamilies.storyId, storyId))
    .orderBy(storyFamilies.sharedAt)
    .limit(1);
  return rows[0]?.styleGuide ?? null;
}
