'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/session';
import {
  addAttachments,
  addMessage,
  createConversation,
  getConversation,
  listConversationAttachments,
  listMessages,
  type AttachmentInput,
} from '@/lib/conversations';
import { chatRespond, type ChatTurn, type Proposal, type StoryProposal, type TreeProposal } from '@/lib/ai/chat';
import { addStoryAssets, createStory } from '@/lib/stories';
import { createPerson, connectPeople, listFamilyPeople } from '@/lib/people';
import { getMembership } from '@/lib/families';
import { canContribute, type AccessRole } from '@/lib/permissions';
import { yearToDate } from '@/lib/dates';
import { buildKey, getObjectBuffer, presignPut } from '@/lib/s3';
import { transcribeAudio } from '@/lib/ai/groq';

/** Throw unless the user is a member of the family (read/chat access). */
async function assertMember(familyId: string, userId: string) {
  const membership = await getMembership(familyId, userId);
  if (!membership) throw new Error('You do not have access to this family.');
  return membership;
}

/** Throw unless the user can contribute to the family (create stories / tree). */
async function assertContributor(familyId: string, userId: string) {
  const membership = await assertMember(familyId, userId);
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
  proposal: Proposal | null;
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

/** Run the assistant over the conversation so far and store its reply. */
async function respondAndStore(conversationId: string): Promise<SendResult> {
  const stored = await listMessages(conversationId);
  const history: ChatTurn[] = stored
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  const result = await chatRespond(history);
  await addMessage(conversationId, 'assistant', result.reply);
  return { conversationId, reply: result.reply, proposal: result.proposal };
}

/** Persist the user's message (+ any photos), get the assistant's reply + proposal. */
export async function sendMessage(input: {
  conversationId: string | null;
  familyId: string | null;
  text: string;
  attachments?: AttachmentInput[];
}): Promise<SendResult> {
  const user = await requireUser();
  const text = input.text.trim();
  if (!text) throw new Error('Empty message');
  if (input.familyId) await assertMember(input.familyId, user.id);

  const conversationId = await resolveConversation(input.conversationId, input.familyId, user.id);

  const message = await addMessage(conversationId, 'user', text);
  if (input.attachments?.length) await addAttachments(message.id, input.attachments);

  return respondAndStore(conversationId);
}

/** Transcribe an uploaded voice note, store it as the user's message, then reply. */
export async function sendVoiceMessage(input: {
  conversationId: string | null;
  familyId: string | null;
  s3Key: string;
  mimeType: string;
  bytes?: number | null;
  durationSec?: number | null;
}): Promise<SendResult & { transcript: string }> {
  const user = await requireUser();
  if (input.familyId) await assertMember(input.familyId, user.id);

  let transcript: string;
  try {
    const buffer = await getObjectBuffer(input.s3Key);
    const filename = input.s3Key.split('/').pop() ?? 'audio';
    transcript = await transcribeAudio(buffer, filename, input.mimeType);
  } catch {
    throw new Error("Sorry — I couldn't transcribe that recording. Please try again.");
  }

  const conversationId = await resolveConversation(input.conversationId, input.familyId, user.id);

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

  const result = await respondAndStore(conversationId);
  return { ...result, transcript };
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

/** Accept a tree change → create the person and (if possible) connect them. */
export async function acceptTree(input: {
  familyId: string;
  proposal: TreeProposal;
}): Promise<{ ok: true; personName: string }> {
  const user = await requireUser();
  await assertContributor(input.familyId, user.id);
  const p = input.proposal;

  const person = await createPerson({
    displayName: p.personName,
    bornOn: yearToDate(p.bornYear),
    bornPrecision: p.bornYear ? 'year' : null,
    diedOn: yearToDate(p.diedYear),
    diedPrecision: p.diedYear ? 'year' : null,
    createdBy: user.id,
    familyId: input.familyId,
  });

  if (p.relativeName && p.relation) {
    const familyPeople = await listFamilyPeople(input.familyId);
    const rel = familyPeople.find(
      (fp) => fp.displayName.toLowerCase() === p.relativeName!.toLowerCase(),
    );
    if (rel) {
      if (p.relation === 'parent') {
        await connectPeople({ type: 'parent', personFromId: person.id, personToId: rel.id, createdBy: user.id });
      } else if (p.relation === 'child') {
        await connectPeople({ type: 'parent', personFromId: rel.id, personToId: person.id, createdBy: user.id });
      } else {
        await connectPeople({ type: 'spouse', personFromId: person.id, personToId: rel.id, createdBy: user.id });
      }
    }
  }

  revalidatePath('/family');
  return { ok: true, personName: p.personName };
}
