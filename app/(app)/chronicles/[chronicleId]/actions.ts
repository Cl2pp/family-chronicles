'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/session';
import { getMembership, canEdit, updateStyleGuide } from '@/lib/chronicles';
import { createInvitation } from '@/lib/invitations';
import { env } from '@/lib/env';

/** Throw unless the user is an owner/editor of the chronicle. */
async function requireEditor(chronicleId: string, userId: string) {
  const membership = await getMembership(chronicleId, userId);
  if (!membership || !canEdit(membership.role)) {
    throw new Error('You do not have permission to do that.');
  }
  return membership;
}

const inviteSchema = z.object({
  chronicleId: z.string().uuid(),
  email: z.string().email(),
  role: z.enum(['editor', 'viewer']),
});

export async function inviteMemberAction(input: {
  chronicleId: string;
  email: string;
  role: 'editor' | 'viewer';
}): Promise<{ url: string }> {
  const user = await requireUser();
  const { chronicleId, email, role } = inviteSchema.parse(input);
  await requireEditor(chronicleId, user.id);

  const invite = await createInvitation({ chronicleId, email, role, invitedBy: user.id });
  revalidatePath(`/chronicles/${chronicleId}`);

  return { url: `${env.BETTER_AUTH_URL}/invite/${invite.token}` };
}

const styleSchema = z.object({
  chronicleId: z.string().uuid(),
  styleGuide: z.string().max(5000),
});

export async function updateStyleGuideAction(input: {
  chronicleId: string;
  styleGuide: string;
}): Promise<void> {
  const user = await requireUser();
  const { chronicleId, styleGuide } = styleSchema.parse(input);
  await requireEditor(chronicleId, user.id);

  await updateStyleGuide(chronicleId, styleGuide.trim());
  revalidatePath(`/chronicles/${chronicleId}`);
}
