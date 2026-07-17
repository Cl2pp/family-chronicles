import { z } from 'zod';
import { countParents, getPerson, getTreeForChronicle, type PersonRelation } from '@/lib/people';
import {
  edgeChildRef,
  sameRef,
  toStoredDate,
  type PersonChange,
  type PersonEditPatch,
  type PersonRef,
} from '@/lib/people-changes';
import { personFullName } from '@/lib/person-name';
import { defineTool, type ToolContext } from './types';
import { ensureContributor, resolvePersonOrStaged } from './util';

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

const relation = z
  .enum(['parent', 'child', 'partner'])
  .describe("The subject's relation TO the named relative (e.g. 'parent' = subject is the relative's parent).");

const gender = z.enum(['male', 'female']).describe("The person's gender, if known.");

/** Get (creating on first use) this turn's staged tree-changes draft. A draft is bound
 *  to ONE chronicle — after a mid-conversation switch, staging starts a fresh draft
 *  rather than appending changes that could never apply to the old card's chronicle. */
function ensureDraft(ctx: ToolContext, chronicleId: string) {
  if (!ctx.peopleDraft || ctx.peopleDraft.chronicleId !== chronicleId) {
    ctx.peopleDraft = { chronicleId, chronicleName: ctx.activeChronicleName ?? '', changes: [] };
  }
  return ctx.peopleDraft;
}

/** How many parents `childRef` would have after everything currently staged runs, on
 *  top of what's already in the DB — best-effort (an `unrelate` targeting the same
 *  child frees a slot back up) so add/relate can warn before staging a third parent
 *  the eventual apply would just reject. */
async function tooManyParentsError(ctx: ToolContext, childRef: PersonRef): Promise<string | null> {
  const existing = childRef.kind === 'existing' ? await countParents(childRef.personId) : 0;

  let staged = 0;
  const changes = ctx.peopleDraft?.changes ?? [];
  changes.forEach((c, index) => {
    if (c.op === 'add' && c.relateTo) {
      const self: PersonRef = { kind: 'staged', index, label: '' };
      const child = edgeChildRef(self, c.relateTo.relation, c.relateTo.ref);
      if (child && sameRef(child, childRef)) staged += 1;
    } else if (c.op === 'relate') {
      const child = edgeChildRef(c.person, c.relation, c.relative);
      if (child && sameRef(child, childRef)) staged += 1;
    } else if (c.op === 'unrelate') {
      const child = edgeChildRef(c.person, c.relation, c.relative);
      if (child && sameRef(child, childRef)) staged -= 1;
    }
  });

  if (existing + staged >= 2) {
    return `${childRef.label} already has two parents (counting staged changes) — remove one of the existing parent links first, or discard the pending card.`;
  }
  return null;
}

const STAGED_NOTE =
  'The changes will be applied only when the user confirms the card — do not claim they are done.';

/** add_person — stage adding a person to the active chronicle's tree, optionally connected to a relative. */
export const addPersonTool = defineTool({
  name: 'add_person',
  description:
    "Stage adding a person to the active chronicle's tree onto the pending confirmation card. " +
    'Optionally connect them to someone already in the tree (or staged earlier in this same turn) via ' +
    'relateTo. Check get_family_tree first if unsure who already exists. Contributor access required.',
  schema: z.object({
    firstName: z
      .string()
      .min(1)
      .describe(
        'First name only, e.g. "Maria". If the person has several first names, put all of them ' +
          'here, e.g. "Anna Maria". Do NOT include the surname — that goes in familyName.',
      ),
    familyName: z.string().nullish().describe('The surname (last name), e.g. "Schmidt".'),
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
      .object({
        name: z.string().min(1).describe('An existing relative in this chronicle, or one staged earlier this turn.'),
        relation,
      })
      .nullish()
      .describe('Optionally connect the new person to an existing (or just-staged) relative.'),
  }),
  async execute(args, ctx) {
    const gate = await ensureContributor(ctx);
    if ('error' in gate) return { ok: false, error: gate.error };

    const firstName = args.firstName.trim();
    if (!firstName) return { ok: false, error: 'A first name is required.' };

    let relateTo: { ref: PersonRef; relation: PersonRelation } | undefined;
    if (args.relateTo) {
      const found = await resolvePersonOrStaged(ctx, gate.chronicleId, args.relateTo.name);
      if ('error' in found) return { ok: false, error: found.error };
      relateTo = { ref: found.ref, relation: args.relateTo.relation };
    }

    const born = toStoredDate(args.born);
    if ('error' in born) return { ok: false, error: born.error };
    const died = toStoredDate(args.died);
    if ('error' in died) return { ok: false, error: died.error };

    if (relateTo?.relation === 'parent') {
      const warn = await tooManyParentsError(ctx, relateTo.ref);
      if (warn) return { ok: false, error: warn };
    }

    const draft = ensureDraft(ctx, gate.chronicleId);
    const change: PersonChange = {
      op: 'add',
      firstName,
      familyName: args.familyName?.trim() || null,
      birthFamilyName: args.birthFamilyName?.trim() || null,
      gender: args.gender ?? null,
      born: partialDateString(born.date, born.precision),
      died: partialDateString(died.date, died.precision),
      relateTo,
    };
    draft.changes.push(change);

    const fullName = personFullName({ firstName, familyName: change.familyName });
    const bornYear = born.date?.getUTCFullYear();
    const diedYear = died.date?.getUTCFullYear();
    const years = bornYear || diedYear ? ` (${bornYear ?? ''}${diedYear ? `–${diedYear}` : ''})` : '';
    const detail = relateTo ? `, as ${relateTo.relation} of ${relateTo.ref.label}` : '';
    return {
      ok: true,
      message: `Staged (NOT yet applied): add ${fullName}${years}${detail} to the tree. ${STAGED_NOTE}`,
    };
  },
});

