import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/db';
import {
  assets,
  chronicles,
  contributions,
  memberships,
  messageAttachments,
  messages,
  people,
  stories,
  storyPeople,
  user,
} from '@/db/schema';
import { familyTagsByStory } from '@/lib/family-tags';
import {
  canReadStory,
  loadStoryAccessContext,
  type StoryAccessContext,
  type StoryAccessInput,
} from '@/lib/story-access';
import { eventDateToParts, partsToEventDate } from '@/lib/dates';
import { deleteObject, presignGet } from '@/lib/s3';
import { enqueueThumbnail } from '@/lib/queue';
import { invalidateBooksForStory, mirrorStoryPhotosIntoBooks } from '@/lib/books';

export type DatePrecision = 'day' | 'month' | 'year' | 'circa';
export type InputType = 'text' | 'voice' | 'chat';
export type StoryStatus = 'draft' | 'processing' | 'ready' | 'failed';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function linkPeopleToStory(tx: Tx, storyId: string, personIds: string[]) {
  if (personIds.length === 0) return;
  await tx
    .insert(storyPeople)
    .values(personIds.map((personId) => ({ storyId, personId })))
    .onConflictDoNothing();
}

/** Create a story in its chronicle. */
export async function createStory(input: {
  userId: string;
  chronicleId: string;
  title: string;
  summary?: string | null;
  bodyOriginal?: string | null;
  bodyStyled?: string | null;
  inputType: InputType;
  status: StoryStatus;
  eventDate?: Date | null;
  eventDatePrecision?: DatePrecision | null;
  conversationId?: string | null;
  personIds?: string[];
}) {
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(stories)
      .values({
        chronicleId: input.chronicleId,
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
    await linkPeopleToStory(tx, created.id, input.personIds ?? []);
    // The initial source material is the first entry of the story's contribution timeline.
    if (input.bodyOriginal?.trim()) {
      await tx.insert(contributions).values({
        storyId: created.id,
        contributedBy: input.userId,
        text: input.bodyOriginal.trim(),
      });
    }
    return created;
  });
}

/** People tagged in a story (they drive the story's derived family tags). */
export async function listStoryPeople(storyId: string) {
  return db
    .select({
      id: people.id,
      firstName: people.firstName,
      familyName: people.familyName,
      // Matching qualifies by the surname at birth too ("Frieda Loges") — without it
      // here, untagging a person could be ambiguous where tagging them was not.
      birthFamilyName: people.birthFamilyName,
    })
    .from(storyPeople)
    .innerJoin(people, eq(storyPeople.personId, people.id))
    .where(eq(storyPeople.storyId, storyId))
    .orderBy(asc(people.firstName));
}

/**
 * People a given user may tag in a story: the tree members of the story's chronicle,
 * gated to users who are themselves a member of it. The currently tagged subset comes
 * from {@link listStoryPeople}.
 */
export async function listStoryPeopleCandidates(storyId: string, userId: string) {
  const rows = await db
    .selectDistinct({
      id: people.id,
      firstName: people.firstName,
      familyName: people.familyName,
      birthFamilyName: people.birthFamilyName,
    })
    .from(stories)
    .innerJoin(
      memberships,
      and(eq(memberships.chronicleId, stories.chronicleId), eq(memberships.userId, userId)),
    )
    .innerJoin(people, eq(people.chronicleId, stories.chronicleId))
    .where(eq(stories.id, storyId))
    .orderBy(asc(people.firstName));
  return rows;
}

/** Tag people in an existing story. Already-tagged people are skipped. */
export async function addPeopleToStory(storyId: string, personIds: string[]) {
  if (personIds.length === 0) return;
  await db
    .insert(storyPeople)
    .values(personIds.map((personId) => ({ storyId, personId })))
    .onConflictDoNothing();
}

