/**
 * One-off backfill for the contributions timeline (run with
 * `npx tsx scripts/backfill-contributions.ts` against the target DATABASE_URL).
 *
 * 1. Stories that predate the `contributions` table get their `body_original`
 *    split on the "— YYYY-MM-DD —" markers `applyStoryEdit` used to append
 *    revisions, one contribution per segment, and their existing assets linked
 *    to the nearest contribution.
 * 2. Chat uploads stranded by the old claim gap (revisions never claimed them)
 *    are claimed onto the story their conversation's revision receipts point at.
 * 3. Every stored WebM/Ogg voice note gets a transcode job (Safari/iOS can't
 *    play Opus — see lib/transcode.ts).
 *
 * Idempotent: each step skips rows that are already migrated.
 */
import 'dotenv/config';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { assets, contributions, messageAttachments, messages, stories } from '@/db/schema';
import { enqueueTranscode } from '@/lib/queue';

const MARKER = /\n\n— (\d{4}-\d{2}-\d{2}) —\n\n/g;

async function backfillContributions() {
  const allStories = await db.select().from(stories);
  for (const story of allStories) {
    if (!story.bodyOriginal?.trim()) continue;
    const existing = await db
      .select({ id: contributions.id })
      .from(contributions)
      .where(eq(contributions.storyId, story.id))
      .limit(1);
    if (existing.length) continue;

    // split with a capture group yields [seg0, date1, seg1, date2, seg2, …]
    const parts = story.bodyOriginal.split(MARKER);
    const rows: (typeof contributions.$inferInsert)[] = [];
    for (let i = 0; i < parts.length; i += 2) {
      const text = parts[i].trim();
      if (!text) continue;
      const createdAt = i === 0 ? story.createdAt : new Date(`${parts[i - 1]}T12:00:00Z`);
      rows.push({ storyId: story.id, contributedBy: story.submittedBy, text, createdAt });
    }
    if (!rows.length) continue;
    const inserted = await db.insert(contributions).values(rows).returning();
    console.log(`story ${story.id} ("${story.title}"): ${inserted.length} contribution(s)`);

    // Existing assets belong to the newest contribution that isn't younger than they
    // are (claims happen at save time); everything older than all markers → first one.
    const sorted = [...inserted].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const storyAssets = await db.select().from(assets).where(eq(assets.storyId, story.id));
    for (const asset of storyAssets) {
      if (asset.contributionId) continue;
      const notYounger = sorted.filter(
        (c) => c.createdAt.getTime() <= asset.createdAt.getTime() + 60_000,
      );
      const target = notYounger[notYounger.length - 1] ?? sorted[0];
      await db.update(assets).set({ contributionId: target.id }).where(eq(assets.id, asset.id));
    }
  }
}

/**
 * Claim uploads stranded on conversations whose revision receipts all point at one
 * story. (The old code only claimed on story *creation*, so voice notes sent while
 * updating a story were left behind.)
 */
async function claimStrandedUploads() {
  const stranded = await db
    .select({
      id: messageAttachments.id,
      kind: messageAttachments.kind,
      s3Key: messageAttachments.s3Key,
      mimeType: messageAttachments.mimeType,
      bytes: messageAttachments.bytes,
      width: messageAttachments.width,
      height: messageAttachments.height,
      durationSec: messageAttachments.durationSec,
      conversationId: messages.conversationId,
    })
    .from(messageAttachments)
    .innerJoin(messages, eq(messageAttachments.messageId, messages.id))
    .where(isNull(messageAttachments.storyId))
    .orderBy(asc(messageAttachments.createdAt));
  if (!stranded.length) return;

  const byConversation = new Map<string, typeof stranded>();
  for (const row of stranded) {
    const list = byConversation.get(row.conversationId) ?? [];
    list.push(row);
    byConversation.set(row.conversationId, list);
  }

  for (const [conversationId, rows] of byConversation) {
    const systemNotes = await db
      .select({ content: messages.content })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'system')));
    const storyIds = new Set<string>();
    for (const note of systemNotes) {
      const m = note.content.match(/\(id ([0-9a-f-]{36})\) is updated/);
      if (m) storyIds.add(m[1]);
    }
    if (storyIds.size !== 1) {
      console.log(
        `conversation ${conversationId}: ${rows.length} stranded upload(s) left alone ` +
          `(${storyIds.size} updated stories — can't attribute)`,
      );
      continue;
    }
    const [storyId] = storyIds;

    // The revision that should have claimed them is the story's newest contribution.
    const contribution = (
      await db
        .select()
        .from(contributions)
        .where(eq(contributions.storyId, storyId))
        .orderBy(asc(contributions.createdAt))
    ).at(-1);

    await db.transaction(async (tx) => {
      await tx
        .update(messageAttachments)
        .set({ storyId })
        .where(
          inArray(
            messageAttachments.id,
            rows.map((r) => r.id),
          ),
        );
      await tx
        .insert(assets)
        .values(
          rows.map((r) => ({
            storyId,
            contributionId: contribution?.id ?? null,
            kind: r.kind,
            s3Key: r.s3Key,
            mimeType: r.mimeType,
            bytes: r.bytes,
            width: r.width,
            height: r.height,
            durationSec: r.durationSec,
          })),
        )
        .onConflictDoNothing();
    });
    console.log(`conversation ${conversationId}: claimed ${rows.length} upload(s) → story ${storyId}`);
  }
}

/** Queue a transcode for every stored voice note Safari can't play. */
async function enqueueTranscodes() {
  const [attachmentRows, assetRows] = await Promise.all([
    db
      .select({ s3Key: messageAttachments.s3Key, mimeType: messageAttachments.mimeType })
      .from(messageAttachments)
      .where(eq(messageAttachments.kind, 'audio')),
    db
      .select({ s3Key: assets.s3Key, mimeType: assets.mimeType })
      .from(assets)
      .where(eq(assets.kind, 'audio')),
  ]);
  const keys = new Set<string>();
  for (const r of [...attachmentRows, ...assetRows]) {
    const base = r.mimeType.split(';')[0].trim().toLowerCase();
    if (base === 'audio/webm' || base === 'audio/ogg') keys.add(r.s3Key);
  }
  for (const s3Key of keys) {
    await enqueueTranscode({ s3Key });
    console.log(`queued transcode: ${s3Key}`);
  }
}

async function main() {
  await backfillContributions();
  await claimStrandedUploads();
  await enqueueTranscodes();
  console.log('done');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
