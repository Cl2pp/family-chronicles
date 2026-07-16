import { redirect } from 'next/navigation';
import { Button, Center, Container, Paper, Stack, Text, Title } from '@mantine/core';
import { getSession } from '@/lib/session';
import { acceptInvitation } from '@/lib/invitations';
import { getI18n } from '@/lib/i18n/server';

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const session = await getSession();

  if (!session?.user) {
    redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
  }

  const result = await acceptInvitation(token, session.user.id);
  if (result.ok && !result.personLinked && !result.personLinkFailed) {
    redirect(`/chronicle`);
  }

  const { t } = await getI18n();
  const messages: Record<string, string> = {
    not_found: t.invite.notFound,
    expired: t.invite.expired,
    used: t.invite.used,
  };

  return (
    <Center mih="100dvh">
      <Container size={420} w="100%" py="xl">
        <Paper withBorder p="xl" radius="md">
          <Stack>
            <Title order={3}>{result.ok ? t.invite.acceptedTitle : t.invite.title}</Title>
            <Text c="dimmed">
              {result.ok
                ? result.personLinked
                  ? t.invite.acceptedLinkedText
                  : t.invite.acceptedLinkFailedText
                : messages[result.reason]}
            </Text>
            <Button component="a" href="/chronicle">
              {t.invite.goToChronicles}
            </Button>
          </Stack>
        </Paper>
      </Container>
    </Center>
  );
}
