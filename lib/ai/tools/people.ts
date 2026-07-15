import { z } from 'zod';
import {
  addPersonToChronicle,
  connectPeople,
  createPerson,
  deletePerson,
  edgeForRelation,
  getPerson,
  getTreeForChronicle,
  isPersonInChronicle,
  removeRelationship,
  updatePerson,
  type PersonPatch,
} from '@/lib/people';
import { parsePartialDate, partsToEventDate } from '@/lib/dates';
import { defineTool } from './types';
import { ensureContributor, resolvePerson } from './util';

const DATE_FORMAT_ERROR = 'Dates must be "YYYY", "YYYY-MM", or "YYYY-MM-DD".';

/**
 * A tool's partial-date string as stored date + precision. `null`/missing input
 * clears; an unparsable string returns an error instead of silently clearing.
 */
/** A stored date back to "YYYY[-MM[-DD]]" at its precision ('circa' shows only the year). */
function partialDateString(date: Date | null, precision: string | null): string | null {
  if (!date) return null;
  const d = new Date(date);
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = String(d.getUTCFullYear());
  if (precision === 'day') return `${year}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (precision === 'month') return `${year}-${pad(d.getUTCMonth() + 1)}`;
  return year;
}

function toStoredDate(
  value: string | null | undefined,
): { date: Date | null; precision: 'day' | 'month' | 'year' | null } | { error: string } {
  if (value == null) return { date: null, precision: null };
  const parts = parsePartialDate(value);
  if (!parts) return { error: DATE_FORMAT_ERROR };
  const { eventDate, eventDatePrecision } = partsToEventDate(parts);
  return { date: eventDate, precision: eventDatePrecision };
}

const relation = z
  .enum(['parent', 'child', 'partner'])
  .describe("The subject's relation TO the named relative (e.g. 'parent' = subject is the relative's parent).");

const gender = z.enum(['male', 'female']).describe("The person's gender, if known.");

/** add_person — create a person in the active chronicle's tree, optionally connected to a relative. */
export const addPersonTool = defineTool({
  name: 'add_person',
  description:
    "Add a person to the active chronicle's tree. Optionally connect them to someone already in the " +
    'tree via relateTo. Check get_family_tree first if unsure who already exists. Contributor access required.',
  schema: z.object({
    displayName: z.string().min(1).describe('The name to show, e.g. "Maria" or "Maria Schmidt".'),
    familyName: z.string().nullish().describe('Optional surname.'),
    birthFamilyName: z
      .string()
      .nullish()
      .describe('Surname at birth, if it differs from the current surname (e.g. maiden name).'),
    gender: gender.nullish(),
    born: z
      .string()
      .nullish()
      .describe('Birth date as "YYYY", "YYYY-MM", or "YYYY-MM-DD" — as precise as known.'),
    died: z.string().nullish().describe('Death date, same format as born.'),
    relateTo: z
      .object({ name: z.string().min(1).describe('An existing relative in this chronicle.'), relation })
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
      const found = await resolvePerson(gate.chronicleId, args.relateTo.name);
      if ('error' in found) return { ok: false, error: found.error };
      relative = found.person;
    }

    const born = toStoredDate(args.born);
    if ('error' in born) return { ok: false, error: born.error };
    const died = toStoredDate(args.died);
    if ('error' in died) return { ok: false, error: died.error };

    const person = await createPerson({
      displayName,
      familyName: args.familyName?.trim() || null,
      birthFamilyName: args.birthFamilyName?.trim() || null,
      gender: args.gender ?? null,
      bornOn: born.date,
      bornPrecision: born.precision,
      diedOn: died.date,
      diedPrecision: died.precision,
      createdBy: ctx.userId,
      chronicleId: gate.chronicleId,
    });
    await addPersonToChronicle(gate.chronicleId, person.id);

    let detail: string | undefined;
    if (relative && args.relateTo) {
      await connectPeople({
        ...edgeForRelation(args.relateTo.relation, person.id, relative.id),
        createdBy: ctx.userId,
      });
      detail = `${args.relateTo.relation} of ${relative.displayName}`;
    }

    const bornYear = born.date?.getUTCFullYear();
    const diedYear = died.date?.getUTCFullYear();
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

/** relate_people — connect two people already in the active chronicle's tree. */
export const relatePeopleTool = defineTool({
  name: 'relate_people',
  description:
    "Create a relationship between two people who are already in the active chronicle's tree. " +
    'A person can have at most two parents — check get_family_tree for existing relationships ' +
    'before adding parent links. Contributor access required.',
  schema: z.object({
    personName: z.string().min(1).describe('The subject (must already exist in the tree).'),
    relativeName: z.string().min(1).describe('The relative (must already exist in the tree).'),
    relation,
  }),
  async execute(args, ctx) {
    const gate = await ensureContributor(ctx);
    if ('error' in gate) return { ok: false, error: gate.error };

    const subject = await resolvePerson(gate.chronicleId, args.personName);
    if ('error' in subject) return { ok: false, error: subject.error };
    const relative = await resolvePerson(gate.chronicleId, args.relativeName);
    if ('error' in relative) return { ok: false, error: relative.error };
    if (subject.person.id === relative.person.id) {
      return { ok: false, error: 'A person cannot be related to themselves.' };
    }

    const edge = edgeForRelation(args.relation, subject.person.id, relative.person.id);
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

/** unrelate_people — remove a relationship between two people in the active chronicle's tree. */
export const unrelatePeopleTool = defineTool({
  name: 'unrelate_people',
  description:
    "Remove an existing relationship between two people in the active chronicle's tree — e.g. to fix " +
    'a wrongly linked parent or partner. The people themselves are kept. Contributor access required.',
  schema: z.object({
    personName: z.string().min(1).describe('The subject (must already exist in the tree).'),
    relativeName: z.string().min(1).describe('The relative to disconnect from (must already exist).'),
    relation,
  }),
  async execute(args, ctx) {
    const gate = await ensureContributor(ctx);
    if ('error' in gate) return { ok: false, error: gate.error };

    const subject = await resolvePerson(gate.chronicleId, args.personName);
    if ('error' in subject) return { ok: false, error: subject.error };
    const relative = await resolvePerson(gate.chronicleId, args.relativeName);
    if ('error' in relative) return { ok: false, error: relative.error };

    const edge = edgeForRelation(args.relation, subject.person.id, relative.person.id);
    await removeRelationship(edge);

    const detail = `${args.relation} of ${relative.person.displayName}`;
    return {
      ok: true,
      message: `Removed the link: ${subject.person.displayName} is no longer ${detail}.`,
      receipt: { label: `Unlinked ${subject.person.displayName}`, detail: `no longer ${detail}` },
    };
  },
});

/** edit_person — fix the details of someone already in the active chronicle's tree. */
export const editPersonTool = defineTool({
  name: 'edit_person',
  description:
    "Update an existing person in the active chronicle's tree — correct their name, surname, " +
    'birth name, gender, or birth/death date. Pass only the fields to change; pass null to ' +
    'clear a field. Contributor access required.',
  schema: z.object({
    name: z.string().min(1).describe('The person to edit (their current name in the tree).'),
    newName: z.string().min(1).nullish().describe('A corrected display name.'),
    familyName: z.string().nullish().describe('A corrected surname (null to clear).'),
    birthFamilyName: z
      .string()
      .nullish()
      .describe('The surname at birth, e.g. a maiden name (null to clear).'),
    gender: gender.nullish().describe("The person's gender (null to clear)."),
    born: z
      .string()
      .nullish()
      .describe('Corrected birth date as "YYYY", "YYYY-MM", or "YYYY-MM-DD" (null to clear).'),
    died: z.string().nullish().describe('Corrected death date, same format (null to clear).'),
  }),
  async execute(args, ctx) {
    const gate = await ensureContributor(ctx);
    if ('error' in gate) return { ok: false, error: gate.error };

    const found = await resolvePerson(gate.chronicleId, args.name);
    if ('error' in found) return { ok: false, error: found.error };

    const patch: PersonPatch = {};
    if (args.newName != null) {
      const trimmed = args.newName.trim();
      if (!trimmed) return { ok: false, error: 'The new name cannot be empty.' };
      patch.displayName = trimmed;
    }
    if (args.familyName !== undefined) patch.familyName = args.familyName?.trim() || null;
    if (args.birthFamilyName !== undefined) {
      patch.birthFamilyName = args.birthFamilyName?.trim() || null;
    }
    if (args.gender !== undefined) patch.gender = args.gender;
    if (args.born !== undefined) {
      const born = toStoredDate(args.born);
      if ('error' in born) return { ok: false, error: born.error };
      patch.bornOn = born.date;
      patch.bornPrecision = born.precision;
    }
    if (args.died !== undefined) {
      const died = toStoredDate(args.died);
      if ('error' in died) return { ok: false, error: died.error };
      patch.diedOn = died.date;
      patch.diedPrecision = died.precision;
    }
    if (Object.keys(patch).length === 0) {
      return { ok: false, error: 'Nothing to change — provide a new name, surname, gender, or date.' };
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

/** delete_person — remove someone from the active chronicle's tree (and their relationships). */
export const deletePersonTool = defineTool({
  name: 'delete_person',
  description:
    "Delete a person from the active chronicle's tree, along with their relationships. Use only when " +
    'the user clearly asks to remove someone. Cannot delete a person linked to an app account. ' +
    'This is hard to undo — confirm with the user first. Contributor access required.',
  schema: z.object({
    name: z.string().min(1).describe('The person to remove (must exist in the tree).'),
  }),
  async execute(args, ctx) {
    const gate = await ensureContributor(ctx);
    if ('error' in gate) return { ok: false, error: gate.error };

    const found = await resolvePerson(gate.chronicleId, args.name);
    if ('error' in found) return { ok: false, error: found.error };

    const person = await getPerson(found.person.id);
    if (!person) return { ok: false, error: `"${args.name}" is not in this chronicle anymore.` };
    if (person.userId) {
      return { ok: false, error: `${person.displayName} is linked to an app account and cannot be deleted.` };
    }
    if (!(await isPersonInChronicle(gate.chronicleId, person.id))) {
      return { ok: false, error: `${person.displayName} is not in this chronicle.` };
    }

    await deletePerson(person.id);
    return {
      ok: true,
      message: `Removed ${person.displayName} from the tree.`,
      receipt: { label: `Removed ${person.displayName} from the tree` },
    };
  },
});

/** get_family_tree — read tool: everyone in the active chronicle and how they're connected. */
export const getFamilyTreeTool = defineTool({
  name: 'get_family_tree',
  description:
    "List everyone in the active chronicle's tree with their gender, birth/death dates, derived " +
    'family tags, and the kinship relationships between them. Use before adding or linking people ' +
    'to avoid duplicates, wrong links, or giving someone a third parent.',
  schema: z.object({}),
  async execute(_args, ctx) {
    if (!ctx.activeChronicleId) {
      return {
        ok: true,
        message: JSON.stringify({ people: [], relationships: [], note: 'No active chronicle yet.' }),
      };
    }
    const tree = await getTreeForChronicle(ctx.activeChronicleId);
    const nameOf = new Map(tree.people.map((p) => [p.id, p.displayName]));
    return {
      ok: true,
      message: JSON.stringify({
        people: tree.people.map((p) => ({
          name: p.displayName,
          familyName: p.familyName,
          birthFamilyName: p.birthFamilyName,
          familyTags: p.familyTags,
          gender: p.gender,
          born: partialDateString(p.bornOn, p.bornPrecision),
          died: partialDateString(p.diedOn, p.diedPrecision),
        })),
        relationships: tree.edges.map((e) =>
          e.type === 'parent'
            ? { parent: nameOf.get(e.from), child: nameOf.get(e.to) }
            : { partners: [nameOf.get(e.from), nameOf.get(e.to)] },
        ),
      }),
    };
  },
});
