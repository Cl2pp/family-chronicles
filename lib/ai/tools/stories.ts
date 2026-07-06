import { z } from 'zod';
import { listFamiliesForUser } from '@/lib/families';
import { listStoriesForUser, shareStoryToFamily } from '@/lib/stories';
import { canContribute, type AccessRole } from '@/lib/permissions';
import { defineTool } from './types';
import { ensureContributor } from './util';

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
    "family's original language. This shows an editable card — it does not save. Keep your reply " +
    'short afterwards (e.g. "Here\'s a draft — take a look.").',
  schema: z.object({
    title: z.string().min(1).describe('A short, specific title.'),
    summary: z.string().describe('One short sentence on what the story is about.'),
    body: z.string().min(1).describe('The third-person memoir prose.'),
    eventYear: z.number().int().nullish().describe('The year the events happened, if known.'),
    people: z.array(z.string()).describe('Names of people featured in the story.'),
  }),
  async execute(args, ctx) {
    const gate = await ensureContributor(ctx);
    if ('error' in gate) return { ok: false, error: gate.error };

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
        },
        familyId: gate.familyId,
        familyName: ctx.activeFamilyName ?? 'your family',
      },
    };
  },
});

/** share_story — also share an existing story into another of the user's families. */
export const shareStoryTool = defineTool({
  name: 'share_story',
  description:
    'Share an existing story into another family the user belongs to. Identify the story by its ' +
    'title (or id) and the target family by name. Requires contributor access in the target family.',
  schema: z.object({
    story: z.string().min(1).describe('The story title (or id) to share.'),
    familyName: z.string().min(1).describe('The family to share it into.'),
  }),
  async execute(args, ctx) {
    const stories = await listStoriesForUser(ctx.userId);
    const wantedStory = args.story.trim().toLowerCase();
    const storyMatches = stories.filter(
      (s) => s.id === args.story.trim() || s.title.toLowerCase() === wantedStory,
    );
    if (storyMatches.length === 0) return { ok: false, error: `No story titled "${args.story}" was found.` };
    if (storyMatches.length > 1) return { ok: false, error: `Several stories match "${args.story}" — be more specific.` };
    const story = storyMatches[0];

    const families = await listFamiliesForUser(ctx.userId);
    const wantedFamily = args.familyName.trim().toLowerCase();
    const familyMatches = families.filter((f) => f.name.toLowerCase() === wantedFamily);
    if (familyMatches.length === 0) return { ok: false, error: `You are not in a family named "${args.familyName}".` };
    if (familyMatches.length > 1) return { ok: false, error: `Several families are named "${args.familyName}" — be more specific.` };
    const family = familyMatches[0];

    if (story.familyIds.includes(family.id)) {
      return { ok: false, error: `"${story.title}" is already shared with ${family.name}.` };
    }
    if (!canContribute(family.role as AccessRole)) {
      return { ok: false, error: `You need contributor access in ${family.name} to share into it.` };
    }

    await shareStoryToFamily(story.id, family.id, ctx.userId);
    return {
      ok: true,
      message: `Shared "${story.title}" into ${family.name}.`,
      receipt: { label: `Shared "${story.title}" with ${family.name}`, href: `/stories/${story.id}` },
    };
  },
});

/** list_stories — read tool: the user's recent stories across all their families. */
export const listStoriesTool = defineTool({
  name: 'list_stories',
  description:
    'List the user\'s recent stories across all their families (title, status, id). Use to find a ' +
    'story to share or to answer questions about what has been recorded.',
  schema: z.object({}),
  async execute(_args, ctx) {
    const stories = await listStoriesForUser(ctx.userId);
    return {
      ok: true,
      message: JSON.stringify(
        stories.slice(0, 25).map((s) => ({ id: s.id, title: s.title, status: s.status })),
      ),
    };
  },
});
