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
  listConversationAttachments,
  listMessages,
  type AttachmentInput,
} from '@/lib/conversations';
import { runAgent, type ChatTurn } from '@/lib/ai/agent';
import type { Receipt, StoryDraft, StoryProposal, ToolContext, UndoAction } from '@/lib/ai/tools';
import { addStoryAssets, applyStoryEdit, createStory, listChronicleStoryTexts } from '@/lib/stories';
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
import { buildKey, getObjectBuffer, presignPut } from '@/lib/s3';
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

/** A presigned URL the browser uses to PUT an in-chat upload straight to storage. */
export async function presignUpload(input: {
  kind: 'audio' | 'photo';
  mimeType: string;
  filename?: string;
}): Promise<{ url: string; s3Key: string }> {
  await requireUser();
  const prefix = input.kind === 'audio' ? 'chat/audio' : 'chat/photos';
  const s3Key = buildKey(prefix, input.filename ?? input.mimeType.replace('/', '.'));
  const url = await presignPut(s3Key, input.mimeType);
  return { url, s3Key };
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
  const history: ChatTurn[] = stored
    .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
    .map((m) => ({ role: m.role as ChatTurn['role'], content: m.content }));

  const result = await runAgent(history, ctx);
  // Persist receipts on the assistant message so the ✓ chips survive a reload.
  const metadata = result.receipts.length ? { receipts: result.receipts } : undefined;
  await addMessage(conversationId, 'assistant', result.reply, metadata);
  // Record the draft card as a system event so later turns know it exists and
  // that only the user can act on it (prevents "should I save it?" re-drafts).
  if (result.storyDraft) {
    const draftTitle = result.storyDraft.proposal.title;
    await addMessage(
      conversationId,
      'system',
      `[A story draft card "${draftTitle}" is now showing. Only the user can save or discard it ` +
        'on the card; a note will appear here once they do. Do not draft it again or offer to save it. ' +
        'Exception: if no saved/discarded note ever appears and the user asks about this story again, ' +
        'the card was lost (e.g. page reload) — draft it afresh then.]',
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
  if (!text) throw new Error('Empty message');

  const previousChronicleId = (await cookies()).get('activeChronicleId')?.value;
  const { active } = await resolveActiveChronicle(user.id, previousChronicleId);
  const ctx = makeContext(user.id, user.name, active);

  const conversationId = await resolveConversation(input.conversationId, ctx.activeChronicleId, user.id);
  const message = await addMessage(conversationId, 'user', text);
  if (input.attachments?.length) await addAttachments(message.id, input.attachments);

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
    bodyOriginal: p.body,
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
  if (conversationId) {
    const attachments = await listConversationAttachments(conversationId);
    await addStoryAssets(story.id, attachments);
    // The receipt on the note renders as a persistent ✓ chip in the chat.
    const chronicle = await getChronicle(input.chronicleId);
    const receipt: Receipt = {
      label: `Saved "${story.title}"${chronicle ? ` to ${chronicle.name}` : ''}`,
      detail: 'View story',
      href: `/stories/${story.id}`,
    };
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
  await addMessage(
    input.conversationId,
    'system',
    `[The user discarded the story draft card "${input.title}" without saving. Do not save it; ` +
      'if they want a story about this later, draft a fresh card.]',
  );
}
