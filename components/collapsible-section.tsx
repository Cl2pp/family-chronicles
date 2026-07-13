'use client';

import { useState, type ReactNode } from 'react';
import { Collapse, Group, Stack, Title, UnstyledButton } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';

/**
 * A page section whose heading toggles its body, so long stories and photo grids can
 * fold away and the sections below stay one tap from the top of the page.
 */
export function CollapsibleSection({
  title,
  action,
  defaultOpened = true,
  children,
}: {
  title: string;
  /** Rendered next to the heading, outside the toggle (e.g. an "Add photos" button). */
  action?: ReactNode;
  defaultOpened?: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [opened, setOpened] = useState(defaultOpened);

  return (
    <Stack gap="sm">
      <Group gap="sm" align="center">
        <UnstyledButton
          onClick={() => setOpened((o) => !o)}
          aria-expanded={opened}
          aria-label={`${title} — ${opened ? t.story.collapseSection : t.story.expandSection}`}
        >
          <Group gap={6} align="center" wrap="nowrap">
            <Title order={3}>{title}</Title>
            <IconChevronDown
              size={18}
              style={{
                transform: opened ? 'rotate(0deg)' : 'rotate(-90deg)',
                transition: 'transform 150ms ease',
                color: 'var(--mantine-color-dimmed)',
              }}
            />
          </Group>
        </UnstyledButton>
        {action}
      </Group>
      <Collapse expanded={opened}>{children}</Collapse>
    </Stack>
  );
}
