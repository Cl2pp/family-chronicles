'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { requestJoin } from '@/lib/join-links';
import { captureServerEvent } from '@/lib/posthog-server';

/** Explicit redeem from the confirmation screen — the only place the link writes. */
export async function requestJoinAction(token: string) {
  const session = await getSession();
  if (!session?.user) {
    redirect(`/signup?next=${encodeURIComponent(`/join/${token}`)}`);
  }

  const result = await requestJoin(token, session.user.id);
  // Already a member: nothing to redeem, so skip straight past the queue —
  // with this chronicle active, since this link is what they came here for.
  if (result.status === 'already_member') {
    const cookieStore = await cookies();
    cookieStore.set('activeChronicleId', result.chronicleId, { path: '/' });
    redirect('/chat');
  }
  // Revoked meanwhile — re-render the join page, which re-reads the link and
  // shows the "not valid" panel.
  if (result.status === 'not_found') redirect(`/join/${token}`);

  // An open link puts them in there and then; nothing to wait for, so no panel.
  if (result.status === 'joined') {
    // Make it the active one, or a user who already had chronicles would land
    // on whichever they were last in and wonder where the new one went.
    const cookieStore = await cookies();
    cookieStore.set('activeChronicleId', result.chronicleId, { path: '/' });

    captureServerEvent(session.user.id, 'join_link_joined');
    redirect('/chat');
  }

  captureServerEvent(session.user.id, 'join_requested');
  redirect(`/join/${token}?outcome=pending`);
}
