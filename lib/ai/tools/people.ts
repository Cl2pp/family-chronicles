import { z } from 'zod';
import {
  addPersonToFamily,
  connectPeople,
  createPerson,
  deletePerson,
  getPerson,
  isPersonInFamily,
  listFamilyPeople,
  updatePerson,
  type PersonPatch,
  type RelationshipType,
} from '@/lib/people';
import { parseYear, yearToDate } from '@/lib/dates';
import { defineTool } from './types';
import { ensureContributor, resolvePerson } from './util';

const relation = z
  .enum(['parent', 'child', 'partner'])
  .describe("The subject's relation TO the named relative (e.g. 'parent' = subject is the relative's parent).");

/** Turn a "subject is X of relative" relation into a canonical kinship edge. */
function edgeFor(
  rel: 'parent' | 'child' | 'partner',
  subjectId: string,
  relativeId: string,
): { type: RelationshipType; personFromId: string; personToId: string } {
  if (rel === 'parent') return { type: 'parent', personFromId: subjectId, personToId: relativeId };
  if (rel === 'child') return { type: 'parent', personFromId: relativeId, personToId: subjectId };
  return { type: 'spouse', personFromId: subjectId, personToId: relativeId };
}

/** add_person — create a person in the active family's tree, optionally connected to a relative. */
export const addPersonTool = defineTool({
  name: 'add_person',
  description:
    "Add a person to the active family's tree. Optionally connect them to someone already in the " +
    'tree via relateTo. Check get_family_tree first if unsure who already exists. Contributor access required.',
  schema: z.object({
    displayName: z.string().min(1).describe('The name to show, e.g. "Maria" or "Maria Schmidt".'),
    familyName: z.string().nullish().describe('Optional surname.'),
    bornYear: z.number().int().nullish().describe('Birth year, if known.'),
    diedYear: z.number().int().nullish().describe('Death year, if known.'),
    relateTo: z
      .object({ name: z.string().min(1).describe('An existing relative in this family.'), relation })
      .nullish()
      .describe('Optionally connect the new person to an existing relative.'),
  }),
  async execute(args, ctx) {
    const gate = await ensureContributor(ctx);
    if ('error' in gate) return { ok: false, error: gate.error };

    const displayName = args.displayName.trim();
    if (!displayName) return { ok: false, error: 'A name is required.' };

    // Resolve the relative up-front so we fail before creating an orphan on a bad reference.
    let relative: { id: string; displayName: string } | null = null;
    if (args.relateTo) {
      const found = await resolvePerson(gate.familyId, args.relateTo.name);
      if ('error' in found) return { ok: false, error: found.error };
      relative = found.person;
    }

    const bornYear = parseYear(args.bornYear);
    const diedYear = parseYear(args.diedYear);

    const person = await createPerson({
      displayName,
      familyName: args.familyName?.trim() || null,
      bornOn: bornYear !== undefined ? yearToDate(bornYear) : null,
      bornPrecision: bornYear !== undefined ? 'year' : null,
      diedOn: diedYear !== undefined ? yearToDate(diedYear) : null,
      diedPrecision: diedYear !== undefined ? 'year' : null,
      createdBy: ctx.userId,
      familyId: gate.familyId,
    });
    await addPersonToFamily(gate.familyId, person.id);

    let detail: string | undefined;
    if (relative && args.relateTo) {
      await connectPeople({ ...edgeFor(args.relateTo.relation, person.id, relative.id), createdBy: ctx.userId });
      detail = `${args.relateTo.relation} of ${relative.displayName}`;
    }

    const years = bornYear || diedYear ? ` (${bornYear ?? ''}${diedYear ? `–${diedYear}` : ''})` : '';
    return {
      ok: true,
      message: `Added ${displayName}${years} to the tree${detail ? `, as ${detail}` : ''}.`,
      receipt: {
        label: `Added ${displayName}${years}`,
        detail,
        undo: { kind: 'person', personId: person.id },
      },
    };
  },
});

/** relate_people — connect two people already in the active family's tree. */
export const relatePeopleTool = defineTool({
  name: 'relate_people',
  description:
    "Create a relationship between two people who are already in the active family's tree. " +
    'Contributor access required.',
  schema: z.object({
    personName: z.string().min(1).describe('The subject (must already exist in the tree).'),
    relativeName: z.string().min(1).describe('The relative (must already exist in the tree).'),
    relation,
  }),
  async execute(args, ctx) {
    const gate = await ensureContributor(ctx);
    if ('error' in gate) return { ok: false, error: gate.error };

    const subject = await resolvePerson(gate.familyId, args.personName);
    if ('error' in subject) return { ok: false, error: subject.error };
    const relative = await resolvePerson(gate.familyId, args.relativeName);
    if ('error' in relative) return { ok: false, error: relative.error };
    if (subject.person.id === relative.person.id) {
      return { ok: false, error: 'A person cannot be related to themselves.' };
    }

    const edge = edgeFor(args.relation, subject.person.id, relative.person.id);
    await connectPeople({ ...edge, createdBy: ctx.userId });

    const detail = `${args.relation} of ${relative.person.displayName}`;
    return {
      ok: true,
      message: `Linked ${subject.person.displayName} as ${detail}.`,
      receipt: {
        label: `Linked ${subject.person.displayName}`,
        detail,
        undo: { kind: 'relationship', relType: edge.type, from: edge.personFromId, to: edge.personToId },
      },
    };
  },
});

