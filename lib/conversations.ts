import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { conversations, messageAttachments, messages } from '@/db/schema';

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

/** Hours of chat inactivity after which the app starts a fresh conversation. */
export const CONVERSATION_IDLE_HOURS = 24;

/**
 * The conversation the chat page should resume: the user's most recent one, but only
 * if it saw activity within the idle window. Older conversations stay in the DB as
 * history (stories link back via `stories.conversationId`) — they're just not resumed.
 */
export async function resumableConversation(userId: string) {
  const cutoff = new Date(Date.now() - CONVERSATION_IDLE_HOURS * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.userId, userId), gt(conversations.updatedAt, cutoff)))
    .orderBy(desc(conversations.updatedAt))
    .limit(1);
  return rows[0] ?? null;
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

/** All attachments in a conversation, oldest first (e.g. to copy onto a story). */
export async function listConversationAttachments(conversationId: string) {
  return db
    .select({
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
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messageAttachments.createdAt));
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
