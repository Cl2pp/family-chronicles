import Link from 'next/link';
import {
  Anchor,
  Box,
  Button,
  Card,
  Group,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { requireUser } from '@/lib/session';
import { createFamilyAction } from '../actions';

export default async function NewFamilyPage() {
  await requireUser();

  return (
    <Box p="lg" maw={1100} mx="auto">
      <Stack gap="lg">
        <div>
          <Title order={2}>Start a family</Title>
          <Text c="dimmed" mt={4}>
            A family is a private circle where you collect stories and build a shared tree.
          </Text>
        </div>

        <Card withBorder radius="md" maw={560}>
          <form action={createFamilyAction}>
            <Stack>
              <TextInput
                name="name"
                label="Family name"
                placeholder="e.g. The Ortlepp family"
                required
              />
              <Textarea
                name="description"
                label="Description"
                placeholder="A short note about this family (optional)"
                autosize
                minRows={2}
              />
              <Group justify="space-between" mt="sm">
                <Anchor component={Link} href="/family" c="dimmed" size="sm">
                  Cancel
                </Anchor>
                <Button type="submit">Create family</Button>
              </Group>
            </Stack>
          </form>
        </Card>
      </Stack>
    </Box>
  );
}