/** relate_people — stage connecting two people already in (or staged into) the active chronicle's tree. */
export const relatePeopleTool = defineTool({
  name: 'relate_people',
  description:
    "Stage a relationship between two people already in the active chronicle's tree (or staged " +
    'earlier this turn) onto the pending confirmation card. A person can have at most two parents — ' +
    'check get_family_tree for existing relationships before adding parent links. Contributor access required.',
  schema: z.object({
    personName: z.string().min(1).describe('The subject (must already exist, or be staged earlier this turn).'),
    relativeName: z.string().min(1).describe('The relative (must already exist, or be staged earlier this turn).'),
    relation,
  }),
  async execute(args, ctx) {
    const gate = await ensureContributor(ctx);
    if ('error' in gate) return { ok: false, error: gate.error };

    const subject = await resolvePersonOrStaged(ctx, gate.chronicleId, args.personName);
    if ('error' in subject) return { ok: false, error: subject.error };
    const relative = await resolvePersonOrStaged(ctx, gate.chronicleId, args.relativeName);
    if ('error' in relative) return { ok: false, error: relative.error };
    if (sameRef(subject.ref, relative.ref)) {
      return { ok: false, error: 'A person cannot be related to themselves.' };
    }

    const child = edgeChildRef(subject.ref, args.relation, relative.ref);
    if (child) {
      const warn = await tooManyParentsError(ctx, child);
      if (warn) return { ok: false, error: warn };
    }

    const draft = ensureDraft(ctx, gate.chronicleId);
    draft.changes.push({ op: 'relate', person: subject.ref, relative: relative.ref, relation: args.relation });

    const detail = `${args.relation} of ${relative.ref.label}`;
    return {
      ok: true,
      message: `Staged (NOT yet applied): link ${subject.ref.label} as ${detail}. ${STAGED_NOTE}`,
    };
  },
});

/** unrelate_people — stage removing a relationship between two people in the active chronicle's tree. */
export const unrelatePeopleTool = defineTool({
  name: 'unrelate_people',
  description:
    "Stage removing an existing relationship between two people in the active chronicle's tree " +
    '(onto the pending confirmation card) — e.g. to fix a wrongly linked parent or partner. The people ' +
    'themselves stay. Contributor access required.',
  schema: z.object({
    personName: z.string().min(1).describe('The subject (must already exist in the tree).'),
    relativeName: z.string().min(1).describe('The relative to disconnect from (must already exist).'),
    relation,
  }),
  async execute(args, ctx) {
    const gate = await ensureContributor(ctx);
    if ('error' in gate) return { ok: false, error: gate.error };

    const subject = await resolvePersonOrStaged(ctx, gate.chronicleId, args.personName);
    if ('error' in subject) return { ok: false, error: subject.error };
    const relative = await resolvePersonOrStaged(ctx, gate.chronicleId, args.relativeName);
    if ('error' in relative) return { ok: false, error: relative.error };

    const draft = ensureDraft(ctx, gate.chronicleId);
    draft.changes.push({ op: 'unrelate', person: subject.ref, relative: relative.ref, relation: args.relation });

    const detail = `no longer ${args.relation} of ${relative.ref.label}`;
    return {
      ok: true,
      message: `Staged (NOT yet applied): remove the link — ${subject.ref.label} ${detail}. ${STAGED_NOTE}`,
    };
  },
});

