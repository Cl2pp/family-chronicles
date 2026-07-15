import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { env } from '@/lib/env';
import { openrouter } from './client';
import {
  toOpenAISchemas,
  tools,
  type Receipt,
  type StoryDraft,
  type Tool,
  type ToolContext,
} from './tools';

/**
 * A prior turn of the conversation, as stored. `system` turns are app events the
 * model must know about (draft card saved/discarded), not user or assistant words.
 */
export interface ChatTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Presigned URLs of photos the user attached to this turn (user turns only). */
  imageUrls?: string[];
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
- The draft card is the DEFAULT way a story gets saved: the user saves or discards it on the card, and you must NEVER ask "should I save it?". Bracketed [system] notes in the conversation tell you when a card was saved or discarded; trust them. A card stays on screen across reloads until the user acts on it, so never call draft_story again for the same story unless the user asks for changes before saving (and if they do, note in your reply that the previous card should be discarded).
- EXCEPTION: when the user EXPLICITLY asks you to save directly — "just save it", "save it without the card", or they say the card never appeared or they cannot use it — call save_story with the complete story content (same memoir rules; reuse the shown draft's content plus any corrections they asked for since). It saves a new story, or updates an existing one when you pass its title/id. It also clears any pending card. Never use save_story without such an explicit request.
- Never record the same event twice. If a memory sounds like one that may already be recorded, check list_stories first: when a matching story exists, offer to update it (get_story → update_story) instead of drafting a duplicate.
- To CHANGE an existing story (rewrite it, fix a fact, weave in new details the user just told you): call get_story to read the current text, then update_story with the COMPLETE revised story — same memoir rules, and never drop facts that are still true. When the revision comes from new details the user just told you, pass those messages VERBATIM as newSourceText so they are appended to the story's source history. It shows a review card too; keep your reply short.
- The user may attach PHOTOS. You can see them. Use what they show — who is in them, the place, the era, the occasion — to ask better questions and to ground the story. Never invent details you cannot actually see, and never describe a photo back to the user as if listing its contents; talk about the memory, not the image file. Photos the user sends are saved with the story automatically.
- Read tools (list_chronicles, get_family_tree, list_stories, get_story, list_books, get_book) are free — use them to check current state before acting or to answer questions.
- BOOKS: the user can turn stories into a printed hardcover. create_book starts one (all ready stories, chronological); get_book then set_book_stories re-orders/removes chapters (always pass the complete new list); update_book changes title/subtitle/dedication/format; render_book_preview queues the PDF preview they view on the book page; design_book_layout queues an AI redesign of the photo layout (cover choice, photo placement, page rhythm) — mention it takes about a minute and they'll see it in the book's preview, and never call it more than once per request; update_book_layout makes targeted layout edits instead (theme, cover style/photo, one photo's size or its own page, reordering a chapter's photos) — call get_book first, it lists every placed photo's assetId and current placement to address; reset_book_layout rebuilds the automatic layout, keeping theme/cover; design_book_layout and reset_book_layout both ask for confirmation (overwriteEdits) if the layout has manual edits — only pass it once the user confirms; quote_book_price answers "what would it cost?"; delete_book permanently deletes a book (the stories and photos stay) — only on an explicit, unambiguous request to delete it, never to tidy up on your own. You cannot place the order — that is a button on the book page; point the user there when they are happy with the preview.
- Tree edits: a person has at most TWO parents. Before linking parents, call get_family_tree and check the existing relationships — connect each parent only to their own children. Use unrelate_people to remove a wrong link (the people stay in the tree).
- Confirm first only when something is ambiguous or hard to undo. Adding people/relationships is fine to do directly.
- If a tool returns an error, explain it plainly and suggest the fix; never pretend an action succeeded.
- Keep replies concise and friendly. Never output raw JSON or tool names to the user.
- Replies render as Markdown. Light formatting (bold names, short bullet lists) is welcome; avoid headings and tables in chat.`;

/**
 * How many of the conversation's most recent photos ride along to the model. A long
 * chat can accumulate dozens; every one costs tokens on every subsequent turn.
 */
const MAX_IMAGES = 8;

interface MergedTurn {
  role: 'user' | 'assistant';
  content: string;
  imageUrls: string[];
  /** Photos the turn carried, even if none of them ended up being sent. */
  photoCount: number;
}

/** Stands in for photos the model won't receive, so the turn never silently vanishes. */
function photoNote(count: number): string {
  return `[The user attached ${count} photo${count === 1 ? '' : 's'}, not shown to you.]`;
}

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
 *
 * A user turn carrying photos becomes multimodal content so the agent can actually see
 * what it's being asked to write about. Only the newest `MAX_IMAGES` survive.
 */
function toModelTurns(history: ChatTurn[]): ChatCompletionMessageParam[] {
  const merged: MergedTurn[] = [];
  for (const turn of history) {
    const role = turn.role === 'assistant' ? 'assistant' : 'user';
    // Count photos before vision is applied: a photo-only turn is still a turn, even
    // when the model won't see the images.
    const photoCount = role === 'user' ? (turn.imageUrls?.length ?? 0) : 0;
    const imageUrls = env.AGENT_VISION && role === 'user' ? [...(turn.imageUrls ?? [])] : [];
    if (!turn.content.trim() && photoCount === 0) continue;

    const prev = merged[merged.length - 1];
    if (role === 'user' && prev?.role === 'user') {
      prev.content = [prev.content, turn.content].filter((c) => c.trim()).join('\n\n');
      prev.imageUrls.push(...imageUrls);
      prev.photoCount += photoCount;
      continue;
    }
    merged.push({ role, content: turn.content, imageUrls, photoCount });
  }

  // Budget images from the end of the conversation backwards — the photos the user
  // just sent matter more than ones from twenty turns ago.
  let budget = MAX_IMAGES;
  for (let i = merged.length - 1; i >= 0; i--) {
    const urls = merged[i].imageUrls;
    const keep = Math.min(budget, urls.length);
    merged[i].imageUrls = urls.slice(urls.length - keep);
    budget -= keep;
  }

  return merged.map((turn) => {
    // Photos the model never received (vision off, or past the budget) still get a
    // note — otherwise a photo-only turn would drop out of the history entirely.
    const unsent = turn.photoCount - turn.imageUrls.length;
    const text = [turn.content, unsent > 0 ? photoNote(unsent) : '']
      .filter((c) => c.trim())
      .join('\n\n');

    if (turn.role === 'assistant' || turn.imageUrls.length === 0) {
      return { role: turn.role, content: text };
    }
    const parts: ChatCompletionContentPart[] = turn.imageUrls.map((url) => ({
      type: 'image_url',
      image_url: { url },
    }));
    if (text) parts.unshift({ type: 'text', text });
    return { role: 'user', content: parts };
  });
}

/**
 * Anthropic prompt caching, passed through OpenRouter. `cache_control` on a content
 * part marks a cache breakpoint: everything up to it (tool schemas → system → messages)
 * is cached per user+chronicle for ~5 minutes, so each follow-up turn — and each
 * think→act step inside one turn — re-reads the prefix at ~10% of the token price
 * instead of re-paying for the whole conversation. The field is an Anthropic extension
 * the OpenAI SDK types don't know, hence the local part type; non-Anthropic models
 * simply ignore it.
 */
const CACHE_CONTROL = { type: 'ephemeral' } as const;

type CacheablePart = { type: string; cache_control?: typeof CACHE_CONTROL } & Record<
  string,
  unknown
>;

/** Copy a message with a cache breakpoint on its last content part (string content is
 * wrapped into a text part first). Messages without content are returned unmarked. */
function withBreakpoint(msg: ChatCompletionMessageParam): ChatCompletionMessageParam {
  let parts: CacheablePart[];
  if (typeof msg.content === 'string') {
    if (!msg.content) return msg;
    parts = [{ type: 'text', text: msg.content }];
  } else if (Array.isArray(msg.content) && msg.content.length) {
    parts = (msg.content as unknown as CacheablePart[]).map((p) => ({ ...p }));
  } else {
    return msg;
  }
  parts[parts.length - 1] = { ...parts[parts.length - 1], cache_control: CACHE_CONTROL };
  return { ...msg, content: parts } as unknown as ChatCompletionMessageParam;
}

/**
 * Return a copy of the conversation with (at most) three cache breakpoints — Anthropic
 * allows four per request:
 *  1. the system prompt — stable per user+chronicle, caches the tool schemas with it;
 *  2. the second-to-last user turn — a read point that survives from the previous turn;
 *  3. the final message — extends the cache over the newest turn, and over each batch
 *     of tool results as the in-turn loop grows the array.
 * Rebuilt fresh before every model call so the underlying array never accumulates stale
 * markers.
 */
function withCacheBreakpoints(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  const marked = [...messages];
  const mark = (i: number) => {
    marked[i] = withBreakpoint(marked[i]);
  };

  if (marked[0]?.role === 'system') mark(0);
  const userIndexes = marked.flatMap((m, i) => (m.role === 'user' ? [i] : []));
  const prevUser = userIndexes[userIndexes.length - 2];
  if (prevUser !== undefined) mark(prevUser);
  if (marked.length > 1) mark(marked.length - 1);

  return marked;
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
  return runToolLoop(BASE_SYSTEM + contextNote(ctx), tools, history, ctx);
}

/** The book builder's chat only gets book tools (plus the story reads set_book_stories
 *  needs to find chapters by name) — it edits ONE book, it never drafts stories or
 *  touches the tree. Notably absent: create_book and list_books, which would invite the
 *  agent to wander off to other books. */
const BOOK_TOOL_NAMES = new Set([
  'get_book',
  'update_book',
  'set_book_stories',
  'update_book_layout',
  'reset_book_layout',
  'design_book_layout',
  'render_book_preview',
  'quote_book_price',
  'list_stories',
  'get_story',
]);
const bookTools = tools.filter((t) => BOOK_TOOL_NAMES.has(t.name));

/** System prompt for the builder-embedded book chat: same chronicler voice, but scoped
 *  hard to the one book whose live preview sits next to the chat. */
function bookSystem(book: { id: string; title: string }, ctx: ToolContext): string {
  return `You are the book design assistant inside the book builder of "Family Chronicle" — a private app where families turn memories into a shared third-person memoir. The user is looking at ONE printable hardcover book, with a live preview of it right next to this chat. Your only job is to change THIS book the way they ask, by calling tools.

The book is "${book.title}" (id ${book.id}), in the chronicle "${ctx.activeChronicleName ?? ''}". The user is ${ctx.userName}.

How to work:
- Every tool call targets this book: always pass "${book.id}" as the \`book\` argument. Never edit any other book.
- Prefer acting over asking. Once you know what they want, call the tool(s), then briefly say what you did. Only ask when the request is genuinely ambiguous.
- Call get_book first whenever you need current state — chapter order, storyIds, or a photo's assetId for layout edits (update_book_layout needs assetIds from get_book's layoutImages).
- What you can change: title/subtitle/dedication/format (update_book); which stories are chapters and their order (set_book_stories — pass the COMPLETE new list; find new stories with list_stories); theme, cover style, cover photo, a photo's size, its own page, or its order (update_book_layout); a full AI redesign of the photo layout (design_book_layout — takes about a minute, the page shows its progress; never call it twice in one request); back to the automatic layout (reset_book_layout); the price (quote_book_price).
- The live preview updates by itself right after your edits — never tell the user to refresh, re-render, or wait for changes to appear.
- design_book_layout and reset_book_layout fail asking for confirmation when the layout has manual edits — pass overwriteEdits only after the user explicitly confirms.
- Layout taste, when the user leaves the choice to you: fill the page, stay symmetric. Prefer photos side by side or in grids over lone small images; a standout photo belongs on its own full page. Avoid layouts that leave a photo stuck to one side with empty space beside it.
- You cannot place the order — that is the "Order this book" button on this page; point the user there when they're happy. You also cannot delete this book from chat — that is the trash button at the top of this page.
- If a tool returns an error, explain it plainly and suggest the fix; never pretend an action succeeded.
- Reply in the language the user writes in. Keep replies short and friendly; light Markdown is fine, never raw JSON or tool names.`;
}

