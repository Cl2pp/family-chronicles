import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { conversations, messageAttachments, messages } from '@/db/schema';
import { CONVERSATION_IDLE_MS } from '@/lib/chat-idle';

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';
export type AttachmentKind = 'audio' | 'photo';

export interface AttachmentInput {
  kind: AttachmentKind;
  s3Key: string;
  mimeType: string;
  bytes?: number | null;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
}

export async function createConversation(userId: string, chronicleId?: string | null) {
  const [created] = await db
    .insert(conversations)
    .values({ userId, chronicleId: chronicleId ?? null })
    .returning();
  return created;
}

export async function getConversation(id: string) {
  return db.query.conversations.findFirst({ where: eq(conversations.id, id) });
}

/**
 * The conversation the chat page should resume: the user's most recent one, but only
 * if it saw activity within the idle window and wasn't explicitly closed via "New
 * chat". Older/closed conversations stay in the DB as history (stories link back via
 * `stories.conversationId`) — they're just not resumed.
 */
export async function resumableConversation(userId: string) {
  const cutoff = new Date(Date.now() - CONVERSATION_IDLE_MS);
  const rows = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.userId, userId),
        isNull(conversations.closedAt),
        gt(conversations.updatedAt, cutoff),
      ),
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * A generation claim older than this is considered dead (the request that took it
 * crashed without releasing). Longer than any healthy agent run, so a live run is
 * never shadowed by a second one — but shorter than the client's reconcile-polling
 * window (chat-view's MAX_SYNC_ATTEMPTS × SYNC_RETRY_MS), so an orphaned claim is
 * retaken and the reply regenerated while the client is still asking.
 */
const REPLY_CLAIM_STALE_MS = 3 * 60 * 1000;

/**
 * Try to take the conversation's reply-generation claim. Atomic: of two concurrent
 * callers (the original send still running vs. a recovery sync) only one wins.
 * Returns false when a live (non-stale) claim is already held.
 */
export async function tryClaimPendingReply(conversationId: string): Promise<boolean> {
  const stale = new Date(Date.now() - REPLY_CLAIM_STALE_MS);
  const rows = await db
    .update(conversations)
    .set({ replyPendingSince: new Date() })
    .where(
      and(
        eq(conversations.id, conversationId),
        or(
          sql`${conversations.replyPendingSince} IS NULL`,
          lt(conversations.replyPendingSince, stale),
        ),
      ),
    )
    .returning({ id: conversations.id });
  return rows.length > 0;
}

/**
 * Take the claim unconditionally — for the send paths, which just stored a brand-new
 * user turn: any existing claim belongs to an older turn and may be superseded.
 */
export async function claimPendingReply(conversationId: string) {
  await db
    .update(conversations)
    .set({ replyPendingSince: new Date() })
    .where(eq(conversations.id, conversationId));
}

/** Release the reply-generation claim (always runs, success or failure). */
export async function releasePendingReply(conversationId: string) {
  await db
    .update(conversations)
    .set({ replyPendingSince: null })
    .where(eq(conversations.id, conversationId));
}

/** Mark a conversation closed — it stays stored as history but is never resumed. */
export async function closeConversation(id: string) {
  await db
    .update(conversations)
    .set({ closedAt: new Date() })
    .where(eq(conversations.id, id));
}

export async function listMessages(conversationId: string) {
  return db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      metadata: messages.metadata,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
}

/**
 * Mark the newest still-pending story-draft card in a conversation as acted on, so a
 * reload renders it as history (the ✓ receipt chip) instead of re-offering a live card
 * for a story that was already saved or discarded.
 */
export async function resolveDraftCard(conversationId: string) {
  const recent = await db
    .select({ id: messages.id, metadata: messages.metadata })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'assistant')))
    .orderBy(desc(messages.createdAt));

  const pending = recent.find((m) => {
    const meta = m.metadata as { storyDraft?: unknown; draftResolved?: boolean } | null;
    return meta?.storyDraft && !meta.draftResolved;
  });
  if (!pending) return;

  const meta = pending.metadata as Record<string, unknown>;
  await db
    .update(messages)
    .set({ metadata: { ...meta, draftResolved: true } })
    .where(eq(messages.id, pending.id));
}

export async function addMessage(
  conversationId: string,
  role: ChatRole,
  content: string,
  metadata?: unknown,
) {
  const [created] = await db
    .insert(messages)
    .values({ conversationId, role, content, metadata: metadata ?? null })
    .returning();
  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
  return created;
}

/** Attach in-chat uploads (voice/photos) to a message. */
export async function addAttachments(messageId: string, items: AttachmentInput[]) {
  if (items.length === 0) return;
  await db.insert(messageAttachments).values(
    items.map((a) => ({
      messageId,
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

/** Photo attachments on a set of messages, so the agent can actually see them. */
export async function photosByMessage(messageIds: string[]) {
  const map = new Map<string, Array<{ s3Key: string; mimeType: string }>>();
  if (messageIds.length === 0) return map;
  const rows = await db
    .select({
      messageId: messageAttachments.messageId,
      s3Key: messageAttachments.s3Key,
      mimeType: messageAttachments.mimeType,
    })
    .from(messageAttachments)
    .where(
      and(inArray(messageAttachments.messageId, messageIds), eq(messageAttachments.kind, 'photo')),
    )
    .orderBy(asc(messageAttachments.createdAt));
  for (const r of rows) {
    const arr = map.get(r.messageId) ?? [];
    arr.push({ s3Key: r.s3Key, mimeType: r.mimeType });
    map.set(r.messageId, arr);
  }
  return map;
}

/** Attachments grouped by message id, for a set of messages. */
export async function attachmentsByMessage(messageIds: string[]) {
  const map = new Map<string, AttachmentInput[]>();
  if (messageIds.length === 0) return map;
  const rows = await db
    .select({
      messageId: messageAttachments.messageId,
      kind: messageAttachments.kind,
      s3Key: messageAttachments.s3Key,
      mimeType: messageAttachments.mimeType,
      bytes: messageAttachments.bytes,
      width: messageAttachments.width,
      height: messageAttachments.height,
      durationSec: messageAttachments.durationSec,
    })
    .from(messageAttachments)
    .where(inArray(messageAttachments.messageId, messageIds))
    .orderBy(asc(messageAttachments.createdAt));
  for (const r of rows) {
    const arr = map.get(r.messageId) ?? [];
    arr.push(r);
    map.set(r.messageId, arr);
  }
  return map;
}
