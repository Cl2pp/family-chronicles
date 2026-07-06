import { Avatar, Box, Card, Group, Stack, Text, Title } from '@mantine/core';
import { requireUser } from '@/lib/session';
import { SignOutButton } from './sign-out-button';

function initials(name: string) {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export default async function AccountPage() {
  const user = await requireUser();

  return (
    <Box p="lg" maw={640} mx="auto">
      <Title order={1} mb="lg">
        Account
      </Title>
      <Card withBorder radius="md" p="lg">
        <Group justify="space-between" wrap="nowrap">
          <Group wrap="nowrap">
            <Avatar size={48} radius="xl" color="brand">
              {initials(user.name)}
            </Avatar>
            <Stack gap={0}>
              <Text fw={600}>{user.name}</Text>
              <Text size="sm" c="dimmed">
                {user.email}
              </Text>
            </Stack>
          </Group>
          <SignOutButton />
        </Group>
      </Card>
    </Box>
  );
}
