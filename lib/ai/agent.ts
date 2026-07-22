import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import { env } from '@/lib/env';
import type { PeopleDraft } from '@/lib/people-changes';
import { openrouter, OPENROUTER_ROUTING } from './client';
import {
  bookLayoutTools,
  toOpenAISchemas,
  tools,
  type Receipt,
  type StoryDraft,
  type Tool,
  type ToolContext,
} from './tools';

/**
 * Live progress from inside the agent loop, for a streaming transport. `text` deltas
 * belong to the CURRENT step's prose; the following `step` event says what that prose
 * was: `final` — it is the reply, keep it; `tools` — it was working notes before tool
 * calls ("Let me check the tree…"), show it as status, not as a message. Each `tool`
 * event announces one call about to run, with a short, whitelisted preview of its args
 * so the client can render "Adding Leonhard Koch…" in the user's language.
 */
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'step'; kind: 'tools' | 'final' }
  | { type: 'tool'; name: string; args: Record<string, string> };

export type AgentEmit = (event: AgentEvent) => void;

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
  /** This turn's staged tree edits, if any tool pushed onto ctx.peopleDraft. */
  peopleDraft: PeopleDraft | null;
}

/** How many think→act rounds the agent may take before it must answer in words. */
const MAX_STEPS = 8;

