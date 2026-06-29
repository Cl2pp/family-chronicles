import { redirect } from 'next/navigation';
import { Button, Center, Container, Paper, Stack, Text, Title } from '@mantine/core';
import { getSession } from '@/lib/session';
import { acceptInvitation } from '@/lib/invitations';

const MESSAGES: Record<string, string> = {
  not_found: 'This invitation link is not valid.',
  expired: 'This invitation has expired. Ask the family to send a new one.',
  used: 'This invitation has already been used.',
};

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
  if (result.ok) {
    redirect(`/family?family=${result.familyId}`);
  }

  return (
    <Center mih="100dvh">
      <Container size={420} w="100%" py="xl">
        <Paper withBorder p="xl" radius="md">
          <Stack>
            <Title order={3}>Invitation</Title>
            <Text c="dimmed">{MESSAGES[result.reason]}</Text>
            <Button component="a" href="/family">
              Go to your families
            </Button>
          </Stack>
        </Paper>
      </Container>
    </Center>
  );
}
