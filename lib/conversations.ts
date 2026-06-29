import { asc, desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { conversations, messages } from '@/db/schema';

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export async function createConversation(userId: string, familyId?: string | null) {
  const [created] = await db
    .insert(conversations)
    .values({ userId, familyId: familyId ?? null })
    .returning();
  return created;
}

export async function getConversation(id: string) {
  return db.query.conversations.findFirst({ where: eq(conversations.id, id) });
}

/** Most recent conversation for a user (to resume), or null. */
export async function latestConversation(userId: string) {
  const rows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function listMessages(conversationId: string) {
  return db
    .select({ id: messages.id, role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
}

export async function addMessage(conversationId: string, role: ChatRole, content: string) {
  const [created] = await db
    .insert(messages)
    .values({ conversationId, role, content })
    .returning();
  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
  return created;
}
