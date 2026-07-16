import { redirect } from 'next/navigation';
import { Button, Center, Container, Paper, Stack, Text, Title } from '@mantine/core';
import { getSession } from '@/lib/session';
import { getInvitationByToken } from '@/lib/invitations';
import { getI18n } from '@/lib/i18n/server';
import { acceptInviteAction } from './actions';

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ outcome?: string }>;
}) {
  const { token } = await params;
  const { outcome } = await searchParams;
  const session = await getSession();

  if (!session?.user) {
    redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
  }

  const { t } = await getI18n();

  // Post-accept result panels (the accept action redirects here).
  if (outcome === 'linked' || outcome === 'link-failed') {
    return (
      <InviteCard title={t.invite.acceptedTitle}>
        <Text c="dimmed">
          {outcome === 'linked' ? t.invite.acceptedLinkedText : t.invite.acceptedLinkFailedText}
        </Text>
        <Button component="a" href="/chronicle">
          {t.invite.goToChronicles}
        </Button>
      </InviteCard>
    );
  }

  // Read-only preview — the token is only redeemed by the explicit button below.
  const invite = await getInvitationByToken(token);

  if (invite.status !== 'ok') {
    const messages: Record<string, string> = {
      not_found: t.invite.notFound,
      expired: t.invite.expired,
      used: t.invite.used,
    };
    return (
      <InviteCard title={t.invite.title}>
        <Text c="dimmed">{messages[invite.status]}</Text>
        <Button component="a" href="/chronicle">
          {t.invite.goToChronicles}
        </Button>
      </InviteCard>
    );
  }

  return (
    <InviteCard title={t.invite.title}>
      <Text>{t.invite.confirmText(invite.chronicleName)}</Text>
      {invite.personName ? (
        <Text c="dimmed">{t.invite.confirmPerson(invite.personName)}</Text>
      ) : null}
      <form action={acceptInviteAction.bind(null, token)}>
        <Button type="submit" fullWidth>
          {t.invite.confirmAccept}
        </Button>
      </form>
    </InviteCard>
  );
}

function InviteCard({ title, children }: { title: string; children: React.ReactNode }) {
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
