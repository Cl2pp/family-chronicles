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
import { createChronicleAction } from '../actions';

export default async function NewChroniclePage() {
  await requireUser();

  return (
    <Box p="lg" maw={1100} mx="auto">
      <Stack gap="lg">
        <div>
          <Title order={2}>Start a chronicle</Title>
          <Text c="dimmed" mt={4}>
            A chronicle is your family&apos;s private space for stories and a shared tree. Families themselves appear automatically from last names and marriages.
          </Text>
        </div>

        <Card withBorder radius="md" maw={560}>
          <form action={createChronicleAction}>
            <Stack>
              <TextInput
                name="name"
                label="Chronicle name"
                placeholder="e.g. Ortlepp & Hartwick"
                required
              />
              <Textarea
                name="description"
                label="Description"
                placeholder="A short note about this chronicle (optional)"
                autosize
                minRows={2}
              />
              <Group justify="space-between" mt="sm">
                <Anchor component="a" href="/chronicle" c="dimmed" size="sm">
                  Cancel
                </Anchor>
                <Button type="submit">Create chronicle</Button>
              </Group>
            </Stack>
          </form>
        </Card>
      </Stack>
    </Box>
  );
}
