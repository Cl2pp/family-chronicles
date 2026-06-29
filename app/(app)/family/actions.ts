'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/session';
import { createFamily, requireContributor, requireOwner, updateFamily } from '@/lib/families';
import { addPersonToFamily, connectPeople, createPerson } from '@/lib/people';
import { createInvitation } from '@/lib/invitations';
import type { AccessRole } from '@/lib/permissions';

/** Build a Jan-1 UTC date from a 4-digit year (precision 'year'). */
function yearToDate(year: number): Date {
  return new Date(Date.UTC(year, 0, 1));
}

function parseYear(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 9999) return undefined;
  return n;
}

/** Create a family, make it active, and go to the family screen. */
export async function createFamilyAction(formData: FormData) {
  const user = await requireUser();
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();
  if (!name) {
    throw new Error('A family name is required.');
  }

  const family = await createFamily({
    name,
    description: description || null,
    userId: user.id,
    userName: user.name,
  });

  const cookieStore = await cookies();
  cookieStore.set('activeFamilyId', family.id, { path: '/' });

  revalidatePath('/family');
  redirect('/family');
}

export interface AddPersonInput {
  familyId: string;
  displayName: string;
  familyName?: string;
  bornYear?: number;
  diedYear?: number;
  connectTo?: { personId: string; relation: 'parent' | 'child' | 'partner' };
}

/** Add a person to a family's tree, optionally wiring a kinship edge. */
export async function addPersonAction(input: AddPersonInput) {
  const user = await requireUser();
  await requireContributor(input.familyId, user.id);

  const displayName = input.displayName.trim();
  if (!displayName) {
    throw new Error('A name is required.');
  }

  const bornYear = parseYear(input.bornYear);
  const diedYear = parseYear(input.diedYear);

  const person = await createPerson({
    displayName,
    familyName: input.familyName?.trim() || null,
    bornOn: bornYear !== undefined ? yearToDate(bornYear) : null,
    bornPrecision: bornYear !== undefined ? 'year' : null,
    diedOn: diedYear !== undefined ? yearToDate(diedYear) : null,
    diedPrecision: diedYear !== undefined ? 'year' : null,
    createdBy: user.id,
    familyId: input.familyId,
  });

  // Make sure the person is in the family tree (createPerson already does this,
  // but stay defensive in case familyId handling changes).
  await addPersonToFamily(input.familyId, person.id);

  if (input.connectTo) {
    const { personId: target, relation } = input.connectTo;
    if (relation === 'parent') {
      // New person is the PARENT of the target.
      await connectPeople({
        type: 'parent',
        personFromId: person.id,
        personToId: target,
        createdBy: user.id,
      });
    } else if (relation === 'child') {
      // New person is the CHILD of the target.
      await connectPeople({
        type: 'parent',
        personFromId: target,
        personToId: person.id,
        createdBy: user.id,
      });
    } else {
      await connectPeople({
        type: 'spouse',
        personFromId: person.id,
        personToId: target,
        createdBy: user.id,
      });
    }
  }

  revalidatePath('/family');
  return { id: person.id };
}

/** Create an invitation and return its shareable token. */
export async function invite(input: {
  familyId: string;
  email: string;
  role: AccessRole;
}) {
  const user = await requireUser();
  await requireOwner(input.familyId, user.id);

  const email = input.email.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    throw new Error('Enter a valid email address.');
  }

  const created = await createInvitation({
    familyId: input.familyId,
    email,
    role: input.role,
    invitedBy: user.id,
  });

  revalidatePath('/family');
  return { token: created.token };
}

/** Update a family's name, description, and writing-style guide. */
export async function saveSettings(input: {
  familyId: string;
  name: string;
  description: string;
  styleGuide: string;
}) {
  const user = await requireUser();
  await requireOwner(input.familyId, user.id);

  const name = input.name.trim();
  if (!name) {
    throw new Error('A family name is required.');
  }

  await updateFamily(input.familyId, {
    name,
    description: input.description.trim() || null,
    styleGuide: input.styleGuide.trim() || null,
  });

  revalidatePath('/family');
}