/** Remove people tags from a story (the people themselves are untouched). */
export async function removePeopleFromStory(storyId: string, personIds: string[]) {
  if (personIds.length === 0) return;
  await db
    .delete(storyPeople)
    .where(and(eq(storyPeople.storyId, storyId), inArray(storyPeople.personId, personIds)));
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

function assetRows(storyId: string, items: AssetInput[], contributionId: string | null) {
  return items.map((a) => ({
    storyId,
    contributionId,
    kind: a.kind,
    s3Key: a.s3Key,
    mimeType: a.mimeType,
    bytes: a.bytes ?? null,
    width: a.width ?? null,
    height: a.height ?? null,
    durationSec: a.durationSec ?? null,
  }));
}

/**
 * Persist photos added on the story page as their own contribution, so the
 * source-material timeline shows who added them and when.
 */
export async function addStoryPhotoContribution(
  storyId: string,
  userId: string,
  items: AssetInput[],
) {
  if (items.length === 0) return;
  await db.transaction(async (tx) => {
    const [contribution] = await tx
      .insert(contributions)
      .values({ storyId, contributedBy: userId, text: null })
      .returning();
    await tx
      .insert(assets)
      .values(assetRows(storyId, items, contribution.id))
      .onConflictDoNothing();
  });
  await enqueuePhotoThumbnails(items);
  // Photos added to a story AFTER it was put in a book still belong in that book —
  // mirror them so they reach the shared analysis + layout pipeline.
  await mirrorStoryPhotosIntoBooks(storyId);
}

/** Queue thumbnail generation for freshly linked photo assets. */
async function enqueuePhotoThumbnails(items: { kind: string; s3Key: string }[]) {
  for (const item of items) {
    if (item.kind === 'photo') await enqueueThumbnail({ s3Key: item.s3Key });
  }
}

/**
 * Move a chat's not-yet-claimed uploads onto a story, oldest first.
 *
 * One conversation can produce several stories. Copying *every* attachment each time
 * would hand story #2 the photos — and every voice note — that belonged to story #1, so
 * each attachment is claimed exactly once, by the first story accepted after it was sent.
 * Claim and insert share a transaction; neither happens without the other.
 *
 * Claimed assets are linked to the story's newest contribution (the one the accept or
 * revision that triggered this claim just wrote); if the save carried no new text, a
 * media-only contribution by `contributorId` is created so the uploads still show
 * who/when on the source timeline.
 */
export async function claimChatAssetsForStory(
  conversationId: string,
  storyId: string,
  contributorId: string,
) {
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: messageAttachments.id,
        kind: messageAttachments.kind,
        s3Key: messageAttachments.s3Key,
        mimeType: messageAttachments.mimeType,
        bytes: messageAttachments.bytes,
        width: messageAttachments.width,
        height: messageAttachments.height,
        durationSec: messageAttachments.durationSec,
      })
      .from(messageAttachments)
      .innerJoin(messages, eq(messageAttachments.messageId, messages.id))
      .where(and(eq(messages.conversationId, conversationId), isNull(messageAttachments.storyId)))
      .orderBy(asc(messageAttachments.createdAt));
    if (rows.length === 0) return [];

    const [latest] = await tx
      .select({ id: contributions.id })
      .from(contributions)
      .where(eq(contributions.storyId, storyId))
      .orderBy(desc(contributions.createdAt))
      .limit(1);
    let contributionId = latest?.id ?? null;
    if (!contributionId) {
      const [created] = await tx
        .insert(contributions)
        .values({ storyId, contributedBy: contributorId, text: null })
        .returning();
      contributionId = created.id;
    }

    await tx
      .update(messageAttachments)
      .set({ storyId })
      .where(
        inArray(
          messageAttachments.id,
          rows.map((r) => r.id),
        ),
      );
    await tx.insert(assets).values(assetRows(storyId, rows, contributionId)).onConflictDoNothing();
    return rows;
  });
  await enqueuePhotoThumbnails(claimed);
  if (claimed.length > 0) await mirrorStoryPhotosIntoBooks(storyId);
}

export async function listAssets(storyId: string) {
  return db.select().from(assets).where(eq(assets.storyId, storyId)).orderBy(asc(assets.createdAt));
}

/** Set or clear a photo's caption. The story id scopes it — callers check edit rights. */
export async function setAssetCaption(storyId: string, assetId: string, caption: string | null) {
  await db
    .update(assets)
    .set({ caption })
    .where(and(eq(assets.id, assetId), eq(assets.storyId, storyId)));
}

