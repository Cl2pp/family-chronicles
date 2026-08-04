'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/session';
import { createChronicle, requireContributor, requireOwner } from '@/lib/chronicles';
import {
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
import { createInvitation, refreshInvitationLink, revokeInvitation } from '@/lib/invitations';
import {
  approveJoinRequest,
  createJoinLink,
  declineJoinRequest,
  revokeJoinLink,
} from '@/lib/join-links';
import type { AccessRole } from '@/lib/permissions';
import { partsToEventDate, type EventDateParts } from '@/lib/dates';
import { captureServerEvent } from '@/lib/posthog-server';

/** Create a chronicle, make it active, and go to the chat. */
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
  captureServerEvent(user.id, 'chronicle_created', { chronicle_id: chronicle.id });
  redirect('/chat');
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

/** Remove a single kinship edge between two people in the same chronicle. Contributor+. */
export async function removeRelationshipAction(input: {
  type: 'parent' | 'spouse';
  personFromId: string;
  personToId: string;
}) {
  const user = await requireUser();

  // A kinship edge never spans two chronicles (connectPeople's invariant), so
  // checking either endpoint is enough to authorize removing it.
  if (!(await canUserEditPerson(user.id, input.personFromId))) {
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
  captureServerEvent(user.id, 'member_invited', {
    chronicle_id: input.chronicleId,
    role: input.role,
  });
  return { token: created.token };
}

/** Withdraw an outstanding invitation. Owner only. */
export async function revokeInviteAction(input: { chronicleId: string; invitationId: string }) {
  const user = await requireUser();
  await requireOwner(input.chronicleId, user.id);

  const revoked = await revokeInvitation(input.chronicleId, input.invitationId);
  if (!revoked) {
    // Revalidate before bailing: nothing matched because the invite was
    // accepted (or revoked elsewhere) since this page rendered, so the row the
    // owner just clicked is stale — without this it sits there erroring on
    // every retry until a manual reload.
    revalidatePath('/chronicle');
    throw new Error('That invitation is no longer pending — it may have been accepted already.');
  }

  revalidatePath('/chronicle');
  captureServerEvent(user.id, 'invitation_revoked', { chronicle_id: input.chronicleId });
}

/**
 * Look a pending invitation's link back up (and extend its expiry) so an owner
 * can send it again. Owner only — the token is a bearer credential, which is
 * why `listPendingInvitations` never ships it to the page.
 */
export async function resendInviteAction(input: { chronicleId: string; invitationId: string }) {
  const user = await requireUser();
  await requireOwner(input.chronicleId, user.id);

  const refreshed = await refreshInvitationLink(input.chronicleId, input.invitationId);
  if (!refreshed) {
    // Same staleness case as revoking — drop the row the owner clicked.
    revalidatePath('/chronicle');
    throw new Error('That invitation is no longer pending — it may have been accepted already.');
  }

  revalidatePath('/chronicle');
  captureServerEvent(user.id, 'invitation_link_resent', { chronicle_id: input.chronicleId });
  return { token: refreshed.token };
}

/**
 * Create (or re-read) the chronicle's signup link and return its token. Owner
 * only. The mode is fixed at creation — `createJoinLink` never rewrites an
 * existing link's settings, so switching means revoking first.
 */
export async function createJoinLinkAction(input: {
  chronicleId: string;
  requiresApproval: boolean;
  /** Role a direct join grants; ignored when the link requires approval. */
  role: AccessRole;
}) {
  const user = await requireUser();
  await requireOwner(input.chronicleId, user.id);

  // An open link is a standing grant to whoever it gets forwarded to, so it can
  // never hand out ownership — that would let a stranger delete the chronicle.
  // Making someone an owner stays a deliberate, per-person act (approve a
  // request, or invite them by email).
  if (!input.requiresApproval && input.role === 'owner') {
    throw new Error('A link that lets people in straight away cannot grant ownership.');
  }

  const { link, created } = await createJoinLink(input.chronicleId, user.id, {
    requiresApproval: input.requiresApproval,
    role: input.role,
  });

  revalidatePath('/chronicle');
  captureServerEvent(user.id, 'join_link_created', {
    chronicle_id: input.chronicleId,
    requires_approval: input.requiresApproval,
  });
  return { token: link.token, created };
}

/** Kill the chronicle's signup link. Pending requests stay. Owner only. */
export async function revokeJoinLinkAction(input: { chronicleId: string }) {
  const user = await requireUser();
  await requireOwner(input.chronicleId, user.id);

  await revokeJoinLink(input.chronicleId);

  revalidatePath('/chronicle');
  captureServerEvent(user.id, 'join_link_revoked', { chronicle_id: input.chronicleId });
}

/** Let a pending request in, at the chosen role. Owner only. */
export async function approveJoinRequestAction(input: {
  chronicleId: string;
  requestId: string;
  role: AccessRole;
}) {
  const user = await requireUser();
  await requireOwner(input.chronicleId, user.id);

  const result = await approveJoinRequest(input.chronicleId, input.requestId, input.role);
  if (result === 'stale') {
    // Same staleness case as revoking an invite: nothing matched because
    // another owner decided this request since the page rendered, so drop the
    // row the owner just clicked instead of erroring on it forever.
    revalidatePath('/chronicle');
    throw new Error('That request is no longer pending — it may have been decided already.');
  }
  if (result === 'already_member') {
    revalidatePath('/chronicle');
    throw new Error(
      'That person is already a member of this chronicle — the request was cleared and their role left unchanged.',
    );
  }

  revalidatePath('/chronicle');
  captureServerEvent(user.id, 'join_request_approved', {
    chronicle_id: input.chronicleId,
    role: input.role,
  });
}

/** Turn a pending request down. Owner only. */
export async function declineJoinRequestAction(input: { chronicleId: string; requestId: string }) {
  const user = await requireUser();
  await requireOwner(input.chronicleId, user.id);

  const declined = await declineJoinRequest(input.chronicleId, input.requestId);
  if (!declined) {
    revalidatePath('/chronicle');
    throw new Error('That request is no longer pending — it may have been decided already.');
  }

  revalidatePath('/chronicle');
  captureServerEvent(user.id, 'join_request_declined', { chronicle_id: input.chronicleId });
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
