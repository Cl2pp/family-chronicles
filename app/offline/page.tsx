import type { Metadata } from 'next';
import { Center, Container, Paper, Stack, Text, Title } from '@mantine/core';
import { getI18n } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Offline · Family Chronicle' };

export default async function OfflinePage() {
  const { t } = await getI18n();
  return (
    <Center mih="100dvh">
      <Container size={420} w="100%" py="xl">
        <Paper withBorder p="xl" radius="md">
          <Stack gap="sm">
            <Title order={3}>{t.offline.title}</Title>
            <Text c="dimmed">{t.offline.text}</Text>
          </Stack>
        </Paper>
      </Container>
    </Center>
  );
}
