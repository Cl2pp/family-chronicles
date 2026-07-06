'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/session';
import { resolveActiveFamily, getMembership } from '@/lib/families';
import {
  addAttachments,
  addMessage,
  createConversation,
  getConversation,
  listConversationAttachments,
  listMessages,
  type AttachmentInput,
} from '@/lib/conversations';
import { runAgent, type ChatTurn } from '@/lib/ai/agent';
import type { Receipt, StoryDraft, StoryProposal, ToolContext, UndoAction } from '@/lib/ai/tools';
import { addStoryAssets, applyStoryEdit, createStory } from '@/lib/stories';
import {
  canUserEditPerson,
  deletePerson,
  getPerson,
  listFamilyPeople,
  removeRelationship,
} from '@/lib/people';
import { canContribute, type AccessRole } from '@/lib/permissions';
import { yearToDate } from '@/lib/dates';
import { buildKey, getObjectBuffer, presignPut } from '@/lib/s3';
import { transcribeAudio } from '@/lib/ai/groq';

/** Throw unless the user can contribute to the family (create stories / tree). */
async function assertContributor(familyId: string, userId: string) {
  const membership = await getMembership(familyId, userId);
  if (!membership) throw new Error('You do not have access to this family.');
  if (!canContribute(membership.accessRole as AccessRole)) {
    throw new Error('You do not have permission to add to this family.');
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

/** Build the mutable per-turn tool context from the resolved active family. */
function makeContext(
  userId: string,
  userName: string,
  active: { id: string; name: string } | undefined,
): ToolContext {
  const ctx: ToolContext = {
    userId,
    userName,
    activeFamilyId: active?.id ?? null,
    activeFamilyName: active?.name ?? null,
    setActiveFamily(id, name) {
      ctx.activeFamilyId = id;
      ctx.activeFamilyName = name;
    },
  };
  return ctx;
}

/** Resolve the conversation to use (existing, owned) or create a new one. */
async function resolveConversation(
  conversationId: string | null,
  familyId: string | null,
  userId: string,
): Promise<string> {
  if (!conversationId) {
    const convo = await createConversation(userId, familyId);
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
  previousFamilyId: string | undefined,
): Promise<SendResult> {
  const stored = await listMessages(conversationId);
  const history: ChatTurn[] = stored
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  const result = await runAgent(history, ctx);
  // Persist receipts on the assistant message so the ✓ chips survive a reload.
  const metadata = result.receipts.length ? { receipts: result.receipts } : undefined;
  await addMessage(conversationId, 'assistant', result.reply, metadata);

  // A tool may have created/switched the active family — persist it to the cookie.
  if (ctx.activeFamilyId && ctx.activeFamilyId !== previousFamilyId) {
    (await cookies()).set('activeFamilyId', ctx.activeFamilyId, { path: '/' });
  }
  // Any applied action may have changed the family tree or stories pages.
  if (result.receipts.length) {
    revalidatePath('/family');
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

  const previousFamilyId = (await cookies()).get('activeFamilyId')?.value;
  const { active } = await resolveActiveFamily(user.id, previousFamilyId);
  const ctx = makeContext(user.id, user.name, active);

  const conversationId = await resolveConversation(input.conversationId, ctx.activeFamilyId, user.id);
  const message = await addMessage(conversationId, 'user', text);
  if (input.attachments?.length) await addAttachments(message.id, input.attachments);

  return respondAndStore(conversationId, ctx, previousFamilyId);
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
  } catch {
    throw new Error("Sorry — I couldn't transcribe that recording. Please try again.");
  }

  const previousFamilyId = (await cookies()).get('activeFamilyId')?.value;
  const { active } = await resolveActiveFamily(user.id, previousFamilyId);
  const ctx = makeContext(user.id, user.name, active);

  const conversationId = await resolveConversation(input.conversationId, ctx.activeFamilyId, user.id);
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

  const result = await respondAndStore(conversationId, ctx, previousFamilyId);
  return { ...result, transcript };
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

  revalidatePath('/family');
  return { ok: true };
}

/** Accept a story draft → create a ready story shared into the given family. */
export async function acceptStory(input: {
  conversationId: string;
  familyId: string;
  proposal: StoryProposal;
}): Promise<{ storyId: string }> {
  const user = await requireUser();
  await assertContributor(input.familyId, user.id);
  const p = input.proposal;

  // Resolve any named people to existing tree members in this family (best-effort).
  let personIds: string[] = [];
  if (p.people?.length) {
    const familyPeople = await listFamilyPeople(input.familyId);
    const byName = new Map(familyPeople.map((fp) => [fp.displayName.toLowerCase(), fp.id]));
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
    conversationId: input.conversationId,
    familyIds: [input.familyId],
    personIds,
  });

  // Carry the chat's raw uploads (voice + photos) onto the story for traceability.
  if (input.conversationId) {
    const attachments = await listConversationAttachments(input.conversationId);
    await addStoryAssets(story.id, attachments);
  }

  revalidatePath('/stories');
  return { storyId: story.id };
}

/** Accept a reviewed story revision → update the existing story in place. */
export async function applyStoryUpdate(input: {
  storyId: string;
  proposal: StoryProposal;
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

  revalidatePath('/stories');
  revalidatePath(`/stories/${input.storyId}`);
  return { storyId: input.storyId };
}
