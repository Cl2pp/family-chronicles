import type { AccessRole } from '@/lib/permissions';
import type { Gender, PersonRelation } from '@/lib/people';
import type { Dictionary } from '@/lib/i18n';

/** Localized options for the person gender selects. */
export function genderOptions(t: Dictionary): { value: Gender; label: string }[] {
  return [
    { value: 'male', label: t.person.male },
    { value: 'female', label: t.person.female },
  ];
}

export interface AddTarget {
  personId: string;
  personName: string;
  relation: PersonRelation;
}

export interface ChronicleRow {
  id: string;
  name: string;
  description: string | null;
  role: AccessRole;
}

export interface MemberRow {
  userId: string;
  name: string;
  email: string;
  role: AccessRole;
  /** The tree person this account is linked to (people.user_id), if any. */
  personId: string | null;
  personName: string | null;
}

export interface InviteRow {
  id: string;
  email: string;
  role: AccessRole;
  token: string;
  /** The tree person the invitee will be linked to on accept, if chosen. */
  personName: string | null;
}

export interface PersonRow {
  id: string;
  displayName: string;
  familyName: string | null;
  birthFamilyName: string | null;
  userId: string | null;
  gender: Gender | null;
  bornOn: Date | string | null;
  bornPrecision: string | null;
  diedOn: Date | string | null;
  diedPrecision: string | null;
}