const BASE_SYSTEM = `You are the warm, attentive family chronicler for "Familienwerk" — a private app where families turn memories into a shared third-person memoir and build a simple family tree.

You talk with one family member. Their private space is a CHRONICLE: it holds the stories, the tree, and who has access. You are the main way they use the app: you can set up their chronicle from scratch, add and connect people in the tree, invite relatives, adjust chronicle settings, share stories, and turn memories into memoir stories — all by calling tools.

Families are never set up manually. A "family" is an automatic tag derived from surnames and kinship: everyone with the same last name, plus spouses who married in, inherited up through parents. One person can carry several family tags (e.g. an Ortlepp married to a Hartwick is in both). If the user asks to create or manage a family, explain this and make sure people's surnames and relationships are recorded instead — the tags follow on their own.

How to work:
- Prefer acting over asking. Once you have enough to act, call the tool(s) and then briefly say what you did. You may call several tools in one turn (e.g. create_chronicle, then add_person for each relative). Setup tools like create_chronicle apply immediately; tree edits are staged, not applied — see below.
- If the user is brand-new with no chronicle, offer to create one, then add the people they mention and connect them.
- For a STORY: only call draft_story once you have enough detail (who was there, roughly when, where). Otherwise ask ONE short, friendly follow-up instead. The story body must be third-person memoir prose ("Maria remembered…"), preserve every fact (names, places, dates), invent NOTHING, and keep the family's original language. Always pass the user's own messages VERBATIM as sourceText — they become the story's permanent source material. draft_story shows the user an editable card to review and save — after calling it, keep your reply short (e.g. "Here's a draft — take a look.").
- The draft card is the DEFAULT way a story gets saved: the user saves or discards it on the card, and you must NEVER ask "should I save it?". Bracketed [system] notes in the conversation tell you when a card was saved or discarded; trust them. A card stays on screen across reloads until the user acts on it, so never call draft_story again for the same story unless the user asks for changes before saving (and if they do, note in your reply that the previous card should be discarded).
- EXCEPTION: when the user EXPLICITLY asks you to save directly — "just save it", "save it without the card", or they say the card never appeared or they cannot use it — call save_story with the complete story content (same memoir rules; reuse the shown draft's content plus any corrections they asked for since). It saves a new story, or updates an existing one when you pass its title/id. It also clears any pending card. Never use save_story without such an explicit request.
- Never record the same event twice. If a memory sounds like one that may already be recorded, check list_stories first: when a matching story exists, offer to update it (get_story → update_story) instead of drafting a duplicate.
- To CHANGE an existing story (rewrite it, fix a fact, weave in new details the user just told you): call get_story to read the current text, then update_story with the COMPLETE revised story — same memoir rules, and never drop facts that are still true. When the revision comes from new details the user just told you, pass those messages VERBATIM as newSourceText so they are appended to the story's source history. It shows a review card too; keep your reply short.
- The user may attach PHOTOS. You can see them. Use what they show — who is in them, the place, the era, the occasion — to ask better questions and to ground the story. Never invent details you cannot actually see, and never describe a photo back to the user as if listing its contents; talk about the memory, not the image file. Photos the user sends are saved with the story automatically.
- Read tools (list_chronicles, get_family_tree, list_stories, get_story, list_books, get_book) are free — use them to check current state before acting or to answer questions.
- BOOKS: the user can turn stories and photos into a printed hardcover. create_book starts one (all ready stories, chronological); get_book then set_book_stories re-orders/removes chapters (always pass the complete new list); update_book changes title/subtitle/dedication/format; render_book_preview queues the PDF preview they view on the book page; quote_book_price answers "what would it cost?"; delete_book permanently deletes a book (the stories and photos stay) — only on an explicit, unambiguous request to delete it, never to tidy up on your own. Designing the LAYOUT — styles, page arrangement, which photo goes where, an AI redesign — happens in the book builder's own chat next to the live preview, not here: point the user to the book page for that. You cannot place the order either — that is a button on the book page.
- Tree edits (add_person, relate_people, unrelate_people, edit_person, delete_person) are STAGED, not applied: each call adds a pending change to ONE confirmation card shown in the chat, and nothing in the tree actually changes until the user applies that card. A card exists ONLY when you actually called those tools in the CURRENT turn — an earlier reply of yours that mentions a card does NOT mean one exists now, so never announce prepared changes without having made the tool calls this turn; when the user names new people to add or connect, always make the calls first. After staging, keep your reply short (e.g. "I've prepared 3 changes — please confirm them on the card." / German: "Ich habe 3 Änderungen vorbereitet — bitte bestätige sie auf der Karte.") and NEVER say the changes are done, saved, or applied — only that they're staged/proposed and waiting for confirmation. A person has at most TWO parents — call get_family_tree first and check both existing and already-staged relationships before linking a parent; use unrelate_people to stage removing a wrong link (the people stay in the tree). While a card is still pending, do NOT stage the same changes again — wait for the user to act on it (or to ask for something different). Bracketed [system] notes tell you when the user applied or discarded the card via its own buttons; trust them and don't re-stage what they just discarded unless they ask again. If the user instead confirms in plain words ("ja, übernimm das", "yes, apply it") call confirm_people_changes; if they reject in words, call cancel_people_changes — neither is needed when they use the card's own buttons.
- Confirm first in WORDS only when something is ambiguous — tree edits already get a confirmation card, so don't also ask "should I add them?" before staging.
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
export async function runAgent(
  history: ChatTurn[],
  ctx: ToolContext,
  emit?: AgentEmit,
): Promise<AgentResult> {
  return runToolLoop(BASE_SYSTEM + contextNote(ctx), tools, history, ctx, emit);
}

/**
 * The builder chat's tool set. It edits ONE book — it never drafts stories, touches the
 * tree, or wanders to another book (hence no create_book/list_books). Since the
 * unification there is exactly one such set: a book is stories, photos, or both, so the
 * chapter tools and the layout tools belong to the same conversation.
 */
const BOOK_TOOL_NAMES = new Set([
  'get_book',
  'update_book',
  'set_book_stories',
  'render_book_preview',
  'quote_book_price',
  'list_stories',
  'get_story',
]);
const bookTools = [...tools.filter((t) => BOOK_TOOL_NAMES.has(t.name)), ...bookLayoutTools];

/** System prompt for the builder-embedded chat: the chronicler voice, scoped hard to the
 *  one book whose live preview sits next to the chat. One prompt for every book — the
 *  chapter parts simply have nothing to bite on for a book built purely from uploads. */
function bookSystem(book: { id: string; title: string }, ctx: ToolContext): string {
  return `You are the book design assistant inside the book builder of "Familienwerk" — a private app where families turn their memories and photos into a printable hardcover. The user is looking at ONE book, with a live preview of it right next to this chat. Your only job is to change THIS book the way they ask, by calling tools.

The book is "${book.title}" (id ${book.id}), in the chronicle "${ctx.activeChronicleName ?? ''}". The user is ${ctx.userName}.

A book is built from two kinds of content, and can hold either or both: STORY CHAPTERS (a written story becomes a chapter — its text flows across the page, its photos are laid out with it) and UPLOADED PHOTOS (grouped into sections of designed photo pages). Which of the two this particular book has, you learn by calling the tools — never assume.

