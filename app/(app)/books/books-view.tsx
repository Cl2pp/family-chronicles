'use client';

import Link from 'next/link';
import { Badge, Card, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import { IconBook2, IconChevronRight } from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';
import type { BookListItem } from '@/lib/books';
import { NewBookButton } from './new-book-button';

const STATUS_COLORS: Record<BookListItem['status'], string> = {
  draft: 'gray',
  rendering: 'blue',
  preview_ready: 'teal',
  render_failed: 'red',
  ordered: 'grape',
};

export function BooksView({ books }: { books: BookListItem[] }) {
  const { t } = useI18n();
  return (
    <Stack gap="md">
      <Group justify="flex-end">
        <NewBookButton label={t.books.newBook} />
      </Group>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
        {books.map((b) => (
          <Card
            key={b.id}
            withBorder
            radius="md"
            p="md"
            component={Link}
            href={`/books/${b.id}`}
            style={{ color: 'inherit', textDecoration: 'none' }}
          >
            <Group justify="space-between" wrap="nowrap">
              <Group gap={10} wrap="nowrap" style={{ minWidth: 0 }}>
                <IconBook2 size={22} stroke={1.6} color="var(--mantine-color-brand-6)" />
                <Stack gap={2} style={{ minWidth: 0 }}>
                  <Text fw={600} truncate>
                    {b.title}
                  </Text>
                  <Text fz={12} c="dimmed" truncate>
                    {b.chronicleName} · {t.books.storyCount(b.storyCount)}
                    {b.pageCount ? ` · ${t.books.pageCount(b.pageCount)}` : ''}
                  </Text>
                </Stack>
              </Group>
              <Group gap={8} wrap="nowrap">
                <Badge color={STATUS_COLORS[b.status]} variant="light">
                  {t.books.status[b.status]}
                </Badge>
                <IconChevronRight size={16} color="var(--mantine-color-slate-4)" />
              </Group>
            </Group>
          </Card>
        ))}
      </SimpleGrid>
    </Stack>
  );
}
