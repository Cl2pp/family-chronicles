import { describe, expect, it } from 'vitest';
import type { PersonChange } from '@/lib/people-changes';
import { describePersonChange, type PeopleChangeDict } from './people-change-describe';

/** A minimal English-ish fake dictionary — enough to assert the composition logic
 *  without pulling in the real (much larger) i18n dictionaries. */
const t: PeopleChangeDict = {
  relationWord: (r) => r,
  addPerson: (label, years) => `Add ${label}${years}`,
  addPersonRelated: (label, years, relation, relative) => `Add ${label}${years} — ${relation} of ${relative}`,
  relate: (person, relation, relative) => `${person} → ${relation} of ${relative}`,
  unrelate: (person, relation, relative) => `${person} — no longer ${relation} of ${relative}`,
  editPerson: (label, summary) => `Edit ${label}: ${summary}`,
  deletePerson: (label) => `Remove ${label}`,
  editFieldFirstName: 'first name',
  editFieldFamilyName: 'surname',
  editFieldBirthFamilyName: 'birth surname',
  editFieldGender: 'gender',
  editFieldBorn: 'born',
  editFieldDied: 'died',
  editValueCleared: 'cleared',
  editValueMale: 'male',
  editValueFemale: 'female',
};

const existing = (personId: string, label: string) => ({ kind: 'existing' as const, personId, label });
const staged = (index: number, label: string) => ({ kind: 'staged' as const, index, label });

describe('describePersonChange', () => {
  it('describes a plain add with birth/death years', () => {
    const change: PersonChange = {
      op: 'add',
      firstName: 'Leonhard',
      familyName: 'Koch',
      birthFamilyName: null,
      gender: 'male',
      born: '1889',
      died: '1975',
    };
    expect(describePersonChange(t, change)).toBe('Add Leonhard Koch (1889–1975)');
  });

  it('describes an add with only a birth year', () => {
    const change: PersonChange = {
      op: 'add',
      firstName: 'Anna',
      familyName: null,
      birthFamilyName: null,
      gender: null,
      born: '1990-05',
      died: null,
    };
    expect(describePersonChange(t, change)).toBe('Add Anna (1990)');
  });

  it('describes an add with no dates at all', () => {
    const change: PersonChange = {
      op: 'add',
      firstName: 'Mira',
      familyName: 'Ortlepp',
      birthFamilyName: null,
      gender: null,
      born: null,
      died: null,
    };
    expect(describePersonChange(t, change)).toBe('Add Mira Ortlepp');
  });

  it('describes an add staged with a relateTo', () => {
    const change: PersonChange = {
      op: 'add',
      firstName: 'Gisela',
      familyName: 'Koch',
      birthFamilyName: null,
      gender: 'female',
      born: null,
      died: null,
      relateTo: { ref: existing('p1', 'Leonhard Koch'), relation: 'child' },
    };
    expect(describePersonChange(t, change)).toBe('Add Gisela Koch — child of Leonhard Koch');
  });

  it('resolves a relateTo pointing at a staged (not-yet-existing) person', () => {
    const change: PersonChange = {
      op: 'add',
      firstName: 'Peter',
      familyName: 'Koch',
      birthFamilyName: null,
      gender: 'male',
      born: null,
      died: null,
      relateTo: { ref: staged(0, 'Leonhard Koch'), relation: 'parent' },
    };
    expect(describePersonChange(t, change)).toBe('Add Peter Koch — parent of Leonhard Koch');
  });

  it('describes a relate change', () => {
    const change: PersonChange = {
      op: 'relate',
      person: existing('a', 'Leonhard Koch'),
      relative: existing('b', 'Gisela Koch'),
      relation: 'parent',
    };
    expect(describePersonChange(t, change)).toBe('Leonhard Koch → parent of Gisela Koch');
  });

  it('describes an unrelate change', () => {
    const change: PersonChange = {
      op: 'unrelate',
      person: existing('a', 'Leonhard Koch'),
      relative: existing('b', 'Gisela Koch'),
      relation: 'parent',
    };
    expect(describePersonChange(t, change)).toBe('Leonhard Koch — no longer parent of Gisela Koch');
  });

  it('describes an edit with a single changed field', () => {
    const change: PersonChange = {
      op: 'edit',
      person: existing('a', 'Gisela Schmalzbauer'),
      patch: { familyName: 'Koch' },
    };
    expect(describePersonChange(t, change)).toBe('Edit Gisela Schmalzbauer: surname → Koch');
  });

  it('describes an edit clearing a field', () => {
    const change: PersonChange = {
      op: 'edit',
      person: existing('a', 'Gisela Koch'),
      patch: { birthFamilyName: null },
    };
    expect(describePersonChange(t, change)).toBe('Edit Gisela Koch: birth surname → cleared');
  });

  it('joins several changed fields in one edit', () => {
    const change: PersonChange = {
      op: 'edit',
      person: existing('a', 'Gisela Koch'),
      patch: { born: '1920', died: '2001', gender: 'female' },
    };
    expect(describePersonChange(t, change)).toBe('Edit Gisela Koch: gender → female, born → 1920, died → 2001');
  });

  it('describes a delete change', () => {
    const change: PersonChange = { op: 'delete', person: existing('a', 'Gisela Koch') };
    expect(describePersonChange(t, change)).toBe('Remove Gisela Koch');
  });
});