/** Run the book-scoped agent loop for the builder's embedded chat. */
export async function runBookAgent(
  history: ChatTurn[],
  ctx: ToolContext,
  book: { id: string; title: string },
): Promise<AgentResult> {
  return runToolLoop(bookSystem(book, ctx), bookTools, history, ctx);
}

/** The shared think→act loop: one system prompt, one tool catalog, one conversation. */
async function runToolLoop(
  system: string,
  toolset: Tool[],
  history: ChatTurn[],
  ctx: ToolContext,
): Promise<AgentResult> {
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    ...toModelTurns(history),
  ];

  const schemas = toOpenAISchemas(toolset);
  const byName = new Map(toolset.map((t) => [t.name, t]));
  const receipts: Receipt[] = [];
  let storyDraft: StoryDraft | null = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    const lastStep = step === MAX_STEPS - 1;
    let completion;
    try {
      completion = await openrouter.chat.completions.create({
        model: env.STYLING_MODEL,
        messages: withCacheBreakpoints(messages),
        tools: schemas,
        tool_choice: lastStep ? 'none' : 'auto',
      });
    } catch (err) {
      // A model call that fails AFTER tools already mutated state must not throw the
      // turn away: nothing would be stored, and the recovery sync would re-run the
      // whole agent from history and repeat those side effects (duplicate people,
      // shares, …). Salvage the applied actions; only a clean, side-effect-free turn
      // may rethrow and be safely regenerated.
      if (receipts.length || storyDraft) {
        console.error('Agent model call failed mid-turn; salvaging applied actions:', err);
        return {
          reply: 'Something went wrong while I was finishing my reply — but the actions shown here were already applied.',
          receipts,
          storyDraft,
        };
      }
      throw err;
    }
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
      const content = await runToolCall(byName, call.function.name, call.function.arguments, ctx, (r) => {
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
  byName: Map<string, Tool>,
  name: string,
  rawArgs: string,
  ctx: ToolContext,
  onSuccess: (r: { receipt?: Receipt; storyDraft?: StoryDraft }) => void,
): Promise<string> {
  const tool = byName.get(name);
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