/** edit_person — stage a correction to someone already in (or staged into) the active chronicle's tree. */
export const editPersonTool = defineTool({
  name: 'edit_person',
  description:
    "Stage a correction to an existing person in the active chronicle's tree (name, surname, birth " +
    'name, gender, or birth/death date) onto the pending confirmation card. Pass only the fields to ' +
    'change; pass null to clear a field. Contributor access required.',
  schema: z.object({
    name: z.string().min(1).describe('The person to edit (their current name in the tree).'),
    newName: z
      .string()
      .min(1)
      .nullish()
      .describe(
        'A corrected first name (first name(s) only — all first names go here; the surname belongs in familyName).',
      ),
    familyName: z.string().nullish().describe('A corrected surname / last name (null to clear).'),
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

    const found = await resolvePersonOrStaged(ctx, gate.chronicleId, args.name);
    if ('error' in found) return { ok: false, error: found.error };

    const patch: PersonEditPatch = {};
    if (args.newName != null) {
      const trimmed = args.newName.trim();
      if (!trimmed) return { ok: false, error: 'The new first name cannot be empty.' };
      patch.firstName = trimmed;
    }
    if (args.familyName !== undefined) patch.familyName = args.familyName?.trim() || null;
    if (args.birthFamilyName !== undefined) patch.birthFamilyName = args.birthFamilyName?.trim() || null;
    if (args.gender !== undefined) patch.gender = args.gender;
    if (args.born !== undefined) {
      const born = toStoredDate(args.born);
      if ('error' in born) return { ok: false, error: born.error };
      patch.born = args.born?.trim() || null;
    }
    if (args.died !== undefined) {
      const died = toStoredDate(args.died);
      if ('error' in died) return { ok: false, error: died.error };
      patch.died = args.died?.trim() || null;
    }
    if (Object.keys(patch).length === 0) {
      return { ok: false, error: 'Nothing to change — provide a new name, surname, gender, or date.' };
    }

    const draft = ensureDraft(ctx, gate.chronicleId);
    draft.changes.push({ op: 'edit', person: found.ref, patch });

    return {
      ok: true,
      message: `Staged (NOT yet applied): update ${found.ref.label}. ${STAGED_NOTE}`,
    };
  },
});

/** delete_person — stage removing someone from the active chronicle's tree (and their relationships). */
export const deletePersonTool = defineTool({
  name: 'delete_person',
  description:
    "Stage deleting a person from the active chronicle's tree, along with their relationships, onto " +
    'the pending confirmation card. Use only when the user clearly asks to remove someone. Cannot ' +
    'delete a person linked to an app account. This is hard to undo — confirm with the user first. ' +
    'Contributor access required.',
  schema: z.object({
    name: z.string().min(1).describe('The person to remove (must exist in the tree).'),
  }),
  async execute(args, ctx) {
    const gate = await ensureContributor(ctx);
    if ('error' in gate) return { ok: false, error: gate.error };

    const found = await resolvePersonOrStaged(ctx, gate.chronicleId, args.name);
    if ('error' in found) return { ok: false, error: found.error };

    // As much of the real guard as we can check now — applyPeopleChanges re-checks at
    // apply time too, since the person could change between staging and confirming.
    if (found.ref.kind === 'existing') {
      const person = await getPerson(found.ref.personId);
      if (!person) return { ok: false, error: `"${args.name}" is not in this chronicle anymore.` };
      if (person.userId) {
        return { ok: false, error: `${found.ref.label} is linked to an app account and cannot be deleted.` };
      }
    }

    const draft = ensureDraft(ctx, gate.chronicleId);
    draft.changes.push({ op: 'delete', person: found.ref });

    return {
      ok: true,
      message: `Staged (NOT yet applied): remove ${found.ref.label} from the tree. ${STAGED_NOTE}`,
    };
  },
});

/** get_family_tree — read tool: everyone in the active chronicle and how they're connected. Stays
 *  direct (no staging) — it never mutates anything. */
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
    const nameOf = new Map(tree.people.map((p) => [p.id, personFullName(p)]));
    return {
      ok: true,
      message: JSON.stringify({
        people: tree.people.map((p) => ({
          name: personFullName(p),
          firstName: p.firstName,
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