const storyListColumns = {
  id: stories.id,
  chronicleId: stories.chronicleId,
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
  chronicleId: string;
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
  /** Derived family tags: the union of the tags of everyone in the story. */
  familyTags: string[];
  photoCount: number;
  /** Presigned URLs of the story's first photos (upload order), for list banners. */
  bannerPhotoUrls: string[];
}

type StoryRow = Omit<StoryListItem, 'familyTags' | 'photoCount' | 'bannerPhotoUrls'>;

/** How many photos a story-list banner shows at most. */
const BANNER_PHOTO_LIMIT = 3;

async function decorateStories(rows: StoryRow[]): Promise<StoryListItem[]> {
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];

  const photos = await db
    .select({
      storyId: assets.storyId,
      s3Key: assets.s3Key,
      thumbS3Key: assets.thumbS3Key,
      mimeType: assets.mimeType,
    })
    .from(assets)
    .where(and(inArray(assets.storyId, ids), eq(assets.kind, 'photo')))
    .orderBy(asc(assets.createdAt));
  const photosByStory = new Map<string, (typeof photos)[number][]>();
  for (const p of photos) {
    // `assets.storyId` is nullable (book-owned photos), but this query is filtered to
    // `storyId IN (ids)`, so it's never null in practice — the guard just satisfies
    // the type.
    if (!p.storyId) continue;
    const arr = photosByStory.get(p.storyId) ?? [];
    arr.push(p);
    photosByStory.set(p.storyId, arr);
  }
  const bannerByStory = new Map<string, string[]>();
  await Promise.all(
    [...photosByStory.entries()].map(async ([storyId, list]) => {
      const urls = await Promise.all(
        list
          .slice(0, BANNER_PHOTO_LIMIT)
          // Banners are small — serve the worker-generated thumbnail when it exists.
          .map((p) =>
            p.thumbS3Key ? presignGet(p.thumbS3Key, 'image/webp') : presignGet(p.s3Key, p.mimeType),
          ),
      );
      bannerByStory.set(storyId, urls);
    }),
  );

  const tagsByStory = await familyTagsByStory(ids);

  return rows.map((r) => ({
    ...r,
    familyTags: tagsByStory.get(r.id) ?? [],
    photoCount: photosByStory.get(r.id)?.length ?? 0,
    bannerPhotoUrls: bannerByStory.get(r.id) ?? [],
  }));
}

/**
 * True when the viewer reads every story of this chronicle without the kinship rule
 * having to run: they own the chronicle, or it's in 'open' mode.
 */
function readsWholeChronicle(ctx: StoryAccessContext): boolean {
  return ctx.isOwner || ctx.isOpenMode;
}

/**
 * The per-story facts `canReadStory` consumes (submitter, chronicle, tagged people),
 * batched for a candidate set. Only loaded on the family-mode path — 'open'-only
 * users never pay for it.
 */
async function storyAccessFacts(storyIds: string[]): Promise<Map<string, StoryAccessInput>> {
  if (storyIds.length === 0) return new Map();
  const [rows, tags] = await Promise.all([
    db
      .select({ id: stories.id, submittedBy: stories.submittedBy, chronicleId: stories.chronicleId })
      .from(stories)
      .where(inArray(stories.id, storyIds)),
    db
      .select({ storyId: storyPeople.storyId, personId: storyPeople.personId })
      .from(storyPeople)
      .where(inArray(storyPeople.storyId, storyIds)),
  ]);
  const facts = new Map<string, StoryAccessInput>(
    rows.map((s) => [s.id, { submittedBy: s.submittedBy, chronicleId: s.chronicleId, personIds: [] }]),
  );
  for (const t of tags) facts.get(t.storyId)?.personIds.push(t.personId);
  return facts;
}

/** Keep only the rows the viewer may read under the kinship rule (family-mode path). */
async function filterRowsByAccess<T extends { id: string }>(
  ctx: StoryAccessContext,
  rows: T[],
): Promise<T[]> {
  const facts = await storyAccessFacts(rows.map((r) => r.id));
  return rows.filter((r) => {
    const fact = facts.get(r.id);
    return fact !== undefined && canReadStory(ctx, fact);
  });
}

/**
 * Every story of one chronicle, restricted to what the user may read
 * (lib/story-access.ts). Pass a pre-loaded `accessCtx` when the caller already has
 * one (scoped to the same `chronicleId`), so it is loaded at most once per request.
 */
