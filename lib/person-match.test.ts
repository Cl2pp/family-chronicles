import { describe, expect, it } from 'vitest';
import { findPersonByName, matchPeopleByName } from './person-match';

/** The Koch family from the 2026-07-16 incident: two Giselas the agent could not tell apart. */
const kochs = [
  { id: 'gisela-k', firstName: 'Gisela', familyName: 'Koch' },
  { id: 'gisela-s', firstName: 'Gisela', familyName: 'Schmalzbauer' },
  // Legacy row: full name still stored in firstName (pre-rename data shape).
  { id: 'leonhard', firstName: 'Leonhard Koch', familyName: 'Koch' },
  { id: 'frieda', firstName: 'Frieda', familyName: 'Koch', birthFamilyName: 'Loges' },
];

describe('findPersonByName', () => {
  it('matches an exact stored name', () => {
    expect(findPersonByName(kochs, 'Leonhard Koch')).toEqual({ person: kochs[2] });
  });

  it('disambiguates a shared first name by family name', () => {
    expect(findPersonByName(kochs, 'Gisela Koch')).toEqual({ person: kochs[0] });
    expect(findPersonByName(kochs, 'Gisela Schmalzbauer')).toEqual({ person: kochs[1] });
  });

  it('disambiguates by the surname at birth', () => {
    expect(findPersonByName(kochs, 'Frieda Loges')).toEqual({ person: kochs[3] });
  });

  it('stays ambiguous on a bare shared first name', () => {
    expect(findPersonByName(kochs, 'Gisela')).toEqual({
      error: 'ambiguous',
      candidates: [kochs[0], kochs[1]],
    });
  });

  it('stays ambiguous when first name + family name match several people', () => {
    const twins = [
      { id: 'a', firstName: 'Gisela', familyName: 'Koch' },
      { id: 'b', firstName: 'Gisela', familyName: 'Koch' },
    ];
    expect(findPersonByName(twins, 'Gisela Koch')).toEqual({
      error: 'ambiguous',
      candidates: twins,
    });
  });

  it('misses a misspelled name instead of guessing', () => {
    expect(findPersonByName(kochs, 'Leonard Koch')).toEqual({ error: 'missing' });
  });

  it('matches a first name as prefix of the stored name', () => {
    const people = [{ id: 'ava', firstName: 'Ava Naoko' }];
    expect(findPersonByName(people, 'Ava')).toEqual({ person: people[0] });
  });

  it('matches a stored name plus an appended extra', () => {
    const people = [{ id: 'ava', firstName: 'Ava Naoko' }];
    expect(findPersonByName(people, 'Ava Naoko Ortlepp')).toEqual({ person: people[0] });
  });

  it('prefers the surname-qualified match over loose prefix matches', () => {
    // "Gisela Koch" must not stay ambiguous just because another Gisela exists whom
    // the loose "stored name plus extras" rule would also collect.
    const people = [
      { id: 'k', firstName: 'Gisela', familyName: 'Koch' },
      { id: 's', firstName: 'Gisela', familyName: null },
    ];
    expect(findPersonByName(people, 'Gisela Koch')).toEqual({ person: people[0] });
  });

  it('is case- and whitespace-insensitive', () => {
    expect(findPersonByName(kochs, '  gisela   KOCH ')).toEqual({ person: kochs[0] });
  });

  it('misses an empty name', () => {
    expect(findPersonByName(kochs, '   ')).toEqual({ error: 'missing' });
  });
});

describe('matchPeopleByName', () => {
  it('dedupes matches and keeps failures by given name', () => {
    const { matched, unmatched } = matchPeopleByName(kochs, [
      'Gisela Koch',
      'gisela koch',
      'Gisela',
      'Leonard Koch',
    ]);
    expect(matched).toEqual([kochs[0]]);
    expect(unmatched).toEqual(['Gisela', 'Leonard Koch']);
  });
});
