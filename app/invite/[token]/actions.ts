'use server';

import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { acceptInvitation } from '@/lib/invitations';
import { getPostHogClient } from '@/lib/posthog-server';

/** Explicit accept from the confirmation screen — the only place a token is redeemed. */
export async function acceptInviteAction(token: string) {
  const session = await getSession();
  if (!session?.user) {
    redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
  }

  const result = await acceptInvitation(token, session.user.id);
  // Failures re-render the invite page, which re-reads the state (used/expired).
  if (!result.ok) redirect(`/invite/${token}`);

  const posthog = getPostHogClient();
  posthog.capture({ distinctId: session.user.id, event: 'invite_accepted' });
  await posthog.flush();

  if (result.personLinked) redirect(`/invite/${token}?outcome=linked`);
  if (result.personLinkFailed) redirect(`/invite/${token}?outcome=link-failed`);
  redirect('/chronicle');
}