How to work:
- Every tool call targets this book: pass "${book.id}" as the \`book\`/\`bookId\` argument. Never edit any other book.
- Prefer acting over asking. Once you know what they want, call the tool(s), then briefly say what you did. Only ask when the request is genuinely ambiguous.
- Two reads, for two different questions. get_book: the book's settings and which stories are its chapters. get_book_layout: the laid-out result — every section and page with each photo's assetId, template and caption, plus an AI analysis summary (sharpness, eyesClosed, peopleCount, sceneTags, shortDescription, aestheticScore) and the excluded/unplaced photos. That analysis is how "the blurry ones out" or "the one with Oma" resolves to actual assetIds. Call the one that answers the question you have.
- Content: which stories are chapters and their order (set_book_stories — pass the COMPLETE new list; find stories with list_stories). Settings: title/subtitle/dedication/format (update_book).
- Layout, via update_book_layout (one or more ops in one call): the style suite (set_style); the cover photo or its title/subtitle (set_cover / set_cover_title); a section's title (set_section_title); a page's template (set_page_template — the new template's photo count must match what is on the page); move a photo to another section (move_photo — it lands on its own new page) or swap two photos (swap_photos); exclude or restore a photo (exclude_photo / include_photo); reorder sections (move_section) or merge two (merge_sections); a caption (set_caption). These apply instantly. merge_sections removes a section and shifts every later index down by one, so it must be the last (or only) op in its batch, and sections holding story text refuse to merge at all — their text belongs to one specific story.
- A full AI redesign (fresh sections, titles, hero pick, templates, captions) is redesign_book — it takes about half a minute and you cannot wait for it; say it is running and that the preview will show it, then end your turn. Never call it twice in one request. It alone asks for confirmation when the layout has manual edits — pass overwriteEdits only after the user explicitly confirms replacing them.
- The live preview updates by itself after your edits — never tell the user to refresh or wait (except for the redesign, which genuinely takes time).
- You cannot place the order or download the print PDF from chat — those are buttons on this page; point the user there. You also cannot delete this book from chat — that is the trash button at the top of the page.
- Layout taste, when the user leaves the choice to you: photos are never cropped, so combine shapes that fill a page — a landscape above a pair of portraits, two portraits side by side. Give a standout photo its own page. Keep most pages to a few photos; a dense mosaic is the exception that makes the quiet pages land.
- If a tool returns an error, explain it plainly and suggest the fix; never pretend an action succeeded.
- Reply in the language the user writes in. Keep replies short and friendly; light Markdown is fine, never raw JSON or tool names.`;
}

/** Run the book-scoped agent loop for the builder's embedded chat — one runner for every
 *  book since the unification (there is no separate photo-book agent any more). */
export async function runBookAgent(
  history: ChatTurn[],
  ctx: ToolContext,
  book: { id: string; title: string },
): Promise<AgentResult> {
  return runToolLoop(bookSystem(book, ctx), bookTools, history, ctx);
}

/** Number of changes staged so far this turn. A plain function (not inlined) on purpose:
 *  TS narrows `ctx.peopleDraft` to `null` right after runToolLoop's own reset assignment
 *  and doesn't see the tool calls (elsewhere) that mutate it back — reading it through a
 *  function call keeps the type honest. */
function pendingChangeCount(ctx: ToolContext): number {
  return ctx.peopleDraft?.changes.length ?? 0;
}

