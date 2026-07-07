import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  assets,
  chronicles,
  memberships,
  messageAttachments,
  stories,
  storyChronicles,
  storyPeople,
  user,
} from '@/db/schema';
import { familyTagsByStory } from '@/lib/family-tags';
import { yearToDate } from '@/lib/dates';
import { deleteObject } from '@/lib/s3';

export type DatePrecision = 'day' | 'month' | 'year' | 'circa';
export type InputType = 'text' | 'voice' | 'chat';
export type StoryStatus = 'draft' | 'processing' | 'ready' | 'failed';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function linkChroniclesAndPeople(
  tx: Tx,
  storyId: string,
  userId: string,
  chronicleIds: string[],
  personIds: string[],
) {
  if (chronicleIds.length) {
    await tx
      .insert(storyChronicles)
      .values(chronicleIds.map((chronicleId) => ({ storyId, chronicleId, sharedBy: userId })))
      .onConflictDoNothing();
  }
  if (personIds.length) {
    await tx
      .insert(storyPeople)
      .values(personIds.map((personId) => ({ storyId, personId })))
      .onConflictDoNothing();
  }
}

/** Create a story shared into one or more chronicles. */
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
  chronicleIds: string[];
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
    await linkChroniclesAndPeople(
      tx,
      created.id,
      input.userId,
      input.chronicleIds,
      input.personIds ?? [],
    );
    return created;
  });
}

/** Share an existing story into another chronicle. */
export async function shareStoryToChronicle(storyId: string, chronicleId: string, userId: string) {
  await db
    .insert(storyChronicles)
    .values({ storyId, chronicleId, sharedBy: userId })
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
  chronicleIds: string[];
  /** Derived family tags: the union of the tags of everyone in the story. */
  familyTags: string[];
  photoCount: number;
}

type StoryRow = Omit<StoryListItem, 'chronicleIds' | 'familyTags' | 'photoCount'>;

async function decorateStories(rows: StoryRow[]): Promise<StoryListItem[]> {
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];

  const fam = await db
    .select({ storyId: storyChronicles.storyId, chronicleId: storyChronicles.chronicleId })
    .from(storyChronicles)
    .where(inArray(storyChronicles.storyId, ids));
  const chronByStory = new Map<string, string[]>();
  for (const f of fam) {
    const arr = chronByStory.get(f.storyId) ?? [];
    arr.push(f.chronicleId);
    chronByStory.set(f.storyId, arr);
  }

  const photos = await db
    .select({ storyId: assets.storyId, count: sql<number>`count(*)::int` })
    .from(assets)
    .where(and(inArray(assets.storyId, ids), eq(assets.kind, 'photo')))
    .groupBy(assets.storyId);
  const photoByStory = new Map(photos.map((p) => [p.storyId, p.count]));

  const tagsByStory = await familyTagsByStory(ids);

  return rows.map((r) => ({
    ...r,
    chronicleIds: chronByStory.get(r.id) ?? [],
    familyTags: tagsByStory.get(r.id) ?? [],
    photoCount: photoByStory.get(r.id) ?? 0,
  }));
}

/** Stories across every chronicle the user belongs to (deduped). */
export async function listStoriesForUser(userId: string): Promise<StoryListItem[]> {
  const fams = await db
    .select({ chronicleId: memberships.chronicleId })
    .from(memberships)
    .where(eq(memberships.userId, userId));
  const chronicleIds = fams.map((f) => f.chronicleId);
  if (chronicleIds.length === 0) return [];

  const rows = (await db
    .selectDistinct(storyListColumns)
    .from(storyChronicles)
    .innerJoin(stories, eq(storyChronicles.storyId, stories.id))
    .innerJoin(user, eq(stories.submittedBy, user.id))
    .where(inArray(storyChronicles.chronicleId, chronicleIds))
    .orderBy(desc(stories.createdAt))) as StoryRow[];
  return decorateStories(rows);
}

