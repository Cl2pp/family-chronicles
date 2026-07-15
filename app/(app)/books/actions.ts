'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { requireUser } from '@/lib/session';
import { resolveActiveChronicle } from '@/lib/chronicles';
import {
  createBook,
  getBookForUser,
  requestAiDesign,
  requestPreview,
  resetBookLayout,
  setBookStories,
  updateBook,
  updateBookLayout,
  type LayoutOp,
} from '@/lib/books';
import { runBookAgent, type ChatTurn } from '@/lib/ai/agent';
import type { Receipt, ToolContext } from '@/lib/ai/tools';
import { getI18n } from '@/lib/i18n/server';
import type { BookFormat } from '@/lib/gelato';

/** UI actions are thin wrappers over lib/books.ts — the agent tools wrap the same functions. */

/** Create a book for the active chronicle (all ready stories) and open the builder. */
export async function createBookAction(): Promise<{ error: string } | never> {
  const user = await requireUser();
  const activeCookie = (await cookies()).get('activeChronicleId')?.value;
  const { active } = await resolveActiveChronicle(user.id, activeCookie);
  const { t } = await getI18n();
  if (!active) return { error: t.books.needStories };

  const result = await createBook({
    chronicleId: active.id,
    userId: user.id,
    title: t.books.defaultTitle(active.name),
  });
  if (!result.ok) return { error: result.error };
  revalidatePath('/books');
  redirect(`/books/${result.value.bookId}`);
}

export async function updateBookAction(input: {
  bookId: string;
  title?: string;
  subtitle?: string | null;
  dedication?: string | null;
  coverAssetId?: string | null;
  format?: BookFormat;
}): Promise<{ error?: string }> {
  const user = await requireUser();
  const result = await updateBook({ ...input, userId: user.id });
  revalidatePath(`/books/${input.bookId}`);
  return result.ok ? {} : { error: result.error };
}

export async function setBookStoriesAction(input: {
  bookId: string;
  storyIds: string[];
}): Promise<{ error?: string }> {
  const user = await requireUser();
  const result = await setBookStories({ ...input, userId: user.id });
  revalidatePath(`/books/${input.bookId}`);
  return result.ok ? {} : { error: result.error };
}

export async function renderPreviewAction(bookId: string): Promise<{ error?: string }> {
  const user = await requireUser();
  const result = await requestPreview({ bookId, userId: user.id });
  revalidatePath(`/books/${bookId}`);
  return result.ok ? {} : { error: result.error };
}

export async function requestAiDesignAction(input: {
  bookId: string;
  overwriteEdits?: boolean;
}): Promise<{ error?: string }> {
  const user = await requireUser();
  const result = await requestAiDesign({ ...input, userId: user.id });
  revalidatePath(`/books/${input.bookId}`);
  return result.ok ? {} : { error: result.error };
}

export async function updateBookLayoutAction(input: {
  bookId: string;
  ops: LayoutOp[];
}): Promise<{ error?: string }> {
  const user = await requireUser();
  const result = await updateBookLayout({ ...input, userId: user.id });
  revalidatePath(`/books/${input.bookId}`);
  return result.ok ? {} : { error: result.error };
}

export async function resetBookLayoutAction(input: {
  bookId: string;
  overwriteEdits?: boolean;
}): Promise<{ error?: string }> {
  const user = await requireUser();
  const result = await resetBookLayout({ ...input, userId: user.id });
  revalidatePath(`/books/${input.bookId}`);
  return result.ok ? {} : { error: result.error };
}

/** One prior turn of the builder's book chat (client-held; the chat is per-visit). */
export interface BookChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Turns beyond this are dropped from the front — the chat is a working session on one
 *  book, not an archive, and every turn rides along to the model on every send. */
const MAX_BOOK_CHAT_TURNS = 24;

/**
 * The builder's embedded chat: run the book-scoped agent over the (client-held)
 * conversation plus the new message. Tools mutate the book directly; the page
 * revalidation bumps `previewVersion`, so the caller's `router.refresh()` re-keys the
 * live preview iframe with the changes already applied.
 */
export async function bookChatAction(input: {
  bookId: string;
  history: BookChatTurn[];
  message: string;
}): Promise<{ reply?: string; receipts?: Receipt[]; error?: string }> {
  const user = await requireUser();
  const { t } = await getI18n();
  const message = input.message.trim();
  if (!message) return { error: t.books.builder.chat.error };
  const book = await getBookForUser(input.bookId, user.id);
  if (!book) return { error: t.books.builder.chat.error };
  if (book.status === 'ordered') return { error: t.books.builder.orderedNote };

  // The book chat never creates or switches chronicles (no such tools in its set), so
  // the context is pinned to the book's chronicle and setActiveChronicle is a no-op.
  const ctx: ToolContext = {
    userId: user.id,
    userName: user.name,
    conversationId: null,
    activeChronicleId: book.chronicleId,
    activeChronicleName: book.chronicleName,
    setActiveChronicle() {},
  };

  const history: ChatTurn[] = [
    ...input.history
      .filter((turn) => (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string')
      .slice(-MAX_BOOK_CHAT_TURNS)
      .map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user' as const, content: message },
  ];

  try {
    const result = await runBookAgent(history, ctx, { id: book.id, title: book.title });
    revalidatePath(`/books/${input.bookId}`);
    return { reply: result.reply, receipts: result.receipts };
  } catch (err) {
    console.error(`Book chat failed for book ${input.bookId}:`, err);
    return { error: t.books.builder.chat.error };
  }
}