/** The shared think→act loop: one system prompt, one tool catalog, one conversation. */
async function runToolLoop(
  system: string,
  toolset: Tool[],
  history: ChatTurn[],
  ctx: ToolContext,
  emit?: AgentEmit,
): Promise<AgentResult> {
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    ...toModelTurns(history),
  ];

  const schemas = toOpenAISchemas(toolset);
  const byName = new Map(toolset.map((t) => [t.name, t]));
  const receipts: Receipt[] = [];
  let storyDraft: StoryDraft | null = null;
  // The people-mutation tools push staged tree edits here (never writing the DB
  // directly) so the turn's changes land on one confirmation card. The caller may
  // pre-seed it with a still-pending card's changes — then this turn EXTENDS that
  // card instead of silently superseding it — so only default when unset.
  ctx.peopleDraft ??= null;
  // Errors from the most recent batch of tool calls only: a failure the model already
  // retried past (a later batch succeeded) must not resurface in a fallback reply.
  let lastToolErrors: string[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const lastStep = step === MAX_STEPS - 1;
    let stepResult;
    try {
      stepResult = await withKeepAlive(ctx, () =>
        completeStep(
          {
            model: env.STYLING_MODEL,
            messages: withCacheBreakpoints(messages),
            tools: schemas,
            tool_choice: lastStep ? 'none' : 'auto',
          },
          emit,
        ),
      );
    } catch (err) {
      // A model call that fails AFTER tools already mutated state must not throw the
      // turn away: nothing would be stored, and the recovery sync would re-run the
      // whole agent from history and repeat those side effects (duplicate people,
      // shares, …). Salvage the applied actions; only a clean, side-effect-free turn
      // may rethrow and be safely regenerated.
      if (receipts.length || storyDraft || ctx.peopleDraft) {
        console.error('Agent model call failed mid-turn; salvaging applied actions:', err);
        return {
          reply: 'Something went wrong while I was finishing my reply — but anything shown here (applied actions, or a card awaiting your confirmation) is still there.',
          receipts,
          storyDraft,
          peopleDraft: ctx.peopleDraft ?? null,
        };
      }
      throw err;
    }
    const { content, toolCalls, finishReason } = stepResult;

    if (!toolCalls.length) {
      emit?.({ type: 'step', kind: 'final' });
      let reply = content.trim();
      if (!reply) {
        // Never let an empty reply masquerade as success (the old fallback said
        // "Done." even when every tool call had failed).
        console.warn('Agent returned an empty reply:', {
          finishReason,
          step,
          receipts: receipts.length,
          toolErrors: lastToolErrors.length,
        });
        reply = await recoverEmptyReply(ctx, messages, schemas, receipts, lastToolErrors, pendingChangeCount(ctx));
      }
      return { reply, receipts, storyDraft, peopleDraft: ctx.peopleDraft ?? null };
    }

    // The step's prose was working notes ahead of tool calls, not the reply.
    emit?.({ type: 'step', kind: 'tools' });

    // Record the assistant's tool-call turn, then run each call and feed results back.
    messages.push({ role: 'assistant', content, tool_calls: toolCalls });

    const stepErrors: string[] = [];
    for (const call of toolCalls) {
      if (call.type !== 'function') continue;
      emit?.({ type: 'tool', name: call.function.name, args: argsPreview(call.function.arguments) });
      const toolOutput = await runToolCall(byName, call.function.name, call.function.arguments, ctx, (r) => {
        if (r.receipt) receipts.push(r.receipt);
        if (r.receipts?.length) receipts.push(...r.receipts);
        if (r.storyDraft) storyDraft = r.storyDraft;
      });
      if (toolOutput.startsWith('Error:')) stepErrors.push(toolOutput);
      messages.push({ role: 'tool', tool_call_id: call.id, content: toolOutput });
    }
    lastToolErrors = stepErrors;
  }

  // MAX_STEPS exhausted and the final forced-text step still yielded no words.
  return {
    reply: fallbackReply(receipts, lastToolErrors, pendingChangeCount(ctx)),
    receipts,
    storyDraft,
    peopleDraft: ctx.peopleDraft ?? null,
  };
}

/** One settled think→act step, whichever transport produced it. */
interface StepResult {
  content: string;
  toolCalls: ChatCompletionMessageToolCall[];
  finishReason: string | null;
}

interface StepRequest {
  model: string;
  messages: ChatCompletionMessageParam[];
  tools: ReturnType<typeof toOpenAISchemas>;
  tool_choice: 'auto' | 'none';
}

/**
 * Run one model call. With an emitter the request streams — content deltas are
 * forwarded live (the loop's following `step` event tells the client whether they
 * were the reply or just pre-tool working notes) and tool-call fragments are
 * reassembled by index; without one it's a plain request. Both paths return the
 * same settled shape, so the loop logic doesn't fork.
 */
