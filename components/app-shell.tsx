'use client';

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
  IconLogout,
  IconMessageCircle,
  IconSettings,
  IconUserCircle,
} from '@tabler/icons-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';

const NAV = [
  { href: '/chat', label: 'Chat', icon: IconMessageCircle },
  { href: '/stories', label: 'Stories', icon: IconBook2 },
  { href: '/family', label: 'Family', icon: IconBinaryTree2 },
  { href: '/settings', label: 'Settings', icon: IconSettings },
] as const;

const MOBILE_NAV = [
  { href: '/chat', label: 'Chat', icon: IconMessageCircle },
  { href: '/stories', label: 'Stories', icon: IconBook2 },
  { href: '/family', label: 'Family', icon: IconBinaryTree2 },
  { href: '/account', label: 'Account', icon: IconUserCircle },
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

export function AppChrome({
  user,
  children,
}: {
  user: { name: string; email: string; avatarUrl?: string | null };
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();

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
      {/* ── Sidebar ─────────────────────────────────────────── */}
      <AppShell.Navbar
        p="sm"
        style={{ background: 'var(--mantine-color-slate-0)' }}
        withBorder
      >
        <Group gap={8} mb="md" px={6}>
          <Box
            w={22}
            h={22}
            style={{ borderRadius: 6, background: 'var(--mantine-color-brand-6)' }}
          />
          <Text fw={700} fz={14}>
            Family Chronicle
          </Text>
        </Group>

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
                  background: activeItem ? 'var(--mantine-color-brand-1)' : undefined,
                  color: activeItem
                    ? 'var(--mantine-color-brand-7)'
                    : 'var(--mantine-color-slate-7)',
                }}
              >
                <Group gap={10} wrap="nowrap">
                  <Icon size={18} stroke={1.8} />
                  <Text fz={13} fw={activeItem ? 600 : 500}>
                    {item.label}
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
                      Account
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
                href="/account"
              >
                Account
              </Menu.Item>
              <Menu.Item
                leftSection={<IconSettings size={16} />}
                component={Link}
                href="/settings"
              >
                Settings
              </Menu.Item>
              <Menu.Item leftSection={<IconLogout size={16} />} onClick={signOut}>
                Sign out
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Box>
      </AppShell.Navbar>

      {/* ── Main ────────────────────────────────────────────── */}
      <AppShell.Main
        style={{ background: 'var(--mantine-color-slate-0)', minHeight: '100dvh' }}
      >
        <Box pb={{ base: 72, sm: 0 }}>{children}</Box>
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
                        ? 'var(--mantine-color-brand-7)'
                        : 'var(--mantine-color-slate-4)'
                    }
                  />
                  <Text
                    fz={10}
                    fw={activeItem ? 600 : 500}
                    c={activeItem ? 'brand.7' : 'dimmed'}
                  >
                    {item.label}
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
