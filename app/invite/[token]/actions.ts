'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { acceptInvitation } from '@/lib/invitations';
import { captureServerEvent } from '@/lib/posthog-server';

/** Explicit accept from the confirmation screen — the only place a token is redeemed. */
export async function acceptInviteAction(token: string) {
  const session = await getSession();
  if (!session?.user) {
    redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
  }

  const result = await acceptInvitation(token, session.user.id);
  // Failures re-render the invite page, which re-reads the state (used/expired).
  if (!result.ok) redirect(`/invite/${token}`);

  // Make it the active one, or a user who already had chronicles would land in
  // whichever chat they were last in and wonder where the new one went.
  const cookieStore = await cookies();
  cookieStore.set('activeChronicleId', result.chronicleId, { path: '/' });

  captureServerEvent(session.user.id, 'invite_accepted');

  if (result.personLinked) redirect(`/invite/${token}?outcome=linked`);
  if (result.personLinkFailed) redirect(`/invite/${token}?outcome=link-failed`);
  redirect('/chat');
}
