import type { AccessRole } from '@/lib/permissions';

export interface AddTarget {
  personId: string;
  personName: string;
  relation: 'parent' | 'child' | 'partner';
}

export interface FamilyRow {
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
}

export interface InviteRow {
  id: string;
  email: string;
  role: AccessRole;
  token: string;
}

export interface PersonRow {
  id: string;
  displayName: string;
  familyName: string | null;
  userId: string | null;
  bornOn: Date | string | null;
  diedOn: Date | string | null;
}
