'use client';

import { Paper, Tabs, Title } from '@mantine/core';
import { IconMicrophone, IconWriting } from '@tabler/icons-react';
import { TextComposer } from './text-composer';
import { VoiceComposer } from './voice-composer';

export function StoryComposer({ chronicleId }: { chronicleId: string }) {
  return (
    <Paper withBorder p="xl" radius="md">
      <Title order={3} mb="lg">
        Add a story
      </Title>
      <Tabs defaultValue="write">
        <Tabs.List mb="md">
          <Tabs.Tab value="write" leftSection={<IconWriting size={16} />}>
            Write
          </Tabs.Tab>
          <Tabs.Tab value="speak" leftSection={<IconMicrophone size={16} />}>
            Speak
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="write">
          <TextComposer chronicleId={chronicleId} />
        </Tabs.Panel>
        <Tabs.Panel value="speak">
          <VoiceComposer chronicleId={chronicleId} />
        </Tabs.Panel>
      </Tabs>
    </Paper>
  );
}
