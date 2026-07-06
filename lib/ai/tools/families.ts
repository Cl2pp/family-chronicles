import { z } from 'zod';
import { createFamily, listFamiliesForUser, updateFamily } from '@/lib/families';
import { defineTool } from './types';
import { ensureOwner } from './util';

/** create_family — start a new family; the caller becomes its owner + first tree node. */
export const createFamilyTool = defineTool({
  name: 'create_family',
  description:
    'Create a new family. The user becomes its owner and is added to the family tree. ' +
    'Use this to set up a family from scratch. Afterwards this family becomes the active one, ' +
    'so subsequent add_person / draft_story calls apply to it. Any signed-in user may do this.',
  schema: z.object({
    name: z.string().min(1).describe('The family name, e.g. "Ortlepp" or "The Schmidt family".'),
    description: z.string().nullish().describe('Optional one-line description of the family.'),
  }),
  async execute(args, ctx) {
    const name = args.name.trim();
    if (!name) return { ok: false, error: 'A family name is required.' };

    const family = await createFamily({
      name,
      description: args.description?.trim() || null,
      userId: ctx.userId,
      userName: ctx.userName,
    });
    ctx.setActiveFamily(family.id, family.name);

    return {
      ok: true,
      message: `Created family "${family.name}" (id ${family.id}); it is now the active family and you (${ctx.userName}) are in its tree as the owner.`,
      receipt: { label: `Created the ${family.name} family` },
    };
  },
});

/** update_family_settings — owner-only edits to name / description / writing style guide. */
export const updateFamilySettingsTool = defineTool({
  name: 'update_family_settings',
  description:
    "Update the active family's name, description, or style guide. The style guide is free text " +
    'that shapes how memories are rewritten into memoir prose (e.g. tone, formality). Owner only.',
  schema: z.object({
    name: z.string().nullish().describe('New family name.'),
    description: z.string().nullish().describe('New description.'),
    styleGuide: z
      .string()
      .nullish()
      .describe('Writing-style guidance injected into the story styling prompt.'),
  }),
  async execute(args, ctx) {
    const gate = await ensureOwner(ctx);
    if ('error' in gate) return { ok: false, error: gate.error };

    const patch: { name?: string; description?: string | null; styleGuide?: string | null } = {};
    if (args.name != null) {
      const name = args.name.trim();
      if (!name) return { ok: false, error: 'A family name cannot be empty.' };
      patch.name = name;
    }
    if (args.description != null) patch.description = args.description.trim() || null;
    if (args.styleGuide != null) patch.styleGuide = args.styleGuide.trim() || null;
    if (Object.keys(patch).length === 0) {
      return { ok: false, error: 'Nothing to update — provide name, description, or styleGuide.' };
    }

    await updateFamily(gate.familyId, patch);
    if (patch.name) ctx.setActiveFamily(gate.familyId, patch.name);

    return {
      ok: true,
      message: `Updated settings for the active family (${Object.keys(patch).join(', ')}).`,
      receipt: { label: `Updated ${patch.name ?? ctx.activeFamilyName ?? 'family'} settings` },
    };
  },
});

/** list_families — read tool: the families the user belongs to and their role in each. */
export const listFamiliesTool = defineTool({
  name: 'list_families',
  description:
    'List the families the user belongs to, with the user\'s role in each. Use to see whether ' +
    'the user already has a family or to pick one to act on.',
  schema: z.object({}),
  async execute(_args, ctx) {
    const families = await listFamiliesForUser(ctx.userId);
    return {
      ok: true,
      message: JSON.stringify(
        families.map((f) => ({ id: f.id, name: f.name, role: f.role, active: f.id === ctx.activeFamilyId })),
      ),
    };
  },
});