export async function listStoriesForUser(
  userId: string,
  chronicleId: string,
  accessCtx?: StoryAccessContext,
): Promise<StoryListItem[]> {
  const ctx = accessCtx ?? (await loadStoryAccessContext(userId, chronicleId));
  if (!ctx.isMember) return [];

  let rows = (await db
    .select(storyListColumns)
    .from(stories)
    .innerJoin(user, eq(stories.submittedBy, user.id))
    .where(eq(stories.chronicleId, chronicleId))
    // Newest-added first — the "recent stories" default that list_stories (AI tool) and
    // the duplicate guard rely on. The stories timeline view re-groups by event year and
    // re-sorts client-side, so its chronological ordering is owned there, not here.
    .orderBy(desc(stories.createdAt))) as StoryRow[];
  if (!readsWholeChronicle(ctx)) {
    rows = await filterRowsByAccess(ctx, rows);
  }
  return decorateStories(rows);
}

/**
 * Lightweight text of every story in a chronicle, for duplicate checks. Restricted
 * to stories the acting user may read — the duplicate guard must not echo titles or
 * text of stories that are hidden from them.
 */
export async function listChronicleStoryTexts(chronicleId: string, userId: string) {
  const rows = await db
    .select({
      id: stories.id,
      title: stories.title,
      summary: stories.summary,
      bodyOriginal: stories.bodyOriginal,
      bodyStyled: stories.bodyStyled,
      eventDate: stories.eventDate,
      submittedBy: stories.submittedBy,
      chronicleId: stories.chronicleId,
    })
    .from(stories)
    .where(eq(stories.chronicleId, chronicleId));
  const ctx = await loadStoryAccessContext(userId, chronicleId);
  // Fast path: an 'open'-mode member (or the chronicle's owner) reads every story
  // in it — no per-story facts needed.
  if (readsWholeChronicle(ctx)) return rows;
  return filterRowsByAccess(ctx, rows);
}

/**
 * A story with submitter, gated to users who are members of its chronicle and (in
 * family-mode chronicles) may read it under the kinship rule.
 */
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

  // Membership in the story's chronicle is a hard prerequisite here (unlike the pure
  // rule's unconditional author bypass) — a user who has left a chronicle no longer
  // sees a story page for it, even one they wrote themselves.
  const ctx = await loadStoryAccessContext(userId, story.chronicleId);
  if (!ctx.isMember) return null;

  // Membership alone is enough only in 'open' mode / for the chronicle's owner;
  // otherwise the kinship rule decides (denied reads look like a missing story).
  if (!readsWholeChronicle(ctx)) {
    const fact = (await storyAccessFacts([storyId])).get(storyId);
    if (fact === undefined || !canReadStory(ctx, fact)) return null;
  }

  return story;
}

/** Whether the user may edit a story: its submitter, or an owner of its chronicle. */
export async function canUserEditStory(storyId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ submittedBy: stories.submittedBy, chronicleId: stories.chronicleId })
    .from(stories)
    .where(eq(stories.id, storyId))
    .limit(1);
  const story = rows[0];
  if (!story) return false;
  if (story.submittedBy === userId) return true;

  const owner = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.chronicleId, story.chronicleId),
        eq(memberships.userId, userId),
        eq(memberships.accessRole, 'owner'),
      ),
    )
    .limit(1);
  return owner.length > 0;
}

/**
 * Apply a reviewed edit to a ready story. `bodyStyled` (+ title/summary/date) is replaced;
 * `bodyOriginal` and assets are never rewritten — existing source stays verbatim. When the
 * edit carries NEW first-hand material (`appendSource`, e.g. what the user told the chat
 * agent), it is appended to `bodyOriginal` under a dated marker so the source history grows
 * with the story. The event date only changes when its visible parts (year/month/day)
 * changed — so a 'circa' date survives edits that leave the year alone.
 */
