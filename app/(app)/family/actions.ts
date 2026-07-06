'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/session';
import { createFamily, requireContributor, requireOwner, updateFamily } from '@/lib/families';
import {
  addPersonToFamily,
  connectPeople,
  createPerson,
  deletePerson,
  getPerson,
  isPersonInFamily,
  updatePerson,
} from '@/lib/people';
import { createInvitation } from '@/lib/invitations';
import type { AccessRole } from '@/lib/permissions';
import { parseYear, yearToDate } from '@/lib/dates';

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

/** Edit a person's details in this family's tree. Contributor+. */
export async function editPersonAction(input: {
  familyId: string;
  personId: string;
  displayName: string;
  familyName?: string | null;
  bornYear?: number | null;
  diedYear?: number | null;
}) {
  const user = await requireUser();
  await requireContributor(input.familyId, user.id);

  const displayName = input.displayName.trim();
  if (!displayName) throw new Error('A name is required.');
  if (!(await isPersonInFamily(input.familyId, input.personId))) {
    throw new Error('That person is not in this family.');
  }

  const bornYear = parseYear(input.bornYear ?? undefined);
  const diedYear = parseYear(input.diedYear ?? undefined);

  await updatePerson(input.personId, {
    displayName,
    familyName: input.familyName?.trim() || null,
    bornOn: bornYear !== undefined ? yearToDate(bornYear) : null,
    bornPrecision: bornYear !== undefined ? 'year' : null,
    diedOn: diedYear !== undefined ? yearToDate(diedYear) : null,
    diedPrecision: diedYear !== undefined ? 'year' : null,
  });

  revalidatePath('/family');
}

/** Delete a person from this family's tree (and their relationships). Contributor+. */
export async function deletePersonAction(input: { familyId: string; personId: string }) {
  const user = await requireUser();
  await requireContributor(input.familyId, user.id);

  const person = await getPerson(input.personId);
  if (!person) {
    revalidatePath('/family');
    return;
  }
  if (person.userId) {
    throw new Error('This person is linked to an account and cannot be deleted here.');
  }
  if (!(await isPersonInFamily(input.familyId, input.personId))) {
    throw new Error('That person is not in this family.');
  }

  await deletePerson(input.personId);
  revalidatePath('/family');
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
