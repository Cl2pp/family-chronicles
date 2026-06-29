'use client';

import { useState } from 'react';
import {
  AppShell,
  Avatar,
  Box,
  Group,
  Menu,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import {
  IconBinaryTree2,
  IconBook2,
  IconCheck,
  IconChevronDown,
  IconLayoutGrid,
  IconLogout,
  IconMessageCircle,
  IconPlus,
  IconSearch,
  IconSettings,
  IconUserCircle,
} from '@tabler/icons-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';

export interface FamilySummary {
  id: string;
  name: string;
  role: string;
}

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

function roleLabel(role: string) {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function AppChrome({
  user,
  families,
  activeFamilyId,
  children,
}: {
  user: { name: string; email: string };
  families: FamilySummary[];
  activeFamilyId?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [activeId, setActiveId] = useState(activeFamilyId ?? families[0]?.id);
  const active = families.find((f) => f.id === activeId) ?? families[0];

  async function signOut() {
    await authClient.signOut();
    router.push('/login');
    router.refresh();
  }

  function selectFamily(id: string) {
    setActiveId(id);
    // Persist for server-side family context in later phases.
    document.cookie = `activeFamilyId=${id}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }

  return (
    <AppShell
      header={{ height: 56 }}
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
                  <Avatar size={28} radius="xl" color="slate">
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
              <Menu.Item leftSection={<IconLogout size={16} />} onClick={signOut}>
                Sign out
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Box>
      </AppShell.Navbar>

      {/* ── Top bar ─────────────────────────────────────────── */}
      <AppShell.Header withBorder>
        <Group h="100%" px="sm" gap={10} wrap="nowrap">
          <FamilySwitcher
            families={families}
            active={active}
            onSelect={selectFamily}
          />
          <Box style={{ flex: 1 }} />
          <TextInput
            visibleFrom="sm"
            size="xs"
            radius="md"
            w={160}
            placeholder="Search…"
            leftSection={<IconSearch size={14} />}
          />
          <Menu position="bottom-end" withArrow>
            <Menu.Target>
              <UnstyledButton>
                <Avatar size={28} radius="xl" color="slate">
                  {initials(user.name)}
                </Avatar>
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
              <Menu.Item leftSection={<IconLogout size={16} />} onClick={signOut}>
                Sign out
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </AppShell.Header>

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

function FamilySwitcher({
  families,
  active,
  onSelect,
}: {
  families: FamilySummary[];
  active?: FamilySummary;
  onSelect: (id: string) => void;
}) {
  if (!active) {
    return (
      <UnstyledButton component={Link} href="/family">
        <Group
          gap={8}
          px={10}
          py={6}
          style={{ border: '1px solid var(--mantine-color-slate-3)', borderRadius: 8 }}
        >
          <IconPlus size={16} />
          <Text fz={12} fw={500}>
            Create your first family
          </Text>
        </Group>
      </UnstyledButton>
    );
  }

  return (
    <Menu position="bottom-start" withArrow width={240}>
      <Menu.Target>
        <UnstyledButton>
          <Group
            gap={8}
            px={10}
            py={6}
            wrap="nowrap"
            style={{ border: '1px solid var(--mantine-color-slate-3)', borderRadius: 8 }}
          >
            <Avatar size={18} radius="xl" color="slate" />
            <Text fz={12} fw={500}>
              {active.name}
            </Text>
            <Text fz={12} c="dimmed">
              · {roleLabel(active.role)}
            </Text>
            <IconChevronDown size={14} color="var(--mantine-color-slate-4)" />
          </Group>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Switch family</Menu.Label>
        {families.map((f) => (
          <Menu.Item
            key={f.id}
            onClick={() => onSelect(f.id)}
            rightSection={
              f.id === active.id ? (
                <IconCheck size={15} color="var(--mantine-color-brand-6)" />
              ) : null
            }
          >
            <Text fz={13} fw={600}>
              {f.name}
            </Text>
            <Text fz={11} c="dimmed">
              {roleLabel(f.role)}
            </Text>
          </Menu.Item>
        ))}
        <Menu.Item leftSection={<IconLayoutGrid size={15} />} disabled>
          All families
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          leftSection={<IconPlus size={15} />}
          component={Link}
          href="/family/new"
          c="brand.6"
          fw={600}
        >
          New family
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
