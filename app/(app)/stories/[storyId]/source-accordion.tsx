'use client';

import { Accordion, Box, Group, Stack, Text } from '@mantine/core';
import { IconMessageCircle2 } from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';

export function SourceAccordion({
  audioUrl,
  originalParas,
  inputType,
  fromConversation,
}: {
  audioUrl: string | null;
  originalParas: string[];
  inputType: string;
  fromConversation: boolean;
}) {
  const { t } = useI18n();
  return (
    <Accordion variant="separated" radius="md">
      <Accordion.Item value="source">
        <Accordion.Control>{t.story.sourceMaterial}</Accordion.Control>
        <Accordion.Panel>
          <Stack gap="md">
            {audioUrl && <audio controls src={audioUrl} style={{ width: '100%' }} />}
            {originalParas.length > 0 && (
              <Box p="md" bg="slate.0" style={{ borderRadius: 'var(--mantine-radius-md)' }}>
                <Text size="xs" c="dimmed" mb={6} tt="uppercase" fw={600}>
                  {inputType === 'voice' ? t.story.originalTranscript : t.story.originalText}
                </Text>
                <Stack gap="sm">
                  {originalParas.map((para, i) => (
                    <Text key={i} size="sm" c="slate.7">
                      {para}
                    </Text>
                  ))}
                </Stack>
              </Box>
            )}
            {fromConversation && (
              <Group gap="xs" c="dimmed">
                <IconMessageCircle2 size={16} />
                <Text size="sm" c="dimmed">
                  {t.story.fromChat}
                </Text>
              </Group>
            )}
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}
