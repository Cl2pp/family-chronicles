import { z } from 'zod';
import {
  createChronicle,
  listChroniclesForUser,
  normalizeStoryLanguage,
  updateChronicle,
} from '@/lib/chronicles';
import { defineTool } from './types';
import { ensureOwner } from './util';

/** create_chronicle — start a new chronicle; the caller becomes its owner + first tree node. */
export const createChronicleTool = defineTool({
  name: 'create_chronicle',
  description:
    'Create a new chronicle — the private space where a family collects its stories and tree. ' +
    'The user becomes its owner and is added to its tree. Afterwards this chronicle becomes the ' +
    'active one, so subsequent add_person / draft_story calls apply to it. Any signed-in user may ' +
    'do this. Note: families are NOT set up manually — they appear automatically as tags from ' +
    "people's surnames and marriages.",
  schema: z.object({
    name: z
      .string()
      .min(1)
      .describe('The chronicle name, e.g. "Ortlepp & Hartwick" or "Our family chronicle".'),
    description: z.string().nullish().describe('Optional one-line description of the chronicle.'),
  }),
  async execute(args, ctx) {
    const name = args.name.trim();
    if (!name) return { ok: false, error: 'A chronicle name is required.' };

    const chronicle = await createChronicle({
      name,
      description: args.description?.trim() || null,
      userId: ctx.userId,
      userName: ctx.userName,
    });
    ctx.setActiveChronicle(chronicle.id, chronicle.name);

    return {
      ok: true,
      message: `Created chronicle "${chronicle.name}" (id ${chronicle.id}); it is now the active chronicle and you (${ctx.userName}) are in its tree as the owner.`,
      receipt: { label: `Created the "${chronicle.name}" chronicle` },
    };
  },
});

/** update_chronicle_settings — owner-only edits to name / description / writing style guide. */
export const updateChronicleSettingsTool = defineTool({
  name: 'update_chronicle_settings',
  description:
    "Update the active chronicle's name, description, style guide, or story language. The style " +
    'guide is free text that shapes how memories are rewritten into memoir prose (e.g. tone, ' +
    'formality). Owner only.',
  schema: z.object({
    name: z.string().nullish().describe('New chronicle name.'),
    description: z.string().nullish().describe('New description.'),
    styleGuide: z
      .string()
      .nullish()
      .describe('Writing-style guidance injected into the story styling prompt.'),
    storyLanguage: z
      .enum(['en', 'de', 'auto'])
      .nullish()
      .describe(
        "Language stories are retold in: 'en', 'de', or 'auto' to keep each submission's language.",
      ),
  }),
  async execute(args, ctx) {
    const gate = await ensureOwner(ctx);
    if ('error' in gate) return { ok: false, error: gate.error };

    const patch: {
      name?: string;
      description?: string | null;
      styleGuide?: string | null;
      storyLanguage?: string | null;
    } = {};
    if (args.name != null) {
      const name = args.name.trim();
      if (!name) return { ok: false, error: 'A chronicle name cannot be empty.' };
      patch.name = name;
    }
    if (args.description != null) patch.description = args.description.trim() || null;
    if (args.styleGuide != null) patch.styleGuide = args.styleGuide.trim() || null;
    if (args.storyLanguage != null) {
      patch.storyLanguage = normalizeStoryLanguage(args.storyLanguage);
    }
    if (Object.keys(patch).length === 0) {
      return {
        ok: false,
        error: 'Nothing to update — provide name, description, styleGuide, or storyLanguage.',
      };
    }

    await updateChronicle(gate.chronicleId, patch);
    if (patch.name) ctx.setActiveChronicle(gate.chronicleId, patch.name);

    return {
      ok: true,
      message: `Updated settings for the active chronicle (${Object.keys(patch).join(', ')}).`,
      receipt: {
        label: `Updated ${patch.name ?? ctx.activeChronicleName ?? 'chronicle'} settings`,
      },
    };
  },
});

/** switch_chronicle — make a different chronicle (the user already belongs to) the active one. */
export const switchChronicleTool = defineTool({
  name: 'switch_chronicle',
  description:
    'Switch the active chronicle to another one the user belongs to, so later actions (add_person, ' +
    'draft_story, etc.) apply to it. Identify it by name.',
  schema: z.object({
    name: z.string().min(1).describe('The chronicle to switch to.'),
  }),
  async execute(args, ctx) {
    const chronicles = await listChroniclesForUser(ctx.userId);
    const wanted = args.name.trim().toLowerCase();
    const matches = chronicles.filter((f) => f.name.toLowerCase() === wanted);
    if (matches.length === 0)
      return { ok: false, error: `You are not in a chronicle named "${args.name}".` };
    if (matches.length > 1)
      return { ok: false, error: `Several chronicles are named "${args.name}" — be more specific.` };

    ctx.setActiveChronicle(matches[0].id, matches[0].name);
    return {
      ok: true,
      message: `Switched the active chronicle to "${matches[0].name}". Later actions apply to it.`,
      receipt: { label: `Switched to the "${matches[0].name}" chronicle` },
    };
  },
});

/** list_chronicles — read tool: the chronicles the user belongs to and their role in each. */
export const listChroniclesTool = defineTool({
  name: 'list_chronicles',
  description:
    "List the chronicles the user belongs to, with the user's role in each. Use to see whether " +
    'the user already has a chronicle or to pick one to act on.',
  schema: z.object({}),
  async execute(_args, ctx) {
    const chronicles = await listChroniclesForUser(ctx.userId);
    return {
      ok: true,
      message: JSON.stringify(
        chronicles.map((f) => ({
          id: f.id,
          name: f.name,
          role: f.role,
          active: f.id === ctx.activeChronicleId,
        })),
      ),
    };
  },
});
