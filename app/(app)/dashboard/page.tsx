import { Badge, Card, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { requireUser } from '@/lib/session';
import { listChroniclesForUser } from '@/lib/chronicles';
import { NewChronicleButton } from './new-chronicle-button';

export default async function DashboardPage() {
  const user = await requireUser();
  const chronicles = await listChroniclesForUser(user.id);

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="center">
        <Title order={2}>Your chronicles</Title>
        <NewChronicleButton />
      </Group>

      {chronicles.length === 0 ? (
        <Card withBorder padding="xl" radius="md">
          <Stack align="center" gap="xs">
            <Text fw={600}>No chronicles yet</Text>
            <Text c="dimmed" ta="center" maw={420}>
              Create your first family chronicle to start collecting stories — then invite the
              family to contribute.
            </Text>
          </Stack>
        </Card>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
          {chronicles.map((c) => (
            <Card
              key={c.id}
              component="a"
              href={`/chronicles/${c.id}`}
              withBorder
              radius="md"
              padding="lg"
            >
              <Group justify="space-between" align="flex-start" mb="xs">
                <Title order={4}>{c.name}</Title>
                <Badge variant="light" color={c.role === 'owner' ? 'sienna' : 'gray'}>
                  {c.role}
                </Badge>
              </Group>
              <Text c="dimmed" size="sm" lineClamp={3}>
                {c.description || 'No description yet.'}
              </Text>
            </Card>
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}
