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
  linkUserToPerson,
  removeRelationship,
  unlinkUserPerson,
  updatePerson,
  type Gender,
  type PersonRelation,
} from '@/lib/people';
import { createInvitation } from '@/lib/invitations';
import type { AccessRole } from '@/lib/permissions';
import { partsToEventDate, type EventDateParts } from '@/lib/dates';

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
  firstName: string;
  familyName?: string;
  birthFamilyName?: string;
  gender?: Gender | null;
  born?: EventDateParts;
  died?: EventDateParts;
  connectTo?: { personId: string; relation: PersonRelation };
}

/** Add a person to a chronicle's tree, optionally wiring a kinship edge. */
export async function addPersonAction(input: AddPersonInput) {
  const user = await requireUser();
  await requireContributor(input.chronicleId, user.id);

  const firstName = input.firstName.trim();
  if (!firstName) {
    throw new Error('A first name is required.');
  }

  const born = partsToEventDate(input.born ?? {});
  const died = partsToEventDate(input.died ?? {});

  const person = await createPerson({
    firstName,
    familyName: input.familyName?.trim() || null,
    birthFamilyName: input.birthFamilyName?.trim() || null,
    gender: input.gender ?? null,
    bornOn: born.eventDate,
    bornPrecision: born.eventDatePrecision,
    diedOn: died.eventDate,
    diedPrecision: died.eventDatePrecision,
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
  firstName: string;
  familyName?: string | null;
  birthFamilyName?: string | null;
  gender?: Gender | null;
  born?: EventDateParts;
  died?: EventDateParts;
}) {
  const user = await requireUser();
  await requireContributor(input.chronicleId, user.id);

  const firstName = input.firstName.trim();
  if (!firstName) throw new Error('A first name is required.');
  if (!(await isPersonInChronicle(input.chronicleId, input.personId))) {
    throw new Error('That person is not in this chronicle.');
  }

  const born = partsToEventDate(input.born ?? {});
  const died = partsToEventDate(input.died ?? {});

  await updatePerson(input.personId, {
    firstName,
    familyName: input.familyName?.trim() || null,
    birthFamilyName: input.birthFamilyName?.trim() || null,
    gender: input.gender ?? null,
    bornOn: born.eventDate,
    bornPrecision: born.eventDatePrecision,
    diedOn: died.eventDate,
    diedPrecision: died.eventDatePrecision,
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
  /** The tree person the invitee is — accepting links their account to it. */
  personId?: string | null;
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
    personId: input.personId ?? null,
  });

  revalidatePath('/chronicle');
  return { token: created.token };
}

/** Link a member's account to an unlinked tree person. Owner only. */
export async function linkMemberPersonAction(input: {
  chronicleId: string;
  userId: string;
  personId: string;
}) {
  const user = await requireUser();
  await requireOwner(input.chronicleId, user.id);

  await linkUserToPerson(input.chronicleId, input.userId, input.personId);
  revalidatePath('/chronicle');
}

/** Unlink a member's account from its tree person. Owner only. */
export async function unlinkMemberPersonAction(input: {
  chronicleId: string;
  userId: string;
}) {
  const user = await requireUser();
  await requireOwner(input.chronicleId, user.id);

  await unlinkUserPerson(input.chronicleId, input.userId);
  revalidatePath('/chronicle');
}
