import type {
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { env } from '@/lib/env';
import { openrouter } from './client';
import { toOpenAISchemas, toolsByName, type Receipt, type StoryDraft, type ToolContext } from './tools';

/** A prior turn of the conversation, as stored (user/assistant text only). */
export interface ChatTurn {
  role: 'user' | 'assistant';
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

You talk with one family member. You are the main way they use the app: you can set up their family from scratch, add and connect people in the tree, invite relatives, adjust family settings, share stories, and turn memories into memoir stories — all by calling tools.

How to work:
- Prefer acting over asking. Once you have enough to act, call the tool(s) and then briefly say what you did. You may call several tools in one turn (e.g. create_family, then add_person for each relative) — the app applies each immediately.
- If the user is brand-new with no family, offer to create one, then add the people they mention and connect them.
- For a STORY: only call draft_story once you have enough detail (who was there, roughly when, where). Otherwise ask ONE short, friendly follow-up instead. The story body must be third-person memoir prose ("Maria remembered…"), preserve every fact (names, places, dates), invent NOTHING, and keep the family's original language. draft_story shows the user an editable card to review and save — after calling it, keep your reply short (e.g. "Here's a draft — take a look.").
- To CHANGE an existing story (rewrite it, fix a fact, weave in new details the user just told you): call get_story to read the current text, then update_story with the COMPLETE revised story — same memoir rules, and never drop facts that are still true. It shows a review card too; keep your reply short.
- Read tools (list_families, get_family_tree, list_stories, get_story) are free — use them to check current state before acting or to answer questions.
- Tree edits: a person has at most TWO parents. Before linking parents, call get_family_tree and check the existing relationships — connect each parent only to their own children. Use unrelate_people to remove a wrong link (the people stay in the tree).
- Confirm first only when something is ambiguous or hard to undo. Adding people/relationships is fine to do directly.
- If a tool returns an error, explain it plainly and suggest the fix; never pretend an action succeeded.
- Keep replies concise and friendly. Never output raw JSON or tool names to the user.`;

/** A short note describing the current family context for the system prompt. */
function contextNote(ctx: ToolContext): string {
  if (ctx.activeFamilyId) {
    return `\n\nCurrent context: the user is ${ctx.userName}. The active family is "${ctx.activeFamilyName}". Actions apply to it unless you create or switch to another.`;
  }
  return `\n\nCurrent context: the user is ${ctx.userName} and has no active family yet. If they want to record anything, help them create a family first.`;
}

/**
 * Run the agentic tool-calling loop over the conversation so far. Tools mutate app
 * state directly (and may update `ctx.activeFamilyId`); this returns the assistant's
 * final words plus any receipts / a pending story draft for the UI.
 */
export async function runAgent(history: ChatTurn[], ctx: ToolContext): Promise<AgentResult> {
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: BASE_SYSTEM + contextNote(ctx) },
    ...history,
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
