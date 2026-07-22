'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { requireUser } from '@/lib/session';
import { isLegacyStoryPlan } from '@/lib/book-plan-kind';
import { resolveActiveChronicle } from '@/lib/chronicles';
import {
  addBookPhotos,
  createBook,
  createPhotoBook,
  deleteBook,
  editablePhotoBook,
  getBookForUser,
  listBookPhotos,
  regeneratePhotoBookLayout,
  requestAiDesign,
  requestPhotoBookAiDesign,
  requestPreview,
  resetBookLayout,
  convertBookToUnifiedLayout,
  setBookStories,
  setPhotoBookStyle,
  setPhotoExcluded,
  updateBook,
  updateBookLayout,
  updatePhotoBookSettings,
  type AddBookPhotoInput,
  type UpdatePhotoBookSettingsOutcome,
  type BookPhotoItem,
  type LayoutOp,
} from '@/lib/books';
import type { PhotoBookStyle } from '@/lib/photo-book-plan';
import type { PhotoBookGrouping } from '@/lib/photo-book-grouping';
import { runBookAgent, runPhotoBookAgent, type ChatTurn } from '@/lib/ai/agent';
import type { Receipt, ToolContext } from '@/lib/ai/tools';
import { getI18n } from '@/lib/i18n/server';
import type { BookCoverType, BookFormat } from '@/lib/gelato';
import { captureServerEvent } from '@/lib/posthog-server';
import { buildKey, getObjectBuffer, presignPut } from '@/lib/s3';
import { validateUpload } from '@/lib/uploads';
import { transcribeAudio } from '@/lib/ai/groq';
import { compressForTranscription, TRANSCRIBE_COMPRESS_THRESHOLD_BYTES } from '@/lib/transcode';

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
  captureServerEvent(user.id, 'book_created', {
    book_id: result.value.bookId,
    chronicle_id: active.id,
  });
  redirect(`/books/${result.value.bookId}`);
}

/** Create a photo book (empty — the bulk uploader adds photos) and open its builder. */
export async function createPhotoBookAction(): Promise<{ error: string } | never> {
  const user = await requireUser();
  const activeCookie = (await cookies()).get('activeChronicleId')?.value;
  const { active } = await resolveActiveChronicle(user.id, activeCookie);
  const { t } = await getI18n();
  if (!active) return { error: t.books.needChronicle };

  const result = await createPhotoBook({
    chronicleId: active.id,
    userId: user.id,
    title: t.books.defaultPhotoBookTitle(active.name),
  });
  if (!result.ok) return { error: result.error };
  revalidatePath('/books');
  captureServerEvent(user.id, 'photo_book_created', {
    book_id: result.value.bookId,
    chronicle_id: active.id,
  });
  redirect(`/books/${result.value.bookId}`);
}

/** One presigned upload slot for the bulk photo uploader — a per-file result, not an
 *  all-or-nothing batch: `index` always echoes the request position so the client can
 *  match a slot back to its `File` even when some slots failed and others didn't. */
export type PresignedBookPhoto =
  | { index: number; ok: true; url: string; s3Key: string; mimeType: string }
  | { index: number; ok: false; error: string };

/**
 * Batch presign: one round trip signs N book-photo uploads (§3, "Batch presign
 * server action"). Each file is validated against the same allowlist/15 MB limit as
 * every other photo upload (`lib/uploads.ts`) — only the object key prefix differs
 * (`books/photos/` instead of `stories/photos/`).
 *
 * Validation happens per file, not batch-wide: a 300-file selection commonly has a
 * handful of unsupported/oversized outliers (screenshots, videos picked by mistake,
 * a 40 MP original over the limit), and one bad file must not reject presigning for
 * the other 299 — each slot reports its own success/failure instead.
 */
export async function presignBookPhotosAction(input: {
  bookId: string;
  files: { mimeType: string; bytes: number }[];
}): Promise<{ uploads: PresignedBookPhoto[] } | { error: string }> {
  const user = await requireUser();
  const gate = await editablePhotoBook(input.bookId, user.id);
  if (!gate.ok) return { error: gate.error };
  if (input.files.length === 0) return { uploads: [] };

  const uploads = await Promise.all(
    input.files.map(async (file, index): Promise<PresignedBookPhoto> => {
      try {
        const validated = validateUpload('photo', file.mimeType, file.bytes);
        const s3Key = buildKey('books/photos', validated.ext);
        const url = await presignPut(s3Key, validated.mimeType, validated.bytes);
        return { index, ok: true, url, s3Key, mimeType: validated.mimeType };
      } catch (err) {
        return { index, ok: false, error: err instanceof Error ? err.message : 'Invalid upload.' };
      }
    }),
  );
  return { uploads };
}

