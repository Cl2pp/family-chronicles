import { z } from 'zod';
import { listChroniclesForUser } from '@/lib/chronicles';
import { addMessage, resolveDraftCard } from '@/lib/conversations';
import { listChroniclePeople } from '@/lib/people';
import { matchPeopleByName } from '@/lib/person-match';
import { personFullName } from '@/lib/person-name';
import {
  addPeopleToStory,
  applyStoryEdit,
  canUserEditStory,
  chroniclesForStory,
  claimChatAssetsForStory,
  listChronicleStoryTexts,
  listStoriesForUser,
  listStoryPeople,
  removePeopleFromStory,
  shareStoryToChronicle,
  type StoryListItem,
} from '@/lib/stories';
import { saveProposalAsStory } from '@/lib/story-save';
import { findLikelyDuplicates } from '@/lib/story-similarity';
import { eventDateToParts } from '@/lib/dates';
import { canContribute, type AccessRole } from '@/lib/permissions';
import { defineTool, type ToolContext } from './types';
import { ensureContributor, resolvePerson } from './util';

/** The event date to store for a story edit: when the model omits the year, keep the
 * story's current date untouched (shared by update_story and save_story). */
function carriedEventDate(
  story: StoryListItem,
  args: { eventYear?: number | null; eventMonth?: number | null; eventDay?: number | null },
) {
  const current = eventDateToParts(story.eventDate, story.eventDatePrecision);
  return args.eventYear != null
    ? { year: args.eventYear, month: args.eventMonth ?? null, day: args.eventDay ?? null }
    : current;
}

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
 * Duplicate-memory guard shared by draft_story and save_story: compare against every
 * story already in the chronicle that `userId` may read; an actionable error message
 * when a likely match exists, else null. `toolName` names the tool to re-call with
 * confirmedNew: true.
 */
