'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/session';
import { createChronicle, requireContributor, requireOwner } from '@/lib/chronicles';
import {
  addPersonToChronicle,
  canUserEditPerson,
  connectPeople,
  createPerson,
  deletePerson,
  edgeForRelation,
  getPerson,
  isPersonInChronicle,
  removeRelationship,
  updatePerson,
  type Gender,
  type PersonRelation,
} from '@/lib/people';
import { createInvitation } from '@/lib/invitations';
import type { AccessRole } from '@/lib/permissions';
import { parseYear, yearToDate } from '@/lib/dates';

/** Create a chronicle, make it active, and go to the chronicle screen. */
export async function createChronicleAction(formData: FormData) {
  const user = await requireUser();
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();
  if (!name) {
    throw new Error('A chronicle name is required.');
  }

  const chronicle = await createChronicle({
    name,
    description: description || null,
    userId: user.id,
    userName: user.name,
  });

  const cookieStore = await cookies();
  cookieStore.set('activeChronicleId', chronicle.id, { path: '/' });

  revalidatePath('/chronicle');
  redirect('/chronicle');
}

export interface AddPersonInput {
  chronicleId: string;
  displayName: string;
  familyName?: string;
  birthFamilyName?: string;
  gender?: Gender | null;
  bornYear?: number;
  diedYear?: number;
  connectTo?: { personId: string; relation: PersonRelation };
}

/** Add a person to a chronicle's tree, optionally wiring a kinship edge. */
export async function addPersonAction(input: AddPersonInput) {
  const user = await requireUser();
  await requireContributor(input.chronicleId, user.id);

  const displayName = input.displayName.trim();
  if (!displayName) {
    throw new Error('A name is required.');
  }

  const bornYear = parseYear(input.bornYear);
  const diedYear = parseYear(input.diedYear);

  const person = await createPerson({
    displayName,
    familyName: input.familyName?.trim() || null,
    birthFamilyName: input.birthFamilyName?.trim() || null,
    gender: input.gender ?? null,
    bornOn: bornYear !== undefined ? yearToDate(bornYear) : null,
    bornPrecision: bornYear !== undefined ? 'year' : null,
    diedOn: diedYear !== undefined ? yearToDate(diedYear) : null,
    diedPrecision: diedYear !== undefined ? 'year' : null,
    createdBy: user.id,
    chronicleId: input.chronicleId,
  });

  // Make sure the person is in the family tree (createPerson already does this,
  // but stay defensive in case chronicleId handling changes).
  await addPersonToChronicle(input.chronicleId, person.id);

  if (input.connectTo) {
    const { personId: target, relation } = input.connectTo;
    await connectPeople({
      ...edgeForRelation(relation, person.id, target),
      createdBy: user.id,
    });
  }

  revalidatePath('/chronicle');
  return { id: person.id };
}

/** Edit a person's details in this chronicle's tree. Contributor+. */
export async function editPersonAction(input: {
  chronicleId: string;
  personId: string;
  displayName: string;
  familyName?: string | null;
  birthFamilyName?: string | null;
  gender?: Gender | null;
  bornYear?: number | null;
  diedYear?: number | null;
}) {
  const user = await requireUser();
  await requireContributor(input.chronicleId, user.id);

  const displayName = input.displayName.trim();
  if (!displayName) throw new Error('A name is required.');
  if (!(await isPersonInChronicle(input.chronicleId, input.personId))) {
    throw new Error('That person is not in this chronicle.');
  }

  const bornYear = parseYear(input.bornYear ?? undefined);
  const diedYear = parseYear(input.diedYear ?? undefined);

  await updatePerson(input.personId, {
    displayName,
    familyName: input.familyName?.trim() || null,
    birthFamilyName: input.birthFamilyName?.trim() || null,
    gender: input.gender ?? null,
    bornOn: bornYear !== undefined ? yearToDate(bornYear) : null,
    bornPrecision: bornYear !== undefined ? 'year' : null,
    diedOn: diedYear !== undefined ? yearToDate(diedYear) : null,
    diedPrecision: diedYear !== undefined ? 'year' : null,
  });

  revalidatePath('/chronicle');
}

/** Remove a single kinship edge between two people the user may edit. Contributor+. */
export async function removeRelationshipAction(input: {
  type: 'parent' | 'spouse';
  personFromId: string;
  personToId: string;
}) {
  const user = await requireUser();

  // The tree is merged across chronicles, so authorize per person: the user must be
  // able to contribute to a chronicle containing each endpoint.
  const [canFrom, canTo] = await Promise.all([
    canUserEditPerson(user.id, input.personFromId),
    canUserEditPerson(user.id, input.personToId),
  ]);
  if (!canFrom || !canTo) {
    throw new Error('You do not have permission to change this connection.');
  }

  await removeRelationship(input);
  revalidatePath('/chronicle');
}

/** Connect two people who are already in this chronicle's tree. Contributor+. */
export async function relatePeopleAction(input: {
  chronicleId: string;
  personId: string;
  relativeId: string;
  relation: PersonRelation;
}) {
  const user = await requireUser();
  await requireContributor(input.chronicleId, user.id);

  if (input.personId === input.relativeId) {
    throw new Error('A person cannot be related to themselves.');
  }
  const [personIn, relativeIn] = await Promise.all([
    isPersonInChronicle(input.chronicleId, input.personId),
    isPersonInChronicle(input.chronicleId, input.relativeId),
  ]);
  if (!personIn || !relativeIn) {
    throw new Error('Both people must be in this chronicle.');
  }

  await connectPeople({
    ...edgeForRelation(input.relation, input.personId, input.relativeId),
    createdBy: user.id,
  });
  revalidatePath('/chronicle');
}

/** Delete a person from this chronicle's tree (and their relationships). Contributor+. */
export async function deletePersonAction(input: { chronicleId: string; personId: string }) {
  const user = await requireUser();
  await requireContributor(input.chronicleId, user.id);

  const person = await getPerson(input.personId);
  if (!person) {
    revalidatePath('/chronicle');
    return;
  }
  if (person.userId) {
    throw new Error('This person is linked to an account and cannot be deleted here.');
  }
  if (!(await isPersonInChronicle(input.chronicleId, input.personId))) {
    throw new Error('That person is not in this chronicle.');
  }

  await deletePerson(input.personId);
  revalidatePath('/chronicle');
}

/** Create an invitation and return its shareable token. */
export async function invite(input: {
  chronicleId: string;
  email: string;
  role: AccessRole;
}) {
  const user = await requireUser();
  await requireOwner(input.chronicleId, user.id);

  const email = input.email.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    throw new Error('Enter a valid email address.');
  }

  const created = await createInvitation({
    chronicleId: input.chronicleId,
    email,
    role: input.role,
    invitedBy: user.id,
  });

  revalidatePath('/chronicle');
  return { token: created.token };
}