/** Attach already-uploaded photos (via `presignBookPhotosAction`) to a photo book. */
export async function addBookPhotosAction(input: {
  bookId: string;
  photos: AddBookPhotoInput[];
}): Promise<{ added?: number; error?: string }> {
  const user = await requireUser();
  const result = await addBookPhotos({ ...input, userId: user.id });
  if (!result.ok) return { error: result.error };
  revalidatePath(`/books/${input.bookId}`);
  captureServerEvent(user.id, 'photo_book_photos_added', {
    book_id: input.bookId,
    photo_count: result.value.added,
  });
  return { added: result.value.added };
}

/** The current photo grid of a photo book, for the builder to poll analysis progress. */
export async function listBookPhotosAction(
  bookId: string,
): Promise<{ photos: BookPhotoItem[] } | { error: string }> {
  const user = await requireUser();
  const result = await listBookPhotos(bookId, user.id);
  if (!result.ok) return { error: result.error };
  return { photos: result.value.photos };
}

/** Exclude/include one photo from the photo book's layout. */
export async function setPhotoExcludedAction(input: {
  bookId: string;
  assetId: string;
  excluded: boolean;
}): Promise<{ error?: string }> {
  const user = await requireUser();
  const result = await setPhotoExcluded({ ...input, userId: user.id });
  if (result.ok) revalidatePath(`/books/${input.bookId}`);
  return result.ok ? {} : { error: result.error };
}

/** Switch the photo book's style suite. */
export async function setPhotoBookStyleAction(input: {
  bookId: string;
  style: PhotoBookStyle;
}): Promise<{ error?: string }> {
  const user = await requireUser();
  const result = await setPhotoBookStyle({ ...input, userId: user.id });
  if (result.ok) revalidatePath(`/books/${input.bookId}`);
  return result.ok ? {} : { error: result.error };
}

/** Rebuild the photo book's layout from scratch (the builder's "Regenerate" button).
 *  Fails asking for confirmation if the layout has manual (chat) edits — pass
 *  `overwriteEdits: true` only once the user has confirmed replacing them. */
export async function regeneratePhotoBookLayoutAction(input: {
  bookId: string;
  overwriteEdits?: boolean;
}): Promise<{ error?: string }> {
  const user = await requireUser();
  const result = await regeneratePhotoBookLayout({ ...input, userId: user.id });
  if (result.ok) revalidatePath(`/books/${input.bookId}`);
  return result.ok ? {} : { error: result.error };
}

/** Queue the photo book's AI design pass (the builder's "Design my book" button). Same
 *  manual-edit consent guard as above. */
export async function requestPhotoBookAiDesignAction(input: {
  bookId: string;
  overwriteEdits?: boolean;
}): Promise<{ error?: string }> {
  const user = await requireUser();
  const result = await requestPhotoBookAiDesign({ ...input, userId: user.id });
  revalidatePath(`/books/${input.bookId}`);
  if (result.ok) {
    captureServerEvent(user.id, 'photo_book_ai_design_requested', { book_id: input.bookId });
  }
  return result.ok ? {} : { error: result.error };
}

