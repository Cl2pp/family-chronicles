'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/session';
import { resolveActiveChronicle, getChronicle, getMembership } from '@/lib/chronicles';
import {
  addAttachments,
  addMessage,
  closeConversation,
  createConversation,
  getConversation,
  listMessages,
  photosByMessage,
  resolveDraftCard,
  type AttachmentInput,
} from '@/lib/conversations';
import { runAgent, type ChatTurn } from '@/lib/ai/agent';
import type { Receipt, StoryDraft, StoryProposal, ToolContext, UndoAction } from '@/lib/ai/tools';
import {
  applyStoryEdit,
  claimChatAssetsForStory,
  createStory,
  listChronicleStoryTexts,
} from '@/lib/stories';
import { normalizeText } from '@/lib/story-similarity';
import {
  canUserEditPerson,
  deletePerson,
  getPerson,
  listChroniclePeople,
  removeRelationship,
} from '@/lib/people';
import { canContribute, type AccessRole } from '@/lib/permissions';
import { yearToDate } from '@/lib/dates';
import { buildKey, getObjectBuffer, presignGet, presignPut } from '@/lib/s3';
import { validateUpload } from '@/lib/uploads';
import { transcribeAudio } from '@/lib/ai/groq';

/** Throw unless the user can contribute to the chronicle (create stories / tree). */
async function assertContributor(chronicleId: string, userId: string) {
  const membership = await getMembership(chronicleId, userId);
  if (!membership) throw new Error('You do not have access to this chronicle.');
  if (!canContribute(membership.accessRole as AccessRole)) {
    throw new Error('You do not have permission to add to this chronicle.');
  }
  return membership;
}

/**
 * A presigned URL the browser uses to PUT an in-chat upload straight to storage.
 * Returns the canonical MIME type to store — `validateUpload` normalizes it, and the
 * signature pins both it and the byte length.
 */
export async function presignUpload(input: {
  kind: 'audio' | 'photo';
  mimeType: string;
  bytes: number;
}): Promise<{ url: string; s3Key: string; mimeType: string }> {
  await requireUser();
  const upload = validateUpload(input.kind, input.mimeType, input.bytes);
  const prefix = input.kind === 'audio' ? 'chat/audio' : 'chat/photos';
  const s3Key = buildKey(prefix, upload.ext);
  const url = await presignPut(s3Key, upload.mimeType, upload.bytes);
  return { url, s3Key, mimeType: upload.mimeType };
}

/**
 * Attachments arrive from the client, so the key it hands back must be one we just
 * signed for that purpose — not a guess at someone's avatar or another story's photo.
 */
function assertChatUpload(kind: 'audio' | 'photo', s3Key: string) {
  const prefix = kind === 'audio' ? 'chat/audio/' : 'chat/photos/';
  if (!s3Key.startsWith(prefix)) throw new Error('Invalid upload.');
}

export interface SendResult {
  conversationId: string;
  reply: string;
  receipts: Receipt[];
  storyDraft: StoryDraft | null;
}

/** Build the mutable per-turn tool context from the resolved active chronicle. */
function makeContext(
  userId: string,
  userName: string,
  active: { id: string; name: string } | undefined,
): ToolContext {
  const ctx: ToolContext = {
    userId,
    userName,
    activeChronicleId: active?.id ?? null,
    activeChronicleName: active?.name ?? null,
    setActiveChronicle(id, name) {
      ctx.activeChronicleId = id;
      ctx.activeChronicleName = name;
    },
  };
  return ctx;
}

/** Resolve the conversation to use (existing, owned) or create a new one. */
async function resolveConversation(
  conversationId: string | null,
  chronicleId: string | null,
  userId: string,
): Promise<string> {
  if (!conversationId) {
    const convo = await createConversation(userId, chronicleId);
    return convo.id;
  }
  const convo = await getConversation(conversationId);
  if (!convo || convo.userId !== userId) throw new Error('Conversation not found');
  return convo.id;
}

