import type {
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { env } from '@/lib/env';
import { openrouter } from './client';
import { toOpenAISchemas, toolsByName, type Receipt, type StoryDraft, type ToolContext } from './tools';

/**
 * A prior turn of the conversation, as stored. `system` turns are app events the
 * model must know about (draft card saved/discarded), not user or assistant words.
 */
export interface ChatTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AgentResult {
  reply: string;
  receipts: Receipt[];
  storyDraft: StoryDraft | null;
}

/** How many think→act rounds the agent may take before it must answer in words. */
const MAX_STEPS = 8;

const BASE_SYSTEM = `You are the warm, attentive family chronicler for "Family Chronicle" — a private app where families turn memories into a shared third-person memoir and build a simple family tree.

You talk with one family member. Their private space is a CHRONICLE: it holds the stories, the tree, and who has access. You are the main way they use the app: you can set up their chronicle from scratch, add and connect people in the tree, invite relatives, adjust chronicle settings, share stories, and turn memories into memoir stories — all by calling tools.

Families are never set up manually. A "family" is an automatic tag derived from surnames and kinship: everyone with the same last name, plus spouses who married in, inherited up through parents. One person can carry several family tags (e.g. an Ortlepp married to a Hartwick is in both). If the user asks to create or manage a family, explain this and make sure people's surnames and relationships are recorded instead — the tags follow on their own.

How to work:
- Prefer acting over asking. Once you have enough to act, call the tool(s) and then briefly say what you did. You may call several tools in one turn (e.g. create_chronicle, then add_person for each relative) — the app applies each immediately.
- If the user is brand-new with no chronicle, offer to create one, then add the people they mention and connect them.
- For a STORY: only call draft_story once you have enough detail (who was there, roughly when, where). Otherwise ask ONE short, friendly follow-up instead. The story body must be third-person memoir prose ("Maria remembered…"), preserve every fact (names, places, dates), invent NOTHING, and keep the family's original language. Always pass the user's own messages VERBATIM as sourceText — they become the story's permanent source material. draft_story shows the user an editable card to review and save — after calling it, keep your reply short (e.g. "Here's a draft — take a look.").
- The draft card is the ONLY way a story gets saved. You cannot save it and must NEVER ask "should I save it?" — the user saves or discards it on the card. Bracketed [system] notes in the conversation tell you when a card was saved or discarded; trust them. A card stays on screen across reloads until the user acts on it, so never call draft_story again for the same story unless the user asks for changes before saving (and if they do, note in your reply that the previous card should be discarded).
- Never record the same event twice. If a memory sounds like one that may already be recorded, check list_stories first: when a matching story exists, offer to update it (get_story → update_story) instead of drafting a duplicate.
- To CHANGE an existing story (rewrite it, fix a fact, weave in new details the user just told you): call get_story to read the current text, then update_story with the COMPLETE revised story — same memoir rules, and never drop facts that are still true. When the revision comes from new details the user just told you, pass those messages VERBATIM as newSourceText so they are appended to the story's source history. It shows a review card too; keep your reply short.
- Read tools (list_chronicles, get_family_tree, list_stories, get_story) are free — use them to check current state before acting or to answer questions.
- Tree edits: a person has at most TWO parents. Before linking parents, call get_family_tree and check the existing relationships — connect each parent only to their own children. Use unrelate_people to remove a wrong link (the people stay in the tree).
- Confirm first only when something is ambiguous or hard to undo. Adding people/relationships is fine to do directly.
- If a tool returns an error, explain it plainly and suggest the fix; never pretend an action succeeded.
- Keep replies concise and friendly. Never output raw JSON or tool names to the user.`;

/**
 * Flatten the stored conversation into turns the model will accept.
 *
 * Stored `system` turns are app events (a draft card appeared / was saved / was
 * discarded). They must NOT go over the wire as `role: 'system'`: providers hoist the
 * leading system prompt out of the array, and Anthropic then rejects any remaining
 * `system` message that follows a plain assistant turn ("messages.2: role 'system' must
 * follow a 'user' message…") — which permanently wedges the conversation, since history
 * is replayed from storage on every turn. They ride along as the bracketed user notes the
 * system prompt already tells the model to trust. Consecutive user turns are merged so
 * the array stays strictly alternating.
 */
function toModelTurns(history: ChatTurn[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const turn of history) {
    if (!turn.content.trim()) continue;
    const role = turn.role === 'assistant' ? 'assistant' : 'user';
    const prev = turns[turns.length - 1];
    if (role === 'user' && prev?.role === 'user') {
      prev.content = `${prev.content}\n\n${turn.content}`;
      continue;
    }
    turns.push({ role, content: turn.content });
  }
  return turns;
}

/** A short note describing the current chronicle context for the system prompt. */
function contextNote(ctx: ToolContext): string {
  if (ctx.activeChronicleId) {
    return `\n\nCurrent context: the user is ${ctx.userName}. The active chronicle is "${ctx.activeChronicleName}". Actions apply to it unless you create or switch to another.`;
  }
  return `\n\nCurrent context: the user is ${ctx.userName} and has no active chronicle yet. If they want to record anything, help them create a chronicle first.`;
}

/**
 * Run the agentic tool-calling loop over the conversation so far. Tools mutate app
 * state directly (and may update `ctx.activeChronicleId`); this returns the assistant's
 * final words plus any receipts / a pending story draft for the UI.
 */
export async function runAgent(history: ChatTurn[], ctx: ToolContext): Promise<AgentResult> {
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: BASE_SYSTEM + contextNote(ctx) },
    ...toModelTurns(history),
  ];
  const schemas = toOpenAISchemas();
  const receipts: Receipt[] = [];
  let storyDraft: StoryDraft | null = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    const lastStep = step === MAX_STEPS - 1;
    const completion = await openrouter.chat.completions.create({
      model: env.STYLING_MODEL,
      messages,
      tools: schemas,
      tool_choice: lastStep ? 'none' : 'auto',
    });
    const msg = completion.choices[0]?.message;
    const toolCalls = msg?.tool_calls ?? [];

    if (!toolCalls.length) {
      const reply = (msg?.content ?? '').trim() || 'Done.';
      return { reply, receipts, storyDraft };
    }

    // Record the assistant's tool-call turn, then run each call and feed results back.
    messages.push({ role: 'assistant', content: msg?.content ?? '', tool_calls: toolCalls });

    for (const call of toolCalls) {
      if (call.type !== 'function') continue;
      const content = await runToolCall(call.function.name, call.function.arguments, ctx, (r) => {
        if (r.receipt) receipts.push(r.receipt);
        if (r.storyDraft) storyDraft = r.storyDraft;
      });
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }

  return { reply: 'Done.', receipts, storyDraft };
}

/** Validate + execute a single tool call, returning the text to feed back to the model. */
async function runToolCall(
  name: string,
  rawArgs: string,
  ctx: ToolContext,
  onSuccess: (r: { receipt?: Receipt; storyDraft?: StoryDraft }) => void,
): Promise<string> {
  const tool = toolsByName.get(name);
  if (!tool) return `Error: unknown tool "${name}".`;

  let parsedArgs: unknown;
  try {
    parsedArgs = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return 'Error: arguments were not valid JSON.';
  }

  const validated = tool.schema.safeParse(parsedArgs);
  if (!validated.success) {
    const issues = validated.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return `Error: invalid arguments — ${issues}`;
  }

  try {
    const result = await tool.execute(validated.data, ctx);
    if (result.ok) {
      onSuccess({ receipt: result.receipt, storyDraft: result.storyDraft });
      return result.message;
    }
    return `Error: ${result.error}`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : 'the action failed unexpectedly.'}`;
  }
}