/** Lightweight text of every story shared into a chronicle, for duplicate checks. */
export async function listChronicleStoryTexts(chronicleId: string) {
  return db
    .select({
      id: stories.id,
      title: stories.title,
      summary: stories.summary,
      bodyOriginal: stories.bodyOriginal,
      bodyStyled: stories.bodyStyled,
      eventDate: stories.eventDate,
      submittedBy: stories.submittedBy,
    })
    .from(storyChronicles)
    .innerJoin(stories, eq(storyChronicles.storyId, stories.id))
    .where(eq(storyChronicles.chronicleId, chronicleId));
}

/** Chronicles a story is shared into (id + name), for chips. */
export async function chroniclesForStory(storyId: string) {
  return db
    .select({ id: chronicles.id, name: chronicles.name })
    .from(storyChronicles)
    .innerJoin(chronicles, eq(storyChronicles.chronicleId, chronicles.id))
    .where(eq(storyChronicles.storyId, storyId));
}

/** A story with submitter, gated to users who can access ≥1 of its chronicles. */
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
    .select({ id: storyChronicles.id })
    .from(storyChronicles)
    .innerJoin(memberships, eq(storyChronicles.chronicleId, memberships.chronicleId))
    .where(and(eq(storyChronicles.storyId, storyId), eq(memberships.userId, userId)))
    .limit(1);
  if (access.length === 0) return null;

  return story;
}

/** Whether the user may edit a story: its submitter, or an owner of a chronicle it's shared into. */
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
    .select({ id: storyChronicles.id })
    .from(storyChronicles)
    .innerJoin(memberships, eq(storyChronicles.chronicleId, memberships.chronicleId))
    .where(
      and(
        eq(storyChronicles.storyId, storyId),
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
    return { ok: false, error: "Only the story's author or a chronicle owner can edit it." };
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

/**
 * Permanently delete a story (rows cascade: shares, people links, assets).
 * Stored objects are removed too, except ones still referenced by chat
 * attachments — those must keep rendering in the conversation history.
 */
export async function deleteStoryForUser(
  storyId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await canUserEditStory(storyId, userId))) {
    return { ok: false, error: "Only the story's author or a chronicle owner can delete it." };
  }
  const storyAssets = await listAssets(storyId);
  await db.delete(stories).where(eq(stories.id, storyId));

  const keys = [...new Set(storyAssets.map((a) => a.s3Key))];
  if (keys.length) {
    const referenced = await db
      .select({ s3Key: messageAttachments.s3Key })
      .from(messageAttachments)
      .where(inArray(messageAttachments.s3Key, keys));
    const keep = new Set(referenced.map((r) => r.s3Key));
    const results = await Promise.allSettled(
      keys.filter((k) => !keep.has(k)).map((k) => deleteObject(k)),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error(`Failed to delete stored object for story ${storyId}:`, r.reason);
      }
    }
  }
  return { ok: true };
}

export async function resetStoryForRetry(storyId: string) {
  await db
    .update(stories)
    .set({ status: 'processing', errorMessage: null, updatedAt: new Date() })
    .where(eq(stories.id, storyId));
}

/** Styling context (style guide + story language) from the first chronicle a story is shared into. */
export async function styleContextForStory(
  storyId: string,
): Promise<{ styleGuide: string | null; storyLanguage: string | null }> {
  const rows = await db
    .select({ styleGuide: chronicles.styleGuide, storyLanguage: chronicles.storyLanguage })
    .from(storyChronicles)
    .innerJoin(chronicles, eq(storyChronicles.chronicleId, chronicles.id))
    .where(eq(storyChronicles.storyId, storyId))
    .orderBy(storyChronicles.sharedAt)
    .limit(1);
  return {
    styleGuide: rows[0]?.styleGuide ?? null,
    storyLanguage: rows[0]?.storyLanguage ?? null,
  };
}