/** Run the agent over the conversation, store its reply, and persist any state changes. */
async function respondAndStore(
  conversationId: string,
  ctx: ToolContext,
  previousChronicleId: string | undefined,
): Promise<SendResult> {
  const stored = await listMessages(conversationId);
  const turns = stored.filter(
    (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system',
  );
  // Photos ride along as images so the agent can see what the story is about. The URLs
  // are presigned reads the model's provider fetches server-side.
  const photoKeys = await photosByMessage(turns.filter((m) => m.role === 'user').map((m) => m.id));
  const history: ChatTurn[] = await Promise.all(
    turns.map(async (m) => ({
      role: m.role as ChatTurn['role'],
      content: m.content,
      imageUrls: await Promise.all(
        (photoKeys.get(m.id) ?? []).map((p) => presignGet(p.s3Key, p.mimeType)),
      ),
    })),
  );

  const result = await runAgent(history, ctx);
  // Persist receipts and any draft card on the assistant message so the ✓ chips and the
  // reviewable card both survive a reload (a phone backgrounding the PWA, say).
  const metadata =
    result.receipts.length || result.storyDraft
      ? {
          ...(result.receipts.length ? { receipts: result.receipts } : {}),
          ...(result.storyDraft ? { storyDraft: result.storyDraft } : {}),
        }
      : undefined;
  await addMessage(conversationId, 'assistant', result.reply, metadata);
  // Record the draft card as a system event so later turns know it exists and
  // that only the user can act on it (prevents "should I save it?" re-drafts).
  if (result.storyDraft) {
    const draftTitle = result.storyDraft.proposal.title;
    await addMessage(
      conversationId,
      'system',
      `[A story draft card "${draftTitle}" is now showing. Only the user can save or discard it ` +
        'on the card; a note will appear here once they do. Do not draft it again or offer to save it.]',
    );
  }

  // A tool may have created/switched the active chronicle — persist it to the cookie.
  if (ctx.activeChronicleId && ctx.activeChronicleId !== previousChronicleId) {
    (await cookies()).set('activeChronicleId', ctx.activeChronicleId, { path: '/' });
  }
  // Any applied action may have changed the family tree or stories pages.
  if (result.receipts.length) {
    revalidatePath('/chronicle');
    revalidatePath('/stories');
  }

  return {
    conversationId,
    reply: result.reply,
    receipts: result.receipts,
    storyDraft: result.storyDraft,
  };
}

/** Persist the user's message (+ any photos), then run the agent for a reply + actions. */
export async function sendMessage(input: {
  conversationId: string | null;
  text: string;
  attachments?: AttachmentInput[];
}): Promise<SendResult> {
  const user = await requireUser();
  const text = input.text.trim();
  const attachments = input.attachments ?? [];
  // Photos alone are a message — the agent sees them.
  if (!text && attachments.length === 0) throw new Error('Empty message');
  for (const a of attachments) assertChatUpload(a.kind, a.s3Key);

  const previousChronicleId = (await cookies()).get('activeChronicleId')?.value;
  const { active } = await resolveActiveChronicle(user.id, previousChronicleId);
  const ctx = makeContext(user.id, user.name, active);

  const conversationId = await resolveConversation(input.conversationId, ctx.activeChronicleId, user.id);
  const message = await addMessage(conversationId, 'user', text);
  if (attachments.length) await addAttachments(message.id, attachments);

  return respondAndStore(conversationId, ctx, previousChronicleId);
}

/** Transcribe an uploaded voice note, store it as the user's message, then run the agent. */
export async function sendVoiceMessage(input: {
  conversationId: string | null;
  s3Key: string;
  mimeType: string;
  bytes?: number | null;
  durationSec?: number | null;
}): Promise<SendResult & { transcript: string }> {
  const user = await requireUser();
  assertChatUpload('audio', input.s3Key);

  let transcript: string;
  try {
    const buffer = await getObjectBuffer(input.s3Key);
    const filename = input.s3Key.split('/').pop() ?? 'audio';
    transcript = await transcribeAudio(buffer, filename, input.mimeType);
  } catch (err) {
    console.error(`Voice transcription failed for ${input.s3Key}:`, err);
    throw new Error("Sorry — I couldn't transcribe that recording. Please try again.");
  }

  const previousChronicleId = (await cookies()).get('activeChronicleId')?.value;
  const { active } = await resolveActiveChronicle(user.id, previousChronicleId);
  const ctx = makeContext(user.id, user.name, active);

  const conversationId = await resolveConversation(input.conversationId, ctx.activeChronicleId, user.id);
  const message = await addMessage(conversationId, 'user', transcript);
  await addAttachments(message.id, [
    {
      kind: 'audio',
      s3Key: input.s3Key,
      mimeType: input.mimeType,
      bytes: input.bytes ?? null,
      durationSec: input.durationSec ?? null,
    },
  ]);

  const result = await respondAndStore(conversationId, ctx, previousChronicleId);
  return { ...result, transcript };
}

/**
 * Close the current conversation ("New chat"): it stays stored as history (stories
 * keep linking back to it), but a reload/reopen will start fresh instead of resuming it.
 */
export async function endConversation(conversationId: string): Promise<void> {
  const user = await requireUser();
  const convo = await getConversation(conversationId);
  if (!convo || convo.userId !== user.id) return;
  await closeConversation(conversationId);
}

/** Reverse an applied structural action from a receipt's Undo button. */
export async function undoAction(
  undo: UndoAction,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();

  if (undo.kind === 'person') {
    const person = await getPerson(undo.personId);
    if (!person) return { ok: true }; // already removed — nothing to undo
    if (person.userId) {
      return { ok: false, error: 'This person is linked to an account and cannot be deleted.' };
    }
    if (!(await canUserEditPerson(user.id, undo.personId))) {
      return { ok: false, error: 'You do not have permission to undo this.' };
    }
    await deletePerson(undo.personId);
  } else {
    if (!(await canUserEditPerson(user.id, undo.from))) {
      return { ok: false, error: 'You do not have permission to undo this.' };
    }
    await removeRelationship({ type: undo.relType, personFromId: undo.from, personToId: undo.to });
  }

  revalidatePath('/chronicle');
  return { ok: true };
}

/** Accept a story draft → create a ready story shared into the given chronicle. */
export async function acceptStory(input: {
  conversationId: string;
  chronicleId: string;
  proposal: StoryProposal;
}): Promise<{ storyId: string }> {
  const user = await requireUser();
  await assertContributor(input.chronicleId, user.id);
  const p = input.proposal;

  // Only trust the conversation id if that conversation belongs to the caller.
  const convo = input.conversationId ? await getConversation(input.conversationId) : null;
  const conversationId = convo && convo.userId === user.id ? convo.id : null;

  // Idempotency guard: an identical story of mine in this chronicle means this exact
  // draft was already accepted (e.g. a re-shown card) — return it instead of duplicating.
  const existing = await listChronicleStoryTexts(input.chronicleId);
  const duplicate = existing.find(
    (s) =>
      s.submittedBy === user.id &&
      normalizeText(s.title) === normalizeText(p.title || 'Untitled story') &&
      normalizeText(s.bodyStyled ?? s.bodyOriginal ?? '') === normalizeText(p.body),
  );
  if (duplicate) return { storyId: duplicate.id };

  // Resolve any named people to existing tree members in this chronicle (best-effort).
  let personIds: string[] = [];
  if (p.people?.length) {
    const chroniclePeople = await listChroniclePeople(input.chronicleId);
    const byName = new Map(chroniclePeople.map((fp) => [fp.displayName.toLowerCase(), fp.id]));
    personIds = p.people
      .map((name) => byName.get(name.trim().toLowerCase()))
      .filter((id): id is string => Boolean(id));
  }

  const story = await createStory({
    userId: user.id,
    title: p.title || 'Untitled story',
    summary: p.summary || null,
    // The user's verbatim words are the raw source; the styled draft is only a
    // fallback for cards persisted before sourceText existed.
    bodyOriginal: p.sourceText?.trim() || p.body,
    bodyStyled: p.body,
    inputType: 'chat',
    status: 'ready',
    eventDate: yearToDate(p.eventYear),
    eventDatePrecision: p.eventYear ? 'year' : null,
    conversationId,
    chronicleIds: [input.chronicleId],
    personIds,
  });

  // Carry the chat's raw uploads (voice + photos) onto the story for traceability.
  // Only the ones no earlier story from this chat already claimed.
  if (conversationId) {
    await claimChatAssetsForStory(conversationId, story.id);
    // The receipt on the note renders as a persistent ✓ chip in the chat.
    const chronicle = await getChronicle(input.chronicleId);
    const receipt: Receipt = {
      label: `Saved "${story.title}"${chronicle ? ` to ${chronicle.name}` : ''}`,
      detail: 'View story',
      href: `/stories/${story.id}`,
    };
    await resolveDraftCard(conversationId);
    await addMessage(
      conversationId,
      'system',
      `[The user accepted the draft card and saved "${story.title}" as a story (id ${story.id}). ` +
        'It is already stored — do not draft or save it again.]',
      { receipts: [receipt] },
    );
  }

  revalidatePath('/stories');
  return { storyId: story.id };
}

/** Accept a reviewed story revision → update the existing story in place. */
export async function applyStoryUpdate(input: {
  storyId: string;
  proposal: StoryProposal;
  conversationId?: string | null;
}): Promise<{ storyId: string }> {
  const user = await requireUser();
  const p = input.proposal;
  const result = await applyStoryEdit({
    storyId: input.storyId,
    userId: user.id,
    title: p.title,
    summary: p.summary || null,
    body: p.body,
    eventYear: p.eventYear,
    appendSource: p.sourceText ?? null,
  });
  if (!result.ok) throw new Error(result.error);

  // Only write the note if the conversation belongs to the caller.
  const convo = input.conversationId ? await getConversation(input.conversationId) : null;
  if (convo && convo.userId === user.id) {
    const receipt: Receipt = {
      label: `Updated "${p.title}"`,
      detail: 'View story',
      href: `/stories/${input.storyId}`,
    };
    await resolveDraftCard(convo.id);
    await addMessage(
      convo.id,
      'system',
      `[The user accepted the revision card — the story "${p.title}" (id ${input.storyId}) is updated.]`,
      { receipts: [receipt] },
    );
  }

  revalidatePath('/stories');
  revalidatePath(`/stories/${input.storyId}`);
  return { storyId: input.storyId };
}

/** Record that the user discarded a draft card, so the agent doesn't assume it was saved. */
export async function discardStoryDraft(input: {
  conversationId: string;
  title: string;
}): Promise<void> {
  const user = await requireUser();
  const convo = await getConversation(input.conversationId);
  if (!convo || convo.userId !== user.id) return;
  await resolveDraftCard(input.conversationId);
  await addMessage(
    input.conversationId,
    'system',
    `[The user discarded the story draft card "${input.title}" without saving. Do not save it; ` +
      'if they want a story about this later, draft a fresh card.]',
  );
}
