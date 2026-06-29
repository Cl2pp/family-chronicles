'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/session';
import {
  addMessage,
  createConversation,
  getConversation,
  listMessages,
} from '@/lib/conversations';
import { chatRespond, type ChatTurn, type Proposal, type StoryProposal, type TreeProposal } from '@/lib/ai/chat';
import { createStory } from '@/lib/stories';
import { createPerson, connectPeople, listFamilyPeople } from '@/lib/people';

function yearToDate(year: number | null): Date | null {
  if (!year || Number.isNaN(year)) return null;
  return new Date(Date.UTC(year, 0, 1));
}

export interface SendResult {
  conversationId: string;
  reply: string;
  proposal: Proposal | null;
}

/** Persist the user's message, get the assistant's reply + optional proposal. */
export async function sendMessage(input: {
  conversationId: string | null;
  familyId: string | null;
  text: string;
}): Promise<SendResult> {
  const user = await requireUser();
  const text = input.text.trim();
  if (!text) throw new Error('Empty message');

  let conversationId = input.conversationId;
  if (!conversationId) {
    const convo = await createConversation(user.id, input.familyId);
    conversationId = convo.id;
  } else {
    const convo = await getConversation(conversationId);
    if (!convo || convo.userId !== user.id) throw new Error('Conversation not found');
  }

  await addMessage(conversationId, 'user', text);

  const stored = await listMessages(conversationId);
  const history: ChatTurn[] = stored
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  const result = await chatRespond(history);
  await addMessage(conversationId, 'assistant', result.reply);

  return { conversationId, reply: result.reply, proposal: result.proposal };
}

/** Accept a story draft → create a ready story shared into the given family. */
export async function acceptStory(input: {
  conversationId: string;
  familyId: string;
  proposal: StoryProposal;
}): Promise<{ storyId: string }> {
  const user = await requireUser();
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
  revalidatePath('/stories');
  return { storyId: story.id };
}

/** Accept a tree change → create the person and (if possible) connect them. */
export async function acceptTree(input: {
  familyId: string;
  proposal: TreeProposal;
}): Promise<{ ok: true; personName: string }> {
  const user = await requireUser();
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
