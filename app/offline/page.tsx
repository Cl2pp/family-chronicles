import type { Metadata } from 'next';
import { Center, Container, Paper, Stack, Text, Title } from '@mantine/core';

export const metadata: Metadata = { title: 'Offline · Family Chronicle' };

export default function OfflinePage() {
  return (
    <Center mih="100dvh">
      <Container size={420} w="100%" py="xl">
        <Paper withBorder p="xl" radius="md">
          <Stack gap="sm">
            <Title order={3}>You&rsquo;re offline</Title>
            <Text c="dimmed">
              Family Chronicle needs a connection for this page. Check your network and try again —
              your stories are safe and will be here when you&rsquo;re back.
            </Text>
          </Stack>
        </Paper>
      </Container>
    </Center>
  );
}
