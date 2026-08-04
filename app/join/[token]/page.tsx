import { redirect } from 'next/navigation';
import { Button, Center, Container, Paper, Stack, Text, Title } from '@mantine/core';
import { getSession } from '@/lib/session';
import { getMembership } from '@/lib/chronicles';
import { getJoinLinkByToken } from '@/lib/join-links';
import { getI18n } from '@/lib/i18n/server';
import { requestJoinAction } from './actions';

export default async function JoinPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ outcome?: string }>;
}) {
  const { token } = await params;
  const { outcome } = await searchParams;
  const session = await getSession();

  // Signing up is the whole point of this link, so it leads there rather than to
  // login — the signup page cross-links to login with `next` intact for anyone
  // who turns out to have an account already.
  if (!session?.user) {
    redirect(`/signup?next=${encodeURIComponent(`/join/${token}`)}`);
  }

  const { t } = await getI18n();

  // Read-only preview — the request is only made by the explicit button below.
  // Resolved before anything else, including the post-request panel: a revoked
  // link is a dead link, and telling someone their request is on its way when
  // the link no longer exists would be a lie they cannot act on.
  const link = await getJoinLinkByToken(token);

  if (link.status !== 'ok') {
    return (
      <JoinCard title={t.join.title}>
        <Text c="dimmed">{t.join.notFound}</Text>
        <Button component="a" href="/chronicle">
          {t.join.goToChronicles}
        </Button>
      </JoinCard>
    );
  }

  // Nothing to redeem if they are already in — otherwise the form would offer
  // them a join that quietly does nothing.
  if (await getMembership(link.chronicleId, session.user.id)) {
    return (
      <JoinCard title={t.join.alreadyMemberTitle}>
        <Text c="dimmed">{t.join.alreadyMemberText(link.chronicleName)}</Text>
        <Button component="a" href="/chronicle">
          {t.join.goToChronicles}
        </Button>
      </JoinCard>
    );
  }

  // Post-request panel (the request action redirects here).
  if (outcome === 'pending') {
    return (
      <JoinCard title={t.join.pendingTitle}>
        <Text c="dimmed">{t.join.pendingText}</Text>
        <Button component="a" href="/chronicle">
          {t.join.goToChronicles}
        </Button>
      </JoinCard>
    );
  }

  // Two links, two promises: one gets you in, the other gets you in the queue.
  // Say which before the button, so nobody clicks expecting the other one.
  return (
    <JoinCard title={t.join.title}>
      <Text>
        {link.requiresApproval
          ? t.join.confirmText(link.chronicleName)
          : t.join.confirmTextOpen(link.chronicleName)}
      </Text>
      <Text c="dimmed">
        {link.requiresApproval ? t.join.confirmApprovalText : t.join.confirmOpenText}
      </Text>
      <form action={requestJoinAction.bind(null, token)}>
        <Button type="submit" fullWidth>
          {link.requiresApproval ? t.join.confirmRequest : t.join.confirmJoin}
        </Button>
      </form>
    </JoinCard>
  );
}

function JoinCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Center mih="100dvh">
      <Container size={420} w="100%" py="xl">
        <Paper withBorder p="xl" radius="md">
          <Stack>
            <Title order={3}>{title}</Title>
            {children}
          </Stack>
        </Paper>
      </Container>
    </Center>
  );
}
