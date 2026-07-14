'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { requireUser } from '@/lib/session';
import { resolveActiveChronicle } from '@/lib/chronicles';
import {
  createBook,
  placeOrder,
  requestAiDesign,
  requestPreview,
  setBookStories,
  updateBook,
} from '@/lib/books';
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

export async function placeOrderAction(bookId: string): Promise<{ error?: string }> {
  const user = await requireUser();
  const result = await placeOrder({ bookId, userId: user.id });
  revalidatePath(`/books/${bookId}`);
  revalidatePath('/books');
  return result.ok ? {} : { error: result.error };
}
