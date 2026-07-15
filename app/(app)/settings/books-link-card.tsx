'use client';

import Link from 'next/link';
import { Card, Group, Stack, Text } from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';

/**
 * Settings → App row linking to /books. Mobile has no Books tab — this row is
 * the way back there. Client component: `component={Link}` passes a function,
 * which cannot cross the server→client serialization boundary.
 */
export function BooksLinkCard() {
  const { t } = useI18n();

  return (
    <Card withBorder radius="md" p="lg" component={Link} href="/books">
      <Group justify="space-between" align="center">
        <Stack gap={2}>
          <Text fw={600}>{t.books.title}</Text>
          <Text size="sm" c="dimmed">
            {t.books.intro}
          </Text>
        </Stack>
        <IconChevronRight size={18} color="var(--mantine-color-slate-4)" />
      </Group>
    </Card>
  );
}
