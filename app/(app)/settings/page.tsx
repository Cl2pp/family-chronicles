import { cookies } from 'next/headers';
import { Anchor, Box, Card, Group, Stack, Text, Title } from '@mantine/core';
import { requireUser } from '@/lib/session';
import { resolveActiveFamily } from '@/lib/families';
import type { AccessRole } from '@/lib/permissions';
import { FamiliesCard } from './families-card';
import pkg from '@/package.json';

export default async function SettingsPage() {
  const user = await requireUser();
  const activeCookie = (await cookies()).get('activeFamilyId')?.value;
  const { families, active } = await resolveActiveFamily(user.id, activeCookie);

  const rows = families.map((f) => ({
    id: f.id,
    name: f.name,
    description: f.description,
    role: f.role as AccessRole,
    createdLabel: f.createdAt.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }),
  }));

  return (
    <Box p="lg" maw={760} mx="auto">
      <Title order={1} mb="lg">
        Settings
      </Title>

      <Stack gap="lg">
        <Box>
          <Title order={3} mb="xs">
            My families
          </Title>
          <Text size="sm" c="dimmed" mb="md">
            The selected family is the one Chat, Stories and Family open with.
          </Text>
          <FamiliesCard families={rows} activeId={active?.id ?? null} />
        </Box>

        <Box>
          <Title order={3} mb="xs">
            About
          </Title>
          <Card withBorder radius="md" p="lg">
            <Group justify="space-between" align="flex-start">
              <Stack gap={2}>
                <Text fw={600}>Family Chronicle</Text>
                <Text size="sm" c="dimmed">
                  A private place for your family&apos;s stories and tree.
                </Text>
              </Stack>
              <Text size="sm" c="dimmed">
                v{pkg.version}
              </Text>
            </Group>
          </Card>
        </Box>

        <Text size="sm" c="dimmed">
          Profile, password and sign-out live in{' '}
          <Anchor component="a" href="/account" size="sm">
            Account
          </Anchor>
          .
        </Text>
      </Stack>
    </Box>
  );
}