export async function applyStoryEdit(input: {
  storyId: string;
  userId: string;
  title: string;
  summary: string | null;
  body: string;
  eventYear: number | null;
  eventMonth?: number | null;
  eventDay?: number | null;
  /** New raw source material to append to `bodyOriginal` (verbatim user words), if any. */
  appendSource?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await canUserEditStory(input.storyId, input.userId))) {
    return { ok: false, error: "Only the story's author or a chronicle owner can edit it." };
  }
  const story = await getStoryForUser(input.storyId, input.userId);
  if (!story) return { ok: false, error: 'Story not found.' };
  if (story.status !== 'ready') {
    return { ok: false, error: 'This story can only be edited once it is ready.' };
  }

  const current = eventDateToParts(story.eventDate, story.eventDatePrecision);
  const set: Partial<typeof stories.$inferInsert> = {
    title: input.title.trim() || story.title,
    summary: input.summary,
    bodyStyled: input.body,
    updatedAt: new Date(),
  };
  const { eventDate, eventDatePrecision } = partsToEventDate({
    year: input.eventYear,
    month: input.eventMonth,
    day: input.eventDay,
  });
  const next = eventDateToParts(eventDate, eventDatePrecision);
  if (next.year !== current.year || next.month !== current.month || next.day !== current.day) {
    set.eventDate = eventDate;
    set.eventDatePrecision = eventDatePrecision;
  }
  const addition = input.appendSource?.trim();
  if (addition) {
    const marker = `— ${new Date().toISOString().slice(0, 10)} —`;
    set.bodyOriginal = [story.bodyOriginal?.trim(), marker, addition]
      .filter(Boolean)
      .join('\n\n');
  }
  await db.transaction(async (tx) => {
    await tx.update(stories).set(set).where(eq(stories.id, input.storyId));
    if (addition) {
      await tx.insert(contributions).values({
        storyId: input.storyId,
        contributedBy: input.userId,
        text: addition,
      });
    }
  });
  // The edited prose is printed content in every book holding this story — any rendered
  // PDF of those books is now out of date.
  await invalidateBooksForStory(input.storyId);
  return { ok: true };
}

export interface StoryContribution {
  id: string;
  contributorName: string | null;
  text: string | null;
  createdAt: Date;
}

/** A story's source-material timeline entries, oldest first, with contributor names. */
export async function listContributions(storyId: string): Promise<StoryContribution[]> {
  const rows = await db
    .select({
      id: contributions.id,
      contributorName: user.name,
      text: contributions.text,
      createdAt: contributions.createdAt,
    })
    .from(contributions)
    .leftJoin(user, eq(contributions.contributedBy, user.id))
    .where(eq(contributions.storyId, storyId))
    .orderBy(asc(contributions.createdAt));
  return rows;
}

/**
 * Permanently delete a story (rows cascade: people links, assets).
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
  // Thumbnails are derived — nothing else references them, so they always go.
  const thumbKeys = [...new Set(storyAssets.map((a) => a.thumbS3Key).filter(Boolean))] as string[];
  if (keys.length || thumbKeys.length) {
    const referenced = keys.length
      ? await db
          .select({ s3Key: messageAttachments.s3Key })
          .from(messageAttachments)
          .where(inArray(messageAttachments.s3Key, keys))
      : [];
    const keep = new Set(referenced.map((r) => r.s3Key));
    const results = await Promise.allSettled(
      [...keys.filter((k) => !keep.has(k)), ...thumbKeys].map((k) => deleteObject(k)),
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

/**
 * Styling context (style guide + story language) from the story's chronicle.
 * Deliberately carries NO other stories' text: if example passages are ever added
 * to the styling prompt, they must be filtered to stories the SUBMITTER can read
 * (`loadStoryAccessContext(story.submittedBy, chronicleId)` + `canReadStory`), or
 * family-mode chronicles would leak hidden stories through the prompt.
 */
export async function styleContextForStory(
  storyId: string,
): Promise<{ styleGuide: string | null; storyLanguage: string | null }> {
  const rows = await db
    .select({ styleGuide: chronicles.styleGuide, storyLanguage: chronicles.storyLanguage })
    .from(stories)
    .innerJoin(chronicles, eq(stories.chronicleId, chronicles.id))
    .where(eq(stories.id, storyId))
    .limit(1);
  return {
    styleGuide: rows[0]?.styleGuide ?? null,
    storyLanguage: rows[0]?.storyLanguage ?? null,
  };
}
