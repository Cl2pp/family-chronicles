'use client';

import {
  Anchor,
  AppShell,
  Avatar,
  Container,
  Group,
  Menu,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { IconLogout } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';

function initials(name: string) {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function AppChrome({
  user,
  children,
}: {
  user: { name: string; email: string };
  children: React.ReactNode;
}) {
  const router = useRouter();

  async function signOut() {
    await authClient.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <AppShell header={{ height: 60 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Anchor href="/dashboard" underline="never" c="inherit">
            <Title order={4} ff="Georgia, serif">
              Family Chronicle
            </Title>
          </Anchor>

          <Menu position="bottom-end" withArrow>
            <Menu.Target>
              <UnstyledButton>
                <Group gap="xs">
                  <Avatar size={30} radius="xl" color="sienna">
                    {initials(user.name)}
                  </Avatar>
                  <Text size="sm" visibleFrom="xs">
                    {user.name}
                  </Text>
                </Group>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>{user.email}</Menu.Label>
              <Menu.Item leftSection={<IconLogout size={16} />} onClick={signOut}>
                Sign out
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </AppShell.Header>

      <AppShell.Main>
        <Container size="md">{children}</Container>
      </AppShell.Main>
    </AppShell>
  );
}
