import { getMembership } from '@/lib/chronicles';
import {
  connectPeople,
  createPerson,
  deletePerson,
  edgeForRelation,
  getPerson,
  isPersonInChronicle,
  removeRelationship,
  updatePerson,
  type PersonPatch,
  type PersonRelation,
} from '@/lib/people';
import { parsePartialDate, partsToEventDate } from '@/lib/dates';
import { personFullName } from '@/lib/person-name';
import { canContribute, type AccessRole } from '@/lib/permissions';
import type { Receipt } from './ai/tools/types';

/**
 * People-mutation tools (lib/ai/tools/people.ts) no longer write to the DB directly —
 * they push a `PersonChange` onto the turn's `PeopleDraft` instead, which the chat
 * renders as a confirmation card. This module owns the changeset's shape and the
 * logic that actually applies it (on Apply/confirm), so the tool layer and the server
 * actions that resolve a card share exactly one code path.
 */

/**
 * Points at a person the change touches. `existing` is a real DB row; `staged` points
 * at an `add` change earlier in the SAME changeset (its index into `changes`) — the
 * person it names doesn't exist yet, so it can only be resolved once that earlier `add`
 * has run. `label` is the human-readable full name captured when the change was
 * staged, purely for display — apply-time logic re-reads the real row for anything
 * that matters.
 */
export type PersonRef =
  | { kind: 'existing'; personId: string; label: string }
  | { kind: 'staged'; index: number; label: string };

export type PersonChange =
  | {
      op: 'add';
      firstName: string;
      familyName: string | null;
      birthFamilyName: string | null;
      gender: 'male' | 'female' | null;
      /** "YYYY[-MM[-DD]]", already format-validated at stage time. */
      born: string | null;
      died: string | null;
      relateTo?: { ref: PersonRef; relation: PersonRelation };
    }
  | { op: 'relate'; person: PersonRef; relative: PersonRef; relation: PersonRelation }
  | { op: 'unrelate'; person: PersonRef; relative: PersonRef; relation: PersonRelation }
  | {
      op: 'edit';
      person: PersonRef;
      patch: {
        firstName?: string;
        familyName?: string | null;
        birthFamilyName?: string | null;
        gender?: 'male' | 'female' | null;
        born?: string | null;
        died?: string | null;
      };
    }
  | { op: 'delete'; person: PersonRef };

/** The field patch an `edit` change carries — pulled out so the staging tool can build
 *  one without repeating the shape. */
export type PersonEditPatch = Extract<PersonChange, { op: 'edit' }>['patch'];

/** A batch of not-yet-applied tree edits, bound to the chronicle they target. */
export interface PeopleDraft {
  chronicleId: string;
  chronicleName: string;
  changes: PersonChange[];
}

const DATE_FORMAT_ERROR = 'Dates must be "YYYY", "YYYY-MM", or "YYYY-MM-DD".';

/**
 * A tool's partial-date string as a stored date + precision. `null`/missing input
 * clears the field; an unparsable string returns an error instead of silently
 * clearing it. Shared by the staging tools (to validate up front) and by
 * `applyPeopleChanges` (which re-parses the staged string at apply time rather than
 * trusting a Date that crossed a serialization boundary).
 */
export function toStoredDate(
  value: string | null | undefined,
): { date: Date | null; precision: 'day' | 'month' | 'year' | null } | { error: string } {
  if (value == null) return { date: null, precision: null };
  const parts = parsePartialDate(value);
  if (!parts) return { error: DATE_FORMAT_ERROR };
  const { eventDate, eventDatePrecision } = partsToEventDate(parts);
  return { date: eventDate, precision: eventDatePrecision };
}

/** True when two refs name the same person (same DB row, or same staged slot). */
export function sameRef(a: PersonRef, b: PersonRef): boolean {
  if (a.kind === 'existing' && b.kind === 'existing') return a.personId === b.personId;
  if (a.kind === 'staged' && b.kind === 'staged') return a.index === b.index;
  return false;
}

/** Which ref becomes "the child" of a person/relative/relation triple, or null for
 *  a partner edge (no parent relationship). Mirrors lib/people.ts's edgeForRelation. */
export function edgeChildRef(
  person: PersonRef,
  relation: PersonRelation,
  relative: PersonRef,
): PersonRef | null {
  if (relation === 'parent') return relative; // person is the relative's parent
  if (relation === 'child') return person; // person is the relative's child
  return null;
}

/** A person resolved from a ref, with the fields other changes might need. */
interface ResolvedPerson {
  id: string;
  firstName: string;
  familyName: string | null;
}

/**
 * Execute a staged batch of tree edits in order, exactly the way the (formerly
 * direct-write) tools in lib/ai/tools/people.ts used to: same receipts, same undo
 * actions, same guards. A failed change appends an error and the rest still run —
 * one bad ref in a 5-change card shouldn't sink the other 4.
 */
