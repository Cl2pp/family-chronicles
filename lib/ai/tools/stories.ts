import { z } from 'zod';
import { listChroniclesForUser } from '@/lib/chronicles';
import {
  canUserEditStory,
  chroniclesForStory,
  listChronicleStoryTexts,
  listStoriesForUser,
  shareStoryToChronicle,
  type StoryListItem,
} from '@/lib/stories';
import { findLikelyDuplicates } from '@/lib/story-similarity';
import { canContribute, type AccessRole } from '@/lib/permissions';
import { defineTool, type ToolContext } from './types';
import { ensureContributor } from './util';

/** Find one of the user's stories by exact title (case-insensitive) or id. */
async function resolveStory(
  ctx: ToolContext,
  ref: string,
): Promise<{ story: StoryListItem } | { error: string }> {
  const stories = await listStoriesForUser(ctx.userId);
  const wanted = ref.trim().toLowerCase();
  const matches = stories.filter((s) => s.id === ref.trim() || s.title.toLowerCase() === wanted);
  if (matches.length === 0) return { error: `No story titled "${ref}" was found.` };
  if (matches.length > 1) return { error: `Several stories match "${ref}" — be more specific.` };
  return { story: matches[0] };
}

/**
 * draft_story — compose a memoir story from the conversation and show it to the user
 * for review. This does NOT save anything; the client renders an editable card and the
 * user accepts it (which calls the acceptStory server action). Contributor access required.
 */
export const draftStoryTool = defineTool({
  name: 'draft_story',
  description:
    'Prepare a story draft for the user to review and save. Only call this once you have enough ' +
    'detail (who, roughly when, where). The body MUST be third-person memoir prose ("Maria ' +
    'remembered…"), preserve every fact (names, places, dates), invent NOTHING, and keep the ' +
    "family's original language. This shows an editable card — it does not save; only the user " +
    'can save it from the card, so never offer to save it yourself. Keep your reply ' +
    'short afterwards (e.g. "Here\'s a draft — take a look.").',
  schema: z.object({
    title: z.string().min(1).describe('A short, specific title.'),
    summary: z.string().describe('One short sentence on what the story is about.'),
    body: z.string().min(1).describe('The third-person memoir prose.'),
    sourceText: z
      .string()
      .min(1)
      .describe(
        "The user's own words this story is based on — their messages from this conversation " +
          'quoted VERBATIM (their language, first person, unpolished). Never reword, summarize, ' +
          "or translate; it is kept as the story's source material for traceability.",
      ),
    eventYear: z.number().int().nullish().describe('The year the events happened, if known.'),
    people: z.array(z.string()).describe('Names of people featured in the story.'),
    confirmedNew: z
      .boolean()
      .nullish()
      .describe(
        'Set true ONLY after the user has explicitly confirmed this is a separate story, even ' +
          'though a similar one already exists.',
      ),
  }),
  async execute(args, ctx) {
    const gate = await ensureContributor(ctx);
    if ('error' in gate) return { ok: false, error: gate.error };

    // Guard against recording the same memory twice: compare against every story
    // already in this chronicle before showing a new draft card.
    if (!args.confirmedNew) {
      const existing = await listChronicleStoryTexts(gate.chronicleId);
      const duplicates = findLikelyDuplicates(
        { title: args.title, body: `${args.summary ?? ''} ${args.body}`, eventYear: args.eventYear ?? null },
        existing.map((s) => ({
          id: s.id,
          title: s.title,
          summary: s.summary,
          body: s.bodyStyled ?? s.bodyOriginal,
          eventYear: s.eventDate ? s.eventDate.getUTCFullYear() : null,
        })),
      );
      if (duplicates.length) {
        const list = duplicates
          .map((d) => `"${d.title}" (${d.eventYear ?? 'year unknown'}, id ${d.id}) — ${d.reason}`)
          .join('; ');
        return {
          ok: false,
          error:
            `This event may already be recorded in this chronicle: ${list}. ` +
            'Ask the user: if they are adding details or corrections to that story, use get_story ' +
            'then update_story instead. Only if they confirm it is a genuinely different story, ' +
            'call draft_story again with confirmedNew: true.',
        };
      }
    }

    return {
      ok: true,
      message: 'Draft prepared and shown to the user for review. Await their edits and acceptance.',
      storyDraft: {
        proposal: {
          kind: 'story',
          title: args.title,
          summary: args.summary ?? '',
          body: args.body,
          eventYear: args.eventYear ?? null,
          people: args.people ?? [],
          sourceText: args.sourceText,
        },
        chronicleId: gate.chronicleId,
        chronicleName: ctx.activeChronicleName ?? 'your chronicle',
      },
    };
  },
});

