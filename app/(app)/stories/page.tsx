import { Box, Button, Card, Stack, Text, Title } from '@mantine/core';
import { IconMessageCircle2 } from '@tabler/icons-react';
import { requireUser } from '@/lib/session';
import { requireActiveChronicle } from '@/lib/active-chronicle';
import { loadStoryAccessContext } from '@/lib/story-access';
import { listStoriesForUser } from '@/lib/stories';
import { getI18n } from '@/lib/i18n/server';
import { UnlinkedPersonBanner } from '@/components/unlinked-person-banner';
import { StoriesView } from './stories-view';

export default async function StoriesPage() {
  const user = await requireUser();
  const { t } = await getI18n();

  const active = await requireActiveChronicle(user.id);
  const accessCtx = await loadStoryAccessContext(user.id, active.id);
  const stories = await listStoriesForUser(user.id, active.id, accessCtx);

  // In this active chronicle, if it's 'family'-mode, an account with no person in
  // ITS tree only sees its own stories — tell the user why (an owner has to place
  // them). Owners read everything regardless of linking, so the banner never
  // applies to them.
  const showUnlinkedBanner =
    accessCtx.personId === null && !accessCtx.isOpenMode && !accessCtx.isOwner;

  return (
    <Box p="lg" maw={960} mx="auto">
      {showUnlinkedBanner && <UnlinkedPersonBanner />}
      {stories.length === 0 ? (
        <>
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
        </>
      ) : (
        <StoriesView stories={stories} />
      )}
    </Box>
  );
}