/** edit_person — fix the details of someone already in the active family's tree. */
export const editPersonTool = defineTool({
  name: 'edit_person',
  description:
    "Update an existing person in the active family's tree — correct their name, surname, or " +
    'birth/death year. Pass only the fields to change; pass null to clear a year or surname. ' +
    'Contributor access required.',
  schema: z.object({
    name: z.string().min(1).describe('The person to edit (their current name in the tree).'),
    newName: z.string().min(1).nullish().describe('A corrected display name.'),
    familyName: z.string().nullish().describe('A corrected surname (null to clear).'),
    bornYear: z.number().int().nullish().describe('Corrected birth year (null to clear).'),
    diedYear: z.number().int().nullish().describe('Corrected death year (null to clear).'),
  }),
  async execute(args, ctx) {
    const gate = await ensureContributor(ctx);
    if ('error' in gate) return { ok: false, error: gate.error };

    const found = await resolvePerson(gate.familyId, args.name);
    if ('error' in found) return { ok: false, error: found.error };

    const patch: PersonPatch = {};
    if (args.newName != null) {
      const trimmed = args.newName.trim();
      if (!trimmed) return { ok: false, error: 'The new name cannot be empty.' };
      patch.displayName = trimmed;
    }
    if (args.familyName !== undefined) patch.familyName = args.familyName?.trim() || null;
    if (args.bornYear !== undefined) {
      const y = parseYear(args.bornYear);
      patch.bornOn = args.bornYear === null || y === undefined ? null : yearToDate(y);
      patch.bornPrecision = patch.bornOn ? 'year' : null;
    }
    if (args.diedYear !== undefined) {
      const y = parseYear(args.diedYear);
      patch.diedOn = args.diedYear === null || y === undefined ? null : yearToDate(y);
      patch.diedPrecision = patch.diedOn ? 'year' : null;
    }
    if (Object.keys(patch).length === 0) {
      return { ok: false, error: 'Nothing to change — provide a new name, surname, or year.' };
    }

    await updatePerson(found.person.id, patch);
    const label = patch.displayName ?? found.person.displayName;
    return {
      ok: true,
      message: `Updated ${found.person.displayName}${patch.displayName ? ` (now ${patch.displayName})` : ''}.`,
      receipt: { label: `Updated ${label}` },
    };
  },
});

/** delete_person — remove someone from the active family's tree (and their relationships). */
export const deletePersonTool = defineTool({
  name: 'delete_person',
  description:
    "Delete a person from the active family's tree, along with their relationships. Use only when " +
    'the user clearly asks to remove someone. Cannot delete a person linked to an app account. ' +
    'This is hard to undo — confirm with the user first. Contributor access required.',
  schema: z.object({
    name: z.string().min(1).describe('The person to remove (must exist in the tree).'),
  }),
  async execute(args, ctx) {
    const gate = await ensureContributor(ctx);
    if ('error' in gate) return { ok: false, error: gate.error };

    const found = await resolvePerson(gate.familyId, args.name);
    if ('error' in found) return { ok: false, error: found.error };

    const person = await getPerson(found.person.id);
    if (!person) return { ok: false, error: `"${args.name}" is not in this family anymore.` };
    if (person.userId) {
      return { ok: false, error: `${person.displayName} is linked to an app account and cannot be deleted.` };
    }
    if (!(await isPersonInFamily(gate.familyId, person.id))) {
      return { ok: false, error: `${person.displayName} is not in this family.` };
    }

    await deletePerson(person.id);
    return {
      ok: true,
      message: `Removed ${person.displayName} from the tree.`,
      receipt: { label: `Removed ${person.displayName} from the tree` },
    };
  },
});

/** get_family_tree — read tool: everyone in the active family and how they're connected. */
export const getFamilyTreeTool = defineTool({
  name: 'get_family_tree',
  description:
    "List everyone in the active family's tree with their birth/death years. Use before adding " +
    'people to avoid duplicates or to answer questions about who is in the tree.',
  schema: z.object({}),
  async execute(_args, ctx) {
    if (!ctx.activeFamilyId) {
      return { ok: true, message: JSON.stringify({ people: [], note: 'No active family yet.' }) };
    }
    const people = await listFamilyPeople(ctx.activeFamilyId);
    return {
      ok: true,
      message: JSON.stringify(
        people.map((p) => ({
          name: p.displayName,
          familyName: p.familyName,
          born: p.bornOn ? new Date(p.bornOn).getUTCFullYear() : null,
          died: p.diedOn ? new Date(p.diedOn).getUTCFullYear() : null,
        })),
      ),
    };
  },
});
