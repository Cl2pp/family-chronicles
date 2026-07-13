'use client';

import { Accordion, Box, Group, Image, SimpleGrid, Stack, Text } from '@mantine/core';
import { IconMessageCircle2, IconMicrophone, IconPhoto } from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';

export interface ContributionView {
  id: string;
  contributorName: string | null;
  /** ISO timestamp — formatted client-side so it lands in the reader's time zone. */
  createdAt: string;
  text: string | null;
  audio: { id: string; url: string; durationSec: number | null }[];
  photos: { id: string; url: string; caption: string | null }[];
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${m}:${String(sec % 60).padStart(2, '0')}`;
}

/**
 * The source-material timeline: one collapsible entry per contribution, oldest first —
 * who added it, when, their voice notes and photos, and their words verbatim.
 */
export function SourceTimeline({
  contributions,
  fromConversation,
}: {
  contributions: ContributionView[];
  fromConversation: boolean;
}) {
  const { locale, t } = useI18n();
  const dateFormat = new Intl.DateTimeFormat(locale === 'de' ? 'de-DE' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        {t.story.sourceIntro}
      </Text>
      <Accordion
        variant="separated"
        radius="md"
        multiple
        defaultValue={contributions.length === 1 ? [contributions[0].id] : []}
      >
        {contributions.map((c) => (
          <Accordion.Item key={c.id} value={c.id}>
            <Accordion.Control>
              <Group gap="xs" align="baseline" wrap="wrap">
                <Text fw={600} size="sm">
                  {c.contributorName ?? t.story.unknownContributor}
                </Text>
                <Text size="xs" c="dimmed">
                  {dateFormat.format(new Date(c.createdAt))}
                </Text>
                <Group gap={10} wrap="nowrap">
                  {c.audio.length > 0 && (
                    <Group gap={4} wrap="nowrap" c="dimmed">
                      <IconMicrophone size={14} />
                      <Text size="xs">{t.story.voiceNotes(c.audio.length)}</Text>
                    </Group>
                  )}
                  {c.photos.length > 0 && (
                    <Group gap={4} wrap="nowrap" c="dimmed">
                      <IconPhoto size={14} />
                      <Text size="xs">{t.story.photoCount(c.photos.length)}</Text>
                    </Group>
                  )}
                </Group>
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              <Stack gap="md">
                {c.audio.map((a) => (
                  <Group key={a.id} gap="xs" wrap="nowrap">
                    <audio controls preload="metadata" src={a.url} style={{ width: '100%' }} />
                    {a.durationSec != null && (
                      <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                        {formatDuration(a.durationSec)}
                      </Text>
                    )}
                  </Group>
                ))}
                {c.text && (
                  <Box p="md" bg="slate.0" style={{ borderRadius: 'var(--mantine-radius-md)' }}>
                    <Text size="xs" c="dimmed" mb={6} tt="uppercase" fw={600}>
                      {t.story.inTheirWords}
                    </Text>
                    <Stack gap="sm">
                      {paragraphs(c.text).map((para, i) => (
                        <Text key={i} size="sm" c="slate.7">
                          {para}
                        </Text>
                      ))}
                    </Stack>
                  </Box>
                )}
                {c.photos.length > 0 && (
                  <SimpleGrid cols={{ base: 2, sm: 3, md: 4 }} spacing="sm">
                    {c.photos.map((p) => (
                      <Image
                        key={p.id}
                        src={p.url}
                        alt={p.caption ?? ''}
                        radius="sm"
                        fit="cover"
                        h={110}
                      />
                    ))}
                  </SimpleGrid>
                )}
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        ))}
      </Accordion>
      {fromConversation && (
        <Group gap="xs" c="dimmed">
          <IconMessageCircle2 size={16} />
          <Text size="sm" c="dimmed">
            {t.story.fromChat}
          </Text>
        </Group>
      )}
    </Stack>
  );
}
