import { Box, Button, Card, Stack, Text, Title } from '@mantine/core';
import { IconMessageCircle2 } from '@tabler/icons-react';
import { requireUser } from '@/lib/session';
import { listStoriesForUser } from '@/lib/stories';
import { StoriesView } from './stories-view';

export default async function StoriesPage() {
  const user = await requireUser();

  const stories = await listStoriesForUser(user.id);

  if (stories.length === 0) {
    return (
      <Box p="lg" maw={960} mx="auto">
        <Title order={1} mb="lg">
          Stories
        </Title>
        <Card withBorder radius="md" p="xl">
          <Stack align="center" gap="sm" py="lg">
            <Text fw={600} size="lg">
              No stories yet
            </Text>
            <Text c="dimmed" ta="center" maw={420}>
              Head to Chat to tell your first one — we&apos;ll transcribe it and weave it into
              your family memoir.
            </Text>
            <Button
              component="a"
              href="/chat"
              mt="sm"
              leftSection={<IconMessageCircle2 size={18} />}
            >
              Go to Chat
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
