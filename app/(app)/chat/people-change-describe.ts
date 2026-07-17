import type { PersonChange } from '@/lib/people-changes';

/**
 * The subset of the i18n `chat` dictionary the describe functions below need — kept
 * narrow (rather than the full `Dictionary['chat']`) so this stays a pure, dependency-
 * free function the unit tests can call with a small fake dictionary instead of the
 * whole app's translations. `t.chat` from `useI18n()` satisfies this structurally.
 */
export interface PeopleChangeDict {
  relationWord: (r: 'parent' | 'child' | 'partner') => string;
  addPerson: (label: string, years: string) => string;
  addPersonRelated: (label: string, years: string, relation: string, relative: string) => string;
  relate: (person: string, relation: string, relative: string) => string;
  unrelate: (person: string, relation: string, relative: string) => string;
  editPerson: (label: string, summary: string) => string;
  deletePerson: (label: string) => string;
  editFieldFirstName: string;
  editFieldFamilyName: string;
  editFieldBirthFamilyName: string;
  editFieldGender: string;
  editFieldBorn: string;
  editFieldDied: string;
  editValueCleared: string;
  editValueMale: string;
  editValueFemale: string;
}

/** " (1889–1975)" / " (1889–)" / "" — years pulled from the stored "YYYY[-MM[-DD]]" strings. */
function yearsSuffix(born: string | null, died: string | null): string {
  const bornYear = born?.slice(0, 4) ?? '';
  const diedYear = died?.slice(0, 4) ?? '';
  if (!bornYear && !diedYear) return '';
  return ` (${bornYear}${diedYear ? `–${diedYear}` : ''})`;
}

/** "surname → Koch" / "surname cleared" style fragments, joined for an `edit` change. */
function editSummary(t: PeopleChangeDict, patch: Extract<PersonChange, { op: 'edit' }>['patch']): string {
  const parts: string[] = [];
  if (patch.firstName !== undefined) parts.push(`${t.editFieldFirstName} → ${patch.firstName}`);
  if (patch.familyName !== undefined) {
    parts.push(`${t.editFieldFamilyName} → ${patch.familyName ?? t.editValueCleared}`);
  }
  if (patch.birthFamilyName !== undefined) {
    parts.push(`${t.editFieldBirthFamilyName} → ${patch.birthFamilyName ?? t.editValueCleared}`);
  }
  if (patch.gender !== undefined) {
    const value = patch.gender === 'male' ? t.editValueMale : patch.gender === 'female' ? t.editValueFemale : t.editValueCleared;
    parts.push(`${t.editFieldGender} → ${value}`);
  }
  if (patch.born !== undefined) parts.push(`${t.editFieldBorn} → ${patch.born ?? t.editValueCleared}`);
  if (patch.died !== undefined) parts.push(`${t.editFieldDied} → ${patch.died ?? t.editValueCleared}`);
  return parts.join(', ');
}

/**
 * One display line for a staged `PersonChange`, in the user's language — what the
 * tree-changes confirmation card lists per row. Pure (no DB, no React), so it's
 * covered by a plain unit test rather than a component/render test.
 */
export function describePersonChange(t: PeopleChangeDict, change: PersonChange): string {
  switch (change.op) {
    case 'add': {
      const label = [change.firstName, change.familyName].filter(Boolean).join(' ');
      const years = yearsSuffix(change.born, change.died);
      if (change.relateTo) {
        return t.addPersonRelated(
          label,
          years,
          t.relationWord(change.relateTo.relation),
          change.relateTo.ref.label,
        );
      }
      return t.addPerson(label, years);
    }
    case 'relate':
      return t.relate(change.person.label, t.relationWord(change.relation), change.relative.label);
    case 'unrelate':
      return t.unrelate(change.person.label, t.relationWord(change.relation), change.relative.label);
    case 'edit':
      return t.editPerson(change.person.label, editSummary(t, change.patch));
    case 'delete':
      return t.deletePerson(change.person.label);
  }
}
