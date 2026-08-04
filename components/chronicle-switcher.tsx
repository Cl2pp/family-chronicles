'use client';

import { useTransition } from 'react';
import { Box, Group, Menu, Text, UnstyledButton } from '@mantine/core';
import { IconCheck, IconChevronDown, IconPlus } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n/client';
import { setActiveChronicle } from '@/app/(app)/settings/actions';

export interface ChronicleOption {
  id: string;
  name: string;
}

/** Shared shell for the switcher's clickable face — a real, visible button rather than
 *  bare text, so "which space am I in" reads as something you can act on. */
const SWITCHER_FACE = {
  border: '1px solid var(--mantine-color-slate-3)',
  borderRadius: 'var(--mantine-radius-md)',
  background: 'var(--mantine-color-white)',
};

/**
 * "Which space am I in" switcher — chronicles are hard-isolated, so without this a user
 * has no way to tell why their stories "disappeared" after a switch. Lives at the top of
 * the sidebar under the brand. On mobile the sidebar is collapsed away entirely, and a
 * repeat above the content cost the chat view its 100dvh budget, so there the switcher
 * lives on the settings screen instead — one tap from the bottom tab bar.
 */
export function ChronicleSwitcher({
  chronicles,
  activeChronicleId,
}: {
  chronicles: ChronicleOption[];
  activeChronicleId: string | null;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const [, startTransition] = useTransition();

  // Brand-new user: no chronicle to switch to yet — point at creating the first
  // one instead of rendering a switcher with nothing in it.
  if (chronicles.length === 0) {
    return (
      <UnstyledButton component={Link} href="/chronicle/new" w="100%" px={10} py={8} style={SWITCHER_FACE}>
        <Text fz={13} fw={600} c="brand.7" truncate>
          {t.chroniclesCard.startYourChronicle}
        </Text>
      </UnstyledButton>
    );
  }

  const active = chronicles.find((c) => c.id === activeChronicleId) ?? chronicles[0];

  function switchTo(id: string) {
    if (id === active.id) return;
    startTransition(async () => {
      await setActiveChronicle(id);
      router.refresh();
    });
  }

  // Rendered even with a single chronicle: the dropdown still carries "new chronicle",
  // and a control that appears only once you own two spaces is a control nobody finds.
  return (
    <Menu position="bottom-start" width="target" shadow="md">
      <Menu.Target>
        <UnstyledButton
          w="100%"
          px={10}
          py={8}
          style={SWITCHER_FACE}
          aria-label={t.chronicleSwitcher.ariaLabel}
        >
          <Group gap={8} wrap="nowrap" justify="space-between">
            <Box style={{ minWidth: 0 }}>
              <Text fz={10} fw={700} tt="uppercase" c="dimmed" lh={1.2} style={{ letterSpacing: '0.04em' }}>
                {t.settings.chroniclesTitle}
              </Text>
              <Text fz={14} fw={600} truncate lh={1.3}>
                {active.name}
              </Text>
            </Box>
            <IconChevronDown size={16} stroke={1.8} style={{ flexShrink: 0, opacity: 0.55 }} />
          </Group>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        {chronicles.map((c) => (
          <Menu.Item
            key={c.id}
            fw={c.id === active.id ? 600 : undefined}
            leftSection={
              <IconCheck
                size={14}
                style={{ opacity: c.id === active.id ? 1 : 0 }}
              />
            }
            onClick={() => switchTo(c.id)}
          >
            {c.name}
          </Menu.Item>
        ))}
        <Menu.Divider />
        <Menu.Item
          leftSection={<IconPlus size={14} />}
          component={Link}
          href="/chronicle/new"
        >
          {t.chroniclesCard.newChronicle}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