export async function applyPeopleChanges(
  draft: PeopleDraft,
  userId: string,
): Promise<{ receipts: Receipt[]; errors: string[] }> {
  const receipts: Receipt[] = [];
  const errors: string[] = [];

  const membership = await getMembership(draft.chronicleId, userId);
  if (!membership || !canContribute(membership.accessRole as AccessRole)) {
    return { receipts, errors: ['You no longer have contributor access to this chronicle.'] };
  }

  // Filled in as `add` changes run, so later changes in the same batch can refer to a
  // person the batch itself just created.
  const stagedIds = new Map<number, string>();

  async function resolveRef(ref: PersonRef): Promise<ResolvedPerson | { error: string }> {
    if (ref.kind === 'staged') {
      const id = stagedIds.get(ref.index);
      if (!id) return { error: `${ref.label} could not be created earlier in this change set.` };
      const person = await getPerson(id);
      if (!person) return { error: `${ref.label} could not be found.` };
      return { id, firstName: person.firstName, familyName: person.familyName };
    }
    if (!(await isPersonInChronicle(draft.chronicleId, ref.personId))) {
      return { error: `${ref.label} is no longer in this chronicle.` };
    }
    const person = await getPerson(ref.personId);
    if (!person) return { error: `${ref.label} no longer exists.` };
    return { id: ref.personId, firstName: person.firstName, familyName: person.familyName };
  }

  for (let i = 0; i < draft.changes.length; i++) {
    const change = draft.changes[i];
    try {
      if (change.op === 'add') {
        const born = toStoredDate(change.born);
        if ('error' in born) {
          errors.push(born.error);
          continue;
        }
        const died = toStoredDate(change.died);
        if ('error' in died) {
          errors.push(died.error);
          continue;
        }

        // createPerson also inserts the chronicle_members row when given chronicleId.
        const person = await createPerson({
          firstName: change.firstName,
          familyName: change.familyName,
          birthFamilyName: change.birthFamilyName,
          gender: change.gender,
          bornOn: born.date,
          bornPrecision: born.precision,
          diedOn: died.date,
          diedPrecision: died.precision,
          createdBy: userId,
          chronicleId: draft.chronicleId,
        });
        stagedIds.set(i, person.id);

        let detail: string | undefined;
        if (change.relateTo) {
          const relative = await resolveRef(change.relateTo.ref);
          if ('error' in relative) {
            errors.push(relative.error);
          } else {
            await connectPeople({
              ...edgeForRelation(change.relateTo.relation, person.id, relative.id),
              createdBy: userId,
            });
            detail = `${change.relateTo.relation} of ${change.relateTo.ref.label}`;
          }
        }

        const fullName = personFullName(person);
        const bornYear = born.date?.getUTCFullYear();
        const diedYear = died.date?.getUTCFullYear();
        const years = bornYear || diedYear ? ` (${bornYear ?? ''}${diedYear ? `–${diedYear}` : ''})` : '';
        receipts.push({
          label: `Added ${fullName}${years}`,
          detail,
          undo: { kind: 'person', personId: person.id },
        });
      } else if (change.op === 'relate') {
        const subject = await resolveRef(change.person);
        if ('error' in subject) {
          errors.push(subject.error);
          continue;
        }
        const relative = await resolveRef(change.relative);
        if ('error' in relative) {
          errors.push(relative.error);
          continue;
        }
        if (subject.id === relative.id) {
          errors.push('A person cannot be related to themselves.');
          continue;
        }
        const edge = edgeForRelation(change.relation, subject.id, relative.id);
        await connectPeople({ ...edge, createdBy: userId });
        receipts.push({
          label: `Linked ${change.person.label}`,
          detail: `${change.relation} of ${change.relative.label}`,
          undo: { kind: 'relationship', relType: edge.type, from: edge.personFromId, to: edge.personToId },
        });
      } else if (change.op === 'unrelate') {
        const subject = await resolveRef(change.person);
        if ('error' in subject) {
          errors.push(subject.error);
          continue;
        }
        const relative = await resolveRef(change.relative);
        if ('error' in relative) {
          errors.push(relative.error);
          continue;
        }
        const edge = edgeForRelation(change.relation, subject.id, relative.id);
        await removeRelationship(edge);
        receipts.push({
          label: `Unlinked ${change.person.label}`,
          detail: `no longer ${change.relation} of ${change.relative.label}`,
        });
      } else if (change.op === 'edit') {
        const subject = await resolveRef(change.person);
        if ('error' in subject) {
          errors.push(subject.error);
          continue;
        }
        const patch: PersonPatch = {};
        if (change.patch.firstName !== undefined) patch.firstName = change.patch.firstName;
        if (change.patch.familyName !== undefined) patch.familyName = change.patch.familyName;
        if (change.patch.birthFamilyName !== undefined) patch.birthFamilyName = change.patch.birthFamilyName;
        if (change.patch.gender !== undefined) patch.gender = change.patch.gender;
        if (change.patch.born !== undefined) {
          const born = toStoredDate(change.patch.born);
          if ('error' in born) {
            errors.push(born.error);
            continue;
          }
          patch.bornOn = born.date;
          patch.bornPrecision = born.precision;
        }
        if (change.patch.died !== undefined) {
          const died = toStoredDate(change.patch.died);
          if ('error' in died) {
            errors.push(died.error);
            continue;
          }
          patch.diedOn = died.date;
          patch.diedPrecision = died.precision;
        }
        await updatePerson(subject.id, patch);
        const after = personFullName({
          firstName: patch.firstName ?? subject.firstName,
          familyName: patch.familyName !== undefined ? patch.familyName : subject.familyName,
        });
        receipts.push({ label: `Updated ${after !== change.person.label ? after : change.person.label}` });
      } else if (change.op === 'delete') {
        const subject = await resolveRef(change.person);
        if ('error' in subject) {
          errors.push(subject.error);
          continue;
        }
        const person = await getPerson(subject.id);
        if (!person) {
          errors.push(`${change.person.label} is not in this chronicle anymore.`);
          continue;
        }
        if (person.userId) {
          errors.push(`${change.person.label} is linked to an app account and cannot be deleted.`);
          continue;
        }
        await deletePerson(person.id);
        receipts.push({ label: `Removed ${change.person.label} from the tree` });
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : `Change ${i + 1} failed unexpectedly.`);
    }
  }

  return { receipts, errors };
}