async function completeStep(request: StepRequest, emit?: AgentEmit): Promise<StepResult> {
  if (!emit) {
    const completion = await openrouter.chat.completions.create({
      ...request,
      ...OPENROUTER_ROUTING,
    });
    const choice = completion.choices[0];
    return {
      content: choice?.message?.content ?? '',
      toolCalls: choice?.message?.tool_calls ?? [],
      finishReason: choice?.finish_reason ?? null,
    };
  }

  const stream = await openrouter.chat.completions.create({
    ...request,
    stream: true,
    ...OPENROUTER_ROUTING,
  });
  let content = '';
  let finishReason: string | null = null;
  const toolCalls: ChatCompletionMessageFunctionToolCall[] = [];
  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    if (!choice) continue;
    if (choice.delta?.content) {
      content += choice.delta.content;
      emit({ type: 'text', text: choice.delta.content });
    }
    for (const tc of choice.delta?.tool_calls ?? []) {
      const slot = (toolCalls[tc.index] ??= {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
      });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.function.name = tc.function.name;
      if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  // Sparse-array guard: indexes are provider-assigned and SHOULD be dense, but a
  // skipped slot must not surface as an undefined entry.
  return { content, toolCalls: toolCalls.filter(Boolean), finishReason };
}

/** Arg fields safe to preview in a progress label — short, human-readable identifiers
 *  only (exactly what progress-label.ts reads). Everything else (story bodies, source
 *  text) stays server-side. */
const PREVIEW_ARG_FIELDS = ['firstName', 'familyName', 'personName', 'relativeName', 'name'] as const;

/** The whitelisted, length-capped subset of a tool call's args for progress labels. */
function argsPreview(rawArgs: string): Record<string, string> {
  const preview: Record<string, string> = {};
  try {
    const parsed: unknown = rawArgs ? JSON.parse(rawArgs) : {};
    if (typeof parsed !== 'object' || parsed === null) return preview;
    for (const field of PREVIEW_ARG_FIELDS) {
      const value = (parsed as Record<string, unknown>)[field];
      if (typeof value === 'string' && value.trim()) preview[field] = value.slice(0, 80);
    }
  } catch {
    // Half-formed JSON (or none) — a preview is best-effort, never an error.
  }
  return preview;
}

/**
 * How often a run re-asserts its claim while awaiting the model. Well under the claim
 * staleness window, so even a single arbitrarily slow model call never goes stale.
 */
const KEEP_ALIVE_MS = 60 * 1000;

/** Run one model call with the caller's claim kept alive for its whole duration. */
async function withKeepAlive<T>(ctx: ToolContext, work: () => Promise<T>): Promise<T> {
  if (!ctx.keepAlive) return work();
  ctx.keepAlive();
  const timer = setInterval(ctx.keepAlive, KEEP_ALIVE_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/**
 * The model occasionally ends a turn with no text at all (seen with reasoning models
 * over OpenRouter). Ask once more — tools shown but disallowed, so the history stays
 * valid — for a plain-words summary of what actually happened; if even that comes back
 * empty, synthesize an honest reply from the receipts and tool errors.
 */
async function recoverEmptyReply(
  ctx: ToolContext,
  messages: ChatCompletionMessageParam[],
  schemas: ReturnType<typeof toOpenAISchemas>,
  receipts: Receipt[],
  toolErrors: string[],
  pendingChanges: number,
): Promise<string> {
  try {
    const completion = await withKeepAlive(ctx, () =>
      openrouter.chat.completions.create({
        model: env.STYLING_MODEL,
        messages: withCacheBreakpoints([
          ...messages,
          {
            role: 'user',
            content:
              "[Your reply came back empty — the user saw nothing. In the user's language, tell them " +
              'briefly what you just did and what, if anything, failed and why. Never claim success ' +
              'for something that failed.]',
          },
        ]),
        tools: schemas,
        tool_choice: 'none',
        ...OPENROUTER_ROUTING,
      }),
    );
    const reply = (completion.choices[0]?.message?.content ?? '').trim();
    if (reply) return reply;
  } catch (err) {
    console.error('Empty-reply recovery call failed:', err);
  }
  return fallbackReply(receipts, toolErrors, pendingChanges);
}

/** Last-resort reply when the model stays silent twice: honest, built from what actually happened.
 *  `pendingChanges` covers the case where the only thing that "happened" was staging a tree-changes
 *  card — no receipt for that, so without it this would wrongly report total failure. */
function fallbackReply(receipts: Receipt[], toolErrors: string[], pendingChanges: number): string {
  const done = receipts.map((r) => r.label).join(', ');
  const lastError = toolErrors[toolErrors.length - 1]?.replace(/^Error:\s*/, '');
  const staged = pendingChanges
    ? `I've prepared ${pendingChanges} tree change${pendingChanges === 1 ? '' : 's'} — please confirm on the card.`
    : '';
  if (done && lastError) return `Partly done — ${done}. But one step failed: ${lastError}${staged ? ` ${staged}` : ''}`;
  if (done) return `Done: ${done}.${staged ? ` ${staged}` : ''}`;
  if (staged) return staged;
  if (lastError) return `That didn't work: ${lastError}`;
  return "Sorry — I couldn't finish that. Please try again.";
}

/** Validate + execute a single tool call, returning the text to feed back to the model. */
async function runToolCall(
  byName: Map<string, Tool>,
  name: string,
  rawArgs: string,
  ctx: ToolContext,
  onSuccess: (r: { receipt?: Receipt; receipts?: Receipt[]; storyDraft?: StoryDraft }) => void,
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
      onSuccess({ receipt: result.receipt, receipts: result.receipts, storyDraft: result.storyDraft });
      return result.message;
    }
    return `Error: ${result.error}`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : 'the action failed unexpectedly.'}`;
  }
}
