import { redirect } from 'next/navigation';
import { Container, Title, Text, Button, Group, Stack, Paper } from '@mantine/core';
import { getI18n } from '@/lib/i18n/server';
import { getSession } from '@/lib/session';

export default async function Home() {
  // The PWA's start_url is "/" — a signed-in user cold-starting the pinned app
  // must land in the app, not on the marketing page with a sign-in button.
  const session = await getSession();
  if (session?.user) redirect('/chat');

  const { t } = await getI18n();
  return (
    <Container size="sm" py={120}>
      <Stack gap="xl" align="center" ta="center">
        <Stack gap="sm">
          <Title order={1} fz={48}>
            Familienwerk
          </Title>
          <Text c="dimmed" fz="lg" maw={520}>
            {t.home.tagline}
          </Text>
        </Stack>

        <Group>
          <Button component="a" href="/login" size="md">
            {t.home.signIn}
          </Button>
          <Button component="a" href="/signup" size="md" variant="default">
            {t.home.createAccount}
          </Button>
        </Group>

        <Paper withBorder p="md" radius="md" maw={520} mt="xl">
          <Text size="sm" c="dimmed">
            {t.home.blurb}
          </Text>
        </Paper>
      </Stack>
    </Container>
  );
}
