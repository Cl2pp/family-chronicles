'use client';

import { useTransition } from 'react';
import {
  AppShell,
  Avatar,
  Box,
  Group,
  Menu,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import {
  IconBinaryTree2,
  IconBook2,
  IconBooks,
  IconCheck,
  IconChevronDown,
  IconLogout,
  IconMessageCircle,
  IconPlus,
  IconSettings,
  IconUserCircle,
} from '@tabler/icons-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';
import { useI18n } from '@/lib/i18n/client';
import type { Dictionary } from '@/lib/i18n';
import { BrandGlyph } from '@/components/brand-glyph';
import { setActiveChronicle } from '@/app/(app)/settings/actions';

/** Space reserved under content for the fixed mobile tab bar (60px bar + breathing room). */
export const MOBILE_TABBAR_OFFSET = 72;

export interface ChronicleOption {
  id: string;
  name: string;
}

const NAV = [
  { href: '/chat', label: (t: Dictionary) => t.nav.chat, icon: IconMessageCircle },
  { href: '/stories', label: (t: Dictionary) => t.nav.stories, icon: IconBook2 },
  { href: '/chronicle', label: (t: Dictionary) => t.nav.chronicle, icon: IconBinaryTree2 },
  { href: '/books', label: (t: Dictionary) => t.nav.books, icon: IconBooks },
  { href: '/settings', label: (t: Dictionary) => t.nav.settings, icon: IconSettings },
] as const;

// Deliberately 4 tabs — /books is reached from the Stories header and Settings on mobile.
const MOBILE_NAV = [
  { href: '/chat', label: (t: Dictionary) => t.nav.chat, icon: IconMessageCircle },
  { href: '/stories', label: (t: Dictionary) => t.nav.stories, icon: IconBook2 },
  { href: '/chronicle', label: (t: Dictionary) => t.nav.chronicle, icon: IconBinaryTree2 },
  { href: '/settings', label: (t: Dictionary) => t.nav.settings, icon: IconSettings },
] as const;

function initials(name: string) {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
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
 * the sidebar under the brand, and is repeated above the content on mobile, where the
 * sidebar is collapsed away entirely.
 */
function ChronicleSwitcher({
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

export function AppChrome({
  user,
  chronicles,
  activeChronicleId,
  children,
}: {
  user: { name: string; email: string; avatarUrl?: string | null };
  chronicles: ChronicleOption[];
  activeChronicleId: string | null;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useI18n();

  async function signOut() {
    await authClient.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <AppShell
      navbar={{ width: 220, breakpoint: 'sm', collapsed: { mobile: true } }}
      padding={0}
    >
      {/* ── Sidebar: brand, then the space you're in, then navigation ──── */}
      <AppShell.Navbar
        p="sm"
        style={{ background: 'var(--mantine-color-slate-0)' }}
        withBorder
      >
        <Group gap={8} mb={10} px={6}>
          <BrandGlyph size={22} variant="ink" />
          <Text
            fw={600}
            fz={15}
            style={{ fontFamily: 'var(--fw-font-brand)', letterSpacing: '-0.02em' }}
          >
            Familienwerk
          </Text>
        </Group>

        <Box mb="md">
          <ChronicleSwitcher chronicles={chronicles} activeChronicleId={activeChronicleId} />
        </Box>

        <Stack gap={3}>
          {NAV.map((item) => {
            const activeItem = isActive(pathname, item.href);
            const Icon = item.icon;
            return (
              <UnstyledButton
                key={item.href}
                component={Link}
                href={item.href}
                px={10}
                py={8}
                style={{
                  borderRadius: 8,
                  background: activeItem ? 'var(--mantine-color-brand-0)' : undefined,
                  color: activeItem
                    ? 'var(--mantine-color-brand-8)'
                    : 'var(--mantine-color-slate-7)',
                }}
              >
                <Group gap={10} wrap="nowrap">
                  <Icon size={18} stroke={1.8} />
                  <Text fz={13} fw={activeItem ? 600 : 500}>
                    {item.label(t)}
                  </Text>
                </Group>
              </UnstyledButton>
            );
          })}
        </Stack>

        <Box style={{ flex: 1 }} />

        <Box pt={10} style={{ borderTop: '1px solid var(--mantine-color-slate-2)' }}>
          <Menu position="top-start" withArrow width={200}>
            <Menu.Target>
              <UnstyledButton w="100%" px={6} py={4}>
                <Group gap={8} wrap="nowrap">
                  <Avatar size={28} radius="xl" color="slate" src={user.avatarUrl}>
                    {initials(user.name)}
                  </Avatar>
                  <Box style={{ minWidth: 0 }}>
                    <Text fz={12} fw={600} truncate>
                      {user.name}
                    </Text>
                    <Text fz={11} c="dimmed">
                      {t.nav.account}
                    </Text>
                  </Box>
                </Group>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>{user.email}</Menu.Label>
              <Menu.Item
                leftSection={<IconUserCircle size={16} />}
                component={Link}
                href="/settings?tab=account"
              >
                {t.nav.account}
              </Menu.Item>
              <Menu.Item leftSection={<IconLogout size={16} />} onClick={signOut}>
                {t.nav.signOut}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Box>
      </AppShell.Navbar>

      {/* ── Main ────────────────────────────────────────────── */}
      <AppShell.Main
        style={{ background: 'var(--mantine-color-slate-0)', minHeight: '100dvh' }}
      >
        {/* The sidebar (and with it the switcher) is collapsed away on mobile, so repeat
            the switcher above the content there — otherwise a phone user has no way to
            see or change which space they're in. Inline, not a fixed bar: it scrolls
            away with the content instead of permanently eating vertical space. */}
        <Box hiddenFrom="sm" px="md" pt="md">
          <ChronicleSwitcher chronicles={chronicles} activeChronicleId={activeChronicleId} />
        </Box>
        <Box pb={{ base: MOBILE_TABBAR_OFFSET, sm: 0 }}>{children}</Box>
      </AppShell.Main>

      {/* ── Mobile bottom tab bar ───────────────────────────── */}
      <Box
        hiddenFrom="sm"
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          height: 60,
          background: '#fff',
          borderTop: '1px solid var(--mantine-color-slate-2)',
          zIndex: 200,
        }}
      >
        <Group h="100%" justify="space-around" gap={0} px={8}>
          {MOBILE_NAV.map((item) => {
            const activeItem = isActive(pathname, item.href);
            const Icon = item.icon;
            return (
              <UnstyledButton
                key={item.href}
                component={Link}
                href={item.href}
                style={{ textAlign: 'center' }}
              >
                <Stack gap={3} align="center">
                  <Icon
                    size={20}
                    stroke={1.8}
                    color={
                      activeItem
                        ? 'var(--mantine-color-brand-8)'
                        : 'var(--mantine-color-slate-4)'
                    }
                  />
                  <Text
                    fz={10}
                    fw={activeItem ? 600 : 500}
                    c={activeItem ? 'brand.8' : 'dimmed'}
                  >
                    {item.label(t)}
                  </Text>
                </Stack>
              </UnstyledButton>
            );
          })}
        </Group>
      </Box>
    </AppShell>
  );
}