async function likelyDuplicateError(
  chronicleId: string,
  userId: string,
  args: { title: string; summary?: string | null; body: string; eventYear?: number | null },
  toolName: string,
): Promise<string | null> {
  const existing = await listChronicleStoryTexts(chronicleId, userId);
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
  if (!duplicates.length) return null;
  const list = duplicates
    .map((d) => `"${d.title}" (${d.eventYear ?? 'year unknown'}, id ${d.id}) — ${d.reason}`)
    .join('; ');
  return (
    `This event may already be recorded in this chronicle: ${list}. ` +
    'Ask the user: if they are adding details or corrections to that story, use get_story ' +
    'then update_story instead. Only if they confirm it is a genuinely different story, ' +
    `call ${toolName} again with confirmedNew: true.`
  );
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
    'can save it from the card, so never offer to save it yourself (only if the user explicitly ' +
    'asks to save without the card, use save_story instead). Keep your reply ' +
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
    eventMonth: z
      .number()
      .int()
      .min(1)
      .max(12)
      .nullish()
      .describe('The month (1-12) the events happened — only if the user actually said it.'),
    eventDay: z
      .number()
      .int()
      .min(1)
      .max(31)
      .nullish()
      .describe('The day of month (1-31) — only if the user gave the exact date.'),
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
      const duplicateError = await likelyDuplicateError(gate.chronicleId, ctx.userId, args, 'draft_story');
      if (duplicateError) return { ok: false, error: duplicateError };
    }

    // On save, named people are connected to the story (they drive its family tags) —
    // but only the ones that resolve to tree members. Warn about the rest now, while
    // there is still time to add them before the user accepts the draft.
    let message = 'Draft prepared and shown to the user for review. Await their edits and acceptance.';
    if (args.people?.length) {
      const treePeople = await listChroniclePeople(gate.chronicleId);
      const { unmatched } = matchPeopleByName(treePeople, args.people);
      if (unmatched.length) {
        message +=
          ` NOTE: ${unmatched.map((n) => `"${n}"`).join(', ')} ` +
          (unmatched.length === 1 ? 'is' : 'are') +
          ' not in the family tree, so the story cannot be connected to them (or their family) ' +
          'when saved. Tell the user and offer to add them with add_person first — if they are ' +
          'added before the draft is accepted, the connection will work.';
      }
    }

    return {
      ok: true,
      message,
      storyDraft: {
        proposal: {
          kind: 'story',
          title: args.title,
          summary: args.summary ?? '',
          body: args.body,
          eventYear: args.eventYear ?? null,
          eventMonth: args.eventMonth ?? null,
          eventDay: args.eventDay ?? null,
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
    'Read one story in full (title, summary, body, year, status, tagged people, family tags) by ' +
    'its title or id. Always call this before update_story so the revision starts from the ' +
    'current text, and before tag_story_people to see who is already connected.',
  schema: z.object({
    story: z.string().min(1).describe('The story title (or id) to read.'),
  }),
  async execute(args, ctx) {
    const found = await resolveStory(ctx, args.story);
    if ('error' in found) return { ok: false, error: found.error };
    const s = found.story;
    const tagged = await listStoryPeople(s.id);
    const parts = eventDateToParts(s.eventDate, s.eventDatePrecision);
    return {
      ok: true,
      message: JSON.stringify({
        id: s.id,
        title: s.title,
        summary: s.summary,
        body: s.bodyStyled ?? s.bodyOriginal,
        eventYear: parts.year,
        eventMonth: parts.month,
        eventDay: parts.day,
        status: s.status,
        people: tagged.map((p) => personFullName(p)),
        familyTags: s.familyTags,
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
    eventMonth: z
      .number()
      .int()
      .min(1)
      .max(12)
      .nullish()
      .describe('The month (1-12), if known. Pass the current month unless it changed.'),
    eventDay: z
      .number()
      .int()
      .min(1)
      .max(31)
      .nullish()
      .describe('The day of month (1-31), if known. Pass the current day unless it changed.'),
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
    const date = carriedEventDate(s, args);
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
          eventYear: date.year,
          eventMonth: date.month,
          eventDay: date.day,
          people: [],
          sourceText: args.newSourceText ?? null,
        },
        chronicleId: chronicles[0]?.id ?? '',
        chronicleName: chronicles[0]?.name ?? 'your chronicle',
      },
    };
  },
});

/**
 * save_story — save a story (new, or an update to an existing one) directly to storage,
 * skipping the review card. Only for when the user explicitly asked to save without the
 * card. Marks any pending draft card as handled so it isn't re-offered.
 */
export const saveStoryTool = defineTool({
  name: 'save_story',
  description:
    'Save a story directly to the chronicle, skipping the review card — ONLY when the user has ' +
    'EXPLICITLY asked you to save without reviewing (e.g. "just save it", "save it directly", or ' +
    'they say they cannot see or use the card). Never call it on your own initiative: the default ' +
    'flow is draft_story / update_story, where the user saves from the card. Pass the COMPLETE ' +
    'story content (same memoir rules) — if a draft card was already shown, reuse its exact ' +
    'content plus any corrections the user asked for since. To update an existing story instead ' +
    'of creating a new one, pass its title or id in "story". Any pending draft card is resolved.',
  schema: z.object({
    story: z
      .string()
      .nullish()
      .describe('To update an existing story: its title (or id). Omit to create a new story.'),
    title: z.string().min(1).describe('A short, specific title.'),
    summary: z.string().describe('One short sentence on what the story is about.'),
    body: z.string().min(1).describe('The complete third-person memoir prose.'),
    sourceText: z
      .string()
      .nullish()
      .describe(
        "The user's own words the story is based on, quoted VERBATIM (their language, first " +
          'person, unpolished) — for a new story, all of it; when updating, only the NEW ' +
          'material from this conversation (omit if the update only rewords what is recorded).',
      ),
    eventYear: z.number().int().nullish().describe('The year the events happened, if known.'),
    eventMonth: z
      .number()
      .int()
      .min(1)
      .max(12)
      .nullish()
      .describe('The month (1-12) the events happened — only if the user actually said it.'),
    eventDay: z
      .number()
      .int()
      .min(1)
      .max(31)
      .nullish()
      .describe('The day of month (1-31) — only if the user gave the exact date.'),
    people: z.array(z.string()).nullish().describe('Names of people featured in the story.'),
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

    if (args.story) {
      const found = await resolveStory(ctx, args.story);
      if ('error' in found) return { ok: false, error: found.error };
      const s = found.story;

      const date = carriedEventDate(s, args);
      const result = await applyStoryEdit({
        storyId: s.id,
        userId: ctx.userId,
        title: args.title,
        summary: args.summary || null,
        body: args.body,
        eventYear: date.year,
        eventMonth: date.month,
        eventDay: date.day,
        appendSource: args.sourceText ?? null,
      });
      if (!result.ok) return { ok: false, error: result.error };

      if (ctx.conversationId) {
        // The update claims the chat's new uploads (voice notes, photos) too, and any
        // still-pending card is marked handled so a reload doesn't re-offer it.
        await claimChatAssetsForStory(ctx.conversationId, s.id, ctx.userId);
        await resolveDraftCard(ctx.conversationId);
        await addMessage(
          ctx.conversationId,
          'system',
          `[The story "${args.title}" (id ${s.id}) was updated directly at the user's explicit request via save_story.]`,
        );
      }
      return {
        ok: true,
        message: `Updated "${args.title}" (story id ${s.id}).`,
        receipt: { label: `Updated "${args.title}"`, detail: 'View story', href: `/stories/${s.id}` },
      };
    }

    if (!args.confirmedNew) {
      const duplicateError = await likelyDuplicateError(gate.chronicleId, ctx.userId, args, 'save_story');
      if (duplicateError) return { ok: false, error: duplicateError };
    }

    const saved = await saveProposalAsStory({
      userId: ctx.userId,
      chronicleId: gate.chronicleId,
      proposal: {
        kind: 'story',
        title: args.title,
        summary: args.summary ?? '',
        body: args.body,
        eventYear: args.eventYear ?? null,
        eventMonth: args.eventMonth ?? null,
        eventDay: args.eventDay ?? null,
        people: args.people ?? [],
        sourceText: args.sourceText ?? null,
      },
      conversationId: ctx.conversationId,
    });

    if (ctx.conversationId) {
      // Even when the story turned out to be already saved, a still-showing draft card
      // for it must be resolved — otherwise a reload re-offers a card for a stored story.
      await resolveDraftCard(ctx.conversationId);
      if (!saved.alreadySaved) {
        await addMessage(
          ctx.conversationId,
          'system',
          `[The story "${saved.title}" (id ${saved.storyId}) was saved directly at the user's ` +
            'explicit request via save_story. It is already stored — do not draft or save it again.]',
        );
      }
    }

    const chronicleName = ctx.activeChronicleName ?? 'the chronicle';
    let message = saved.alreadySaved
      ? `An identical story "${saved.title}" was already saved (id ${saved.storyId}) — nothing new was created.`
      : `Saved "${saved.title}" to ${chronicleName} (story id ${saved.storyId}).`;
    if (saved.unmatchedPeople.length) {
      message +=
        ` NOTE: ${saved.unmatchedPeople.map((n) => `"${n}"`).join(', ')} ` +
        (saved.unmatchedPeople.length === 1 ? 'is' : 'are') +
        ' not in the family tree, so the story could not be connected to them. Offer to add them ' +
        'with add_person and then tag_story_people.';
    }
    return {
      ok: true,
      message,
      receipt: {
        label: `Saved "${saved.title}" to ${chronicleName}`,
        detail: 'View story',
        href: `/stories/${saved.storyId}`,
      },
    };
  },
});

/** Shared gate for (un)tagging: resolve the story, check edit rights and contributor access. */
async function resolveStoryForTagging(
  ctx: ToolContext,
  ref: string,
): Promise<{ story: StoryListItem; chronicleId: string } | { error: string }> {
  const gate = await ensureContributor(ctx);
  if ('error' in gate) return gate;
  const found = await resolveStory(ctx, ref);
  if ('error' in found) return found;
  if (!(await canUserEditStory(found.story.id, ctx.userId))) {
    return { error: "Only the story's author or a chronicle owner can change who is tagged in it." };
  }
  return { story: found.story, chronicleId: gate.chronicleId };
}

/**
 * tag_story_people — connect tree members to an existing story. The story's family
 * tags (and its visibility under the stories-page family filter) derive from these links.
 */
export const tagStoryPeopleTool = defineTool({
  name: 'tag_story_people',
  description:
    'Connect one or more people from the family tree to an existing story — e.g. to reconnect a ' +
    "story to a person (and thereby their family) after the fact. The story's family tags derive " +
    'from its tagged people. People must already be in the tree (add_person first if not). ' +
    'Call get_story first to see who is already tagged. Contributor access required.',
  schema: z.object({
    story: z.string().min(1).describe('The story title (or id) to tag people in.'),
    people: z.array(z.string().min(1)).min(1).describe('Names of tree members to connect.'),
  }),
  async execute(args, ctx) {
    const gate = await resolveStoryForTagging(ctx, args.story);
    if ('error' in gate) return { ok: false, error: gate.error };
    const { story, chronicleId } = gate;

    const matched: { id: string; firstName: string; familyName: string | null }[] = [];
    const problems: string[] = [];
    for (const name of args.people) {
      const found = await resolvePerson(chronicleId, name);
      if ('error' in found) problems.push(found.error);
      else matched.push(found.person);
    }
    if (matched.length === 0) {
      return { ok: false, error: `No one could be tagged: ${problems.join(' ')}` };
    }

    await addPeopleToStory(story.id, matched.map((p) => p.id));
    const names = matched.map((p) => personFullName(p)).join(', ');
    return {
      ok: true,
      message:
        `Tagged ${names} in "${story.title}".` +
        (problems.length ? ` Some people could not be tagged: ${problems.join(' ')}` : ''),
      receipt: { label: `Tagged ${names}`, detail: `in "${story.title}"`, href: `/stories/${story.id}` },
    };
  },
});

/** untag_story_people — disconnect people from a story (the people themselves are kept). */
export const untagStoryPeopleTool = defineTool({
  name: 'untag_story_people',
  description:
    'Remove the connection between a story and one or more tagged people — e.g. when someone was ' +
    'tagged by mistake. The people stay in the tree; only the story link is removed. ' +
    'Contributor access required.',
  schema: z.object({
    story: z.string().min(1).describe('The story title (or id) to untag people from.'),
    people: z.array(z.string().min(1)).min(1).describe('Names of tagged people to disconnect.'),
  }),
  async execute(args, ctx) {
    const gate = await resolveStoryForTagging(ctx, args.story);
    if ('error' in gate) return { ok: false, error: gate.error };
    const { story } = gate;

    // Resolve against the story's own tagged people — they may have left the chronicle.
    const tagged = await listStoryPeople(story.id);
    const { matched, unmatched } = matchPeopleByName(tagged, args.people);
    if (matched.length === 0) {
      return {
        ok: false,
        error: `None of ${args.people.map((n) => `"${n}"`).join(', ')} are tagged in "${story.title}".`,
      };
    }

    await removePeopleFromStory(story.id, matched.map((p) => p.id));
    const names = matched.map((p) => personFullName(p)).join(', ');
    return {
      ok: true,
      message:
        `Untagged ${names} from "${story.title}".` +
        (unmatched.length
          ? ` Not tagged in it (so nothing to remove): ${unmatched.map((n) => `"${n}"`).join(', ')}.`
          : ''),
      receipt: { label: `Untagged ${names}`, detail: `from "${story.title}"`, href: `/stories/${story.id}` },
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