/** share_story — also share an existing story into another of the user's chronicles. */
export const shareStoryTool = defineTool({
  name: 'share_story',
  description:
    'Share an existing story into another chronicle the user belongs to. Identify the story by its ' +
    'title (or id) and the target chronicle by name. Requires contributor access in the target chronicle.',
  schema: z.object({
    story: z.string().min(1).describe('The story title (or id) to share.'),
    chronicleName: z.string().min(1).describe('The chronicle to share it into.'),
  }),
  async execute(args, ctx) {
    const found = await resolveStory(ctx, args.story);
    if ('error' in found) return { ok: false, error: found.error };
    const story = found.story;

    const chronicles = await listChroniclesForUser(ctx.userId);
    const wantedChronicle = args.chronicleName.trim().toLowerCase();
    const chronicleMatches = chronicles.filter((f) => f.name.toLowerCase() === wantedChronicle);
    if (chronicleMatches.length === 0) return { ok: false, error: `You are not in a chronicle named "${args.chronicleName}".` };
    if (chronicleMatches.length > 1) return { ok: false, error: `Several chronicles are named "${args.chronicleName}" — be more specific.` };
    const chronicle = chronicleMatches[0];

    if (story.chronicleIds.includes(chronicle.id)) {
      return { ok: false, error: `"${story.title}" is already shared with ${chronicle.name}.` };
    }
    if (!canContribute(chronicle.role as AccessRole)) {
      return { ok: false, error: `You need contributor access in ${chronicle.name} to share into it.` };
    }

    await shareStoryToChronicle(story.id, chronicle.id, ctx.userId);
    return {
      ok: true,
      message: `Shared "${story.title}" into ${chronicle.name}.`,
      receipt: { label: `Shared "${story.title}" with ${chronicle.name}`, href: `/stories/${story.id}` },
    };
  },
});

/** get_story — read tool: one story in full, for answering questions or before an edit. */
export const getStoryTool = defineTool({
  name: 'get_story',
  description:
    'Read one story in full (title, summary, body, year, status) by its title or id. Always call ' +
    'this before update_story so the revision starts from the current text.',
  schema: z.object({
    story: z.string().min(1).describe('The story title (or id) to read.'),
  }),
  async execute(args, ctx) {
    const found = await resolveStory(ctx, args.story);
    if ('error' in found) return { ok: false, error: found.error };
    const s = found.story;
    return {
      ok: true,
      message: JSON.stringify({
        id: s.id,
        title: s.title,
        summary: s.summary,
        body: s.bodyStyled ?? s.bodyOriginal,
        eventYear: s.eventDate ? s.eventDate.getUTCFullYear() : null,
        status: s.status,
      }),
    };
  },
});

/**
 * update_story — propose a revision to an existing story. Like draft_story this does NOT
 * save: the client shows the revised text in an editable card and the user accepts it
 * (which calls the applyStoryUpdate server action).
 */
export const updateStoryTool = defineTool({
  name: 'update_story',
  description:
    'Propose a revision to an existing story — a rewrite, a correction, or new details woven in. ' +
    'Call get_story first and base the revision on the current text. The body MUST be the ' +
    'COMPLETE revised story (not just the changes), keep the third-person memoir style, preserve ' +
    'every fact that is still true, invent NOTHING, and keep the original language. This shows an ' +
    'editable review card — it does not save. Keep your reply short afterwards.',
  schema: z.object({
    story: z.string().min(1).describe('The story title (or id) to update.'),
    title: z.string().min(1).describe('The (possibly unchanged) title.'),
    summary: z.string().describe('One short sentence on what the story is about.'),
    body: z.string().min(1).describe('The complete revised third-person memoir prose.'),
    newSourceText: z
      .string()
      .nullish()
      .describe(
        'Any NEW first-hand material the user provided for this revision — their messages from ' +
          'this conversation quoted VERBATIM (their language, first person). It is appended to ' +
          "the story's source history on save. Omit when the revision only rewords what is " +
          'already recorded.',
      ),
    eventYear: z
      .number()
      .int()
      .nullish()
      .describe('The year the events happened. Pass the current year unless it changed.'),
  }),
  async execute(args, ctx) {
    const found = await resolveStory(ctx, args.story);
    if ('error' in found) return { ok: false, error: found.error };
    const s = found.story;

    if (s.status !== 'ready') {
      return { ok: false, error: 'This story is still being processed — it can be edited once it is ready.' };
    }
    if (!(await canUserEditStory(s.id, ctx.userId))) {
      return { ok: false, error: "Only the story's author or a chronicle owner can edit it." };
    }

    const chronicles = await chroniclesForStory(s.id);
    return {
      ok: true,
      message: 'Revision prepared and shown to the user for review. Await their edits and acceptance.',
      storyDraft: {
        updateStoryId: s.id,
        proposal: {
          kind: 'story',
          title: args.title,
          summary: args.summary ?? '',
          body: args.body,
          eventYear: args.eventYear ?? (s.eventDate ? s.eventDate.getUTCFullYear() : null),
          people: [],
          sourceText: args.newSourceText ?? null,
        },
        chronicleId: chronicles[0]?.id ?? '',
        chronicleName: chronicles[0]?.name ?? 'your chronicle',
      },
    };
  },
});

/** list_stories — read tool: the user's recent stories across all their chronicles. */
export const listStoriesTool = defineTool({
  name: 'list_stories',
  description:
    "List the user's recent stories across all their chronicles (title, summary, year, status, id). " +
    'Use to find a story to share, to answer questions about what has been recorded, or to check ' +
    'whether an event is already recorded before drafting a new story about it.',
  schema: z.object({}),
  async execute(_args, ctx) {
    const stories = await listStoriesForUser(ctx.userId);
    return {
      ok: true,
      message: JSON.stringify(
        stories.slice(0, 25).map((s) => ({
          id: s.id,
          title: s.title,
          summary: s.summary,
          eventYear: s.eventDate ? s.eventDate.getUTCFullYear() : null,
          status: s.status,
        })),
      ),
    };
  },
});
