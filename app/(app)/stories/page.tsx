import { Box, Button, Card, Stack, Text, Title } from '@mantine/core';
import { IconMessageCircle2 } from '@tabler/icons-react';
import { requireUser } from '@/lib/session';
import { listStoriesForUser } from '@/lib/stories';
import { getI18n } from '@/lib/i18n/server';
import { StoriesView } from './stories-view';

export default async function StoriesPage() {
  const user = await requireUser();
  const { t } = await getI18n();

  const stories = await listStoriesForUser(user.id);

  if (stories.length === 0) {
    return (
      <Box p="lg" maw={960} mx="auto">
        <Title order={1} mb="lg">
          {t.stories.title}
        </Title>
        <Card withBorder radius="md" p="xl">
          <Stack align="center" gap="sm" py="lg">
            <Text fw={600} size="lg">
              {t.stories.noStoriesYet}
            </Text>
            <Text c="dimmed" ta="center" maw={420}>
              {t.stories.noStoriesHint}
            </Text>
            <Button
              component="a"
              href="/chat?intent=add-story"
              mt="sm"
              leftSection={<IconMessageCircle2 size={18} />}
            >
              {t.stories.goToChat}
            </Button>
          </Stack>
        </Card>
      </Box>
    );
  }

  return (
    <Box p="lg" maw={960} mx="auto">
      <StoriesView stories={stories} />
    </Box>
  );
}