/** The photo-book builder Step 2 config panel — title/subtitle/size/cover-type. */
export async function updatePhotoBookSettingsAction(input: {
  bookId: string;
  title?: string;
  subtitle?: string | null;
  format?: BookFormat;
  coverType?: BookCoverType;
  photoGrouping?: PhotoBookGrouping;
}): Promise<{ error?: string; redesign?: UpdatePhotoBookSettingsOutcome['redesign'] }> {
  const user = await requireUser();
  const result = await updatePhotoBookSettings({ ...input, userId: user.id });
  if (result.ok) revalidatePath(`/books/${input.bookId}`);
  return result.ok ? { redesign: result.value.redesign } : { error: result.error };
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
  if (result.ok) {
    captureServerEvent(user.id, 'book_ai_design_requested', { book_id: input.bookId });
  }
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

/** Convert a legacy story book to the unified layout engine — see
 *  `convertBookToUnifiedLayout`. The book keeps its content and settings; its typography
 *  and page layout are rebuilt, which is why the UI confirms first. */
export async function convertBookToUnifiedLayoutAction(bookId: string): Promise<{ error?: string }> {
  const user = await requireUser();
  const result = await convertBookToUnifiedLayout({ bookId, userId: user.id });
  revalidatePath(`/books/${bookId}`);
  return result.ok ? {} : { error: result.error };
}

/** Permanently delete a book (stories/photos untouched). The client redirects to /books. */
export async function deleteBookAction(bookId: string): Promise<{ error?: string }> {
  const user = await requireUser();
  const result = await deleteBook({ bookId, userId: user.id });
  if (!result.ok) return { error: result.error };
  revalidatePath('/books');
  captureServerEvent(user.id, 'book_deleted', { book_id: bookId });
  return {};
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

/** One prior turn of the photo-book builder's chat (client-held; same per-visit contract
 *  as `BookChatTurn` — nothing is persisted, the book itself is the durable state). */
export interface PhotoBookChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Turns beyond this are dropped from the front, same reasoning as `MAX_BOOK_CHAT_TURNS`. */
const MAX_PHOTO_BOOK_CHAT_TURNS = 24;

/** Shared by the text and voice entry points below: build the turn list, run the
 *  photo-book-scoped agent, revalidate so the live preview re-keys with any edits. */
async function runPhotoBookChatTurn(input: {
  bookId: string;
  history: PhotoBookChatTurn[];
  message: string;
}): Promise<{ reply?: string; receipts?: Receipt[]; error?: string }> {
  const user = await requireUser();
  const { t } = await getI18n();
  const tc = t.books.builder.photoBook.chat;
  const message = input.message.trim();
  if (!message) return { error: tc.error };
  const book = await getBookForUser(input.bookId, user.id);
  // Engine gate, not a kind gate — this chat belongs to the unified builder, which now
  // serves every book except one still on a legacy story-book plan.
  if (!book || isLegacyStoryPlan(book.layoutPlan)) return { error: tc.error };
  if (book.status === 'ordered') return { error: t.books.builder.orderedNote };

  // The photo book chat never creates or switches chronicles (no such tools in its
  // set), so the context is pinned to the book's chronicle and this is a no-op.
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
      .slice(-MAX_PHOTO_BOOK_CHAT_TURNS)
      .map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user' as const, content: message },
  ];

  try {
    const result = await runPhotoBookAgent(history, ctx, { id: book.id, title: book.title });
    revalidatePath(`/books/${input.bookId}`);
    return { reply: result.reply, receipts: result.receipts };
  } catch (err) {
    console.error(`Photo book chat failed for book ${input.bookId}:`, err);
    return { error: tc.error };
  }
}

/**
 * The photo-book builder's embedded chat, typed message — mirrors `bookChatAction`
 * exactly, just running the photo-book-scoped agent (`lib/ai/agent.ts`'s
 * `runPhotoBookAgent`, photo-book tools only) instead of the story one.
 */
export async function photoBookChatAction(input: {
  bookId: string;
  history: PhotoBookChatTurn[];
  message: string;
}): Promise<{ reply?: string; receipts?: Receipt[]; error?: string }> {
  return runPhotoBookChatTurn(input);
}

/**
 * The photo-book builder's embedded chat, VOICE message (docs/PHOTO_BOOK_PLAN.md §9):
 * the client already uploaded the recording via the existing audio presign path (the
 * SAME `presignUpload` the main chat uses, `app/(app)/chat/actions.ts` — reused as-is,
 * no book-specific upload plumbing needed) and hands this the resulting `s3Key`. This
 * transcribes it with Groq Whisper (compressing first if it's large, exactly like
 * `transcribeVoiceMessage` in `app/(app)/chat/respond.ts`) and feeds the transcript to
 * the agent as the user's message, same as a typed one.
 *
 * Unlike the main chat, there is no `messages`/`message_attachments` row to point at
 * this recording — the photo-book chat is per-visit, nothing persisted (see
 * `PhotoBookChatTurn`'s doc comment) — so the uploaded object is NOT durably kept: it
 * lives under the same `chat/audio/` prefix the orphan sweeper already reclaims
 * anything unreferenced from after ~24h (`lib/orphans.ts`). Only the transcript survives
 * (in the client's in-memory chat transcript for that visit), which matches the design
 * the rest of this chat already has — the book itself is the only durable state.
 */
export async function photoBookChatVoiceAction(input: {
  bookId: string;
  history: PhotoBookChatTurn[];
  s3Key: string;
  mimeType: string;
}): Promise<{ reply?: string; receipts?: Receipt[]; transcript?: string; error?: string }> {
  const { t } = await getI18n();
  const tc = t.books.builder.photoBook.chat;
  await requireUser();
  if (!input.s3Key.startsWith('chat/audio/')) return { error: tc.error };

  let transcript: string;
  try {
    let buffer = await getObjectBuffer(input.s3Key);
    let filename = input.s3Key.split('/').pop() ?? 'audio';
    let mimeType = input.mimeType;
    if (buffer.length > TRANSCRIBE_COMPRESS_THRESHOLD_BYTES) {
      try {
        ({ buffer, filename, mimeType } = await compressForTranscription(buffer, mimeType));
      } catch (err) {
        // Send the original and let Groq decide — same fallback as the main chat's
        // transcribeVoiceMessage.
        console.error(`Audio compression failed for ${input.s3Key} — sending original:`, err);
      }
    }
    transcript = await transcribeAudio(buffer, filename, mimeType);
  } catch (err) {
    console.error(`Photo book voice transcription failed for ${input.s3Key}:`, err);
    const tooLarge = (err as { status?: number })?.status === 413;
    return { error: tooLarge ? tc.transcriptionTooLong : tc.transcriptionFailed };
  }

  const result = await runPhotoBookChatTurn({ bookId: input.bookId, history: input.history, message: transcript });
  return { ...result, transcript };
}
