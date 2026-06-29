import OpenAI from 'openai';
import { env } from '@/lib/env';

/**
 * Conversational "family chronicler" assistant. It chats with a family member and,
 * when ready, emits a structured proposal — either a STORY draft or a TREE change —
 * which the UI renders as an accept/edit card. Uses the same OpenRouter endpoint as
 * styling (model = STYLING_MODEL), so no extra provider.
 */
const client = new OpenAI({
  apiKey: env.OPENROUTER_API_KEY,
  baseURL: env.OPENROUTER_BASE_URL,
  defaultHeaders: {
    'HTTP-Referer': env.BETTER_AUTH_URL,
    'X-Title': 'Family Chronicle',
  },
});

export interface StoryProposal {
  kind: 'story';
  title: string;
  summary: string;
  body: string;
  eventYear: number | null;
  people: string[];
}

export interface TreeProposal {
  kind: 'tree';
  personName: string;
  relativeName: string | null;
  relation: 'parent' | 'child' | 'partner' | null;
  bornYear: number | null;
  diedYear: number | null;
}

export type Proposal = StoryProposal | TreeProposal;

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  reply: string;
  proposal: Proposal | null;
}

const SYSTEM = `You are the warm, attentive family chronicler for "Family Chronicle" — a private app where families turn memories into a shared third-person memoir and build a simple family tree.

You talk with one family member. You can do two things:
1. Turn a memory into a STORY (third-person memoir prose).
2. Add or relate a PERSON in the family tree.

You ALWAYS respond with a SINGLE JSON object (no markdown, no prose outside the JSON) of this exact shape:
{
  "reply": string,            // your conversational message to the user
  "proposal": null | Story | Tree
}

Story =
{ "kind": "story", "title": string, "summary": string, "body": string, "eventYear": number|null, "people": string[] }
Tree =
{ "kind": "tree", "personName": string, "relativeName": string|null, "relation": "parent"|"child"|"partner"|null, "bornYear": number|null, "diedYear": number|null }

Rules:
- If you still need detail (who was there, roughly when, where), keep "proposal": null and ask ONE short, friendly follow-up in "reply".
- When you have enough for a story, fill a Story proposal. The "body" must be third-person memoir prose ("Maria remembered…"), preserve every fact (names, places, dates), invent NOTHING, and keep the family's original language. "summary" is one short sentence on what it's about. "people" lists names of people featured.
- When the user wants to add/relate someone to the tree, fill a Tree proposal. "relation" is the new person's relation to "relativeName" (an existing relative they mention), e.g. "parent", "child", or "partner"; use null if unknown.
- Only ever produce ONE proposal per message. When you propose, keep "reply" short (e.g. "Here's a draft — take a look.").
- Never include a proposal AND ask for more info at the same time.`;

function safeParse(raw: string): ChatResult {
  let text = raw.trim();
  // Strip code fences if the model added them.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  // Fall back to the first balanced object.
  if (!text.startsWith('{')) {
    const start = text.indexOf('{');
    if (start >= 0) text = text.slice(start);
  }
  try {
    const obj = JSON.parse(text) as Partial<ChatResult>;
    const reply = typeof obj.reply === 'string' && obj.reply.trim() ? obj.reply : '…';
    const proposal = obj.proposal && typeof obj.proposal === 'object' ? (obj.proposal as Proposal) : null;
    return { reply, proposal };
  } catch {
    // Not JSON — treat the whole thing as a plain reply.
    return { reply: raw.trim() || 'Sorry, could you say that again?', proposal: null };
  }
}

export async function chatRespond(history: ChatTurn[]): Promise<ChatResult> {
  const completion = await client.chat.completions.create({
    model: env.STYLING_MODEL,
    messages: [{ role: 'system', content: SYSTEM }, ...history],
    response_format: { type: 'json_object' },
  });
  const content = completion.choices[0]?.message?.content ?? '';
  return safeParse(content);
}
