'use client';

import { useTransition } from 'react';
import { Button, Card, Group, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { saveSettings } from './actions';

export function SettingsTab({
  familyId,
  name,
  description,
  styleGuide,
  canManage: manage,
}: {
  familyId: string;
  name: string;
  description: string;
  styleGuide: string;
  canManage: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const form = useForm({
    initialValues: { name, description, styleGuide },
    validate: { name: (v) => (v.trim() ? null : 'A family name is required') },
  });

  function handleSubmit(values: typeof form.values) {
    startTransition(async () => {
      try {
        await saveSettings({ familyId, ...values });
        notifications.show({ message: 'Settings saved' });
        form.resetDirty(values);
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : 'Could not save settings',
        });
      }
    });
  }

  return (
    <Card withBorder radius="md" maw={640}>
      {!manage && (
        <Text c="dimmed" size="sm" mb="md">
          Only owners can change these settings.
        </Text>
      )}
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack>
          <TextInput
            label="Family name"
            required
            disabled={!manage}
            {...form.getInputProps('name')}
          />
          <Textarea
            label="Description"
            autosize
            minRows={2}
            disabled={!manage}
            {...form.getInputProps('description')}
          />
          <Textarea
            label="Writing style"
            description="Guidance injected into the styling prompt when stories are rewritten."
            autosize
            minRows={4}
            disabled={!manage}
            {...form.getInputProps('styleGuide')}
          />
          {manage && (
            <Group justify="flex-end">
              <Button type="submit" loading={pending}>
                Save changes
              </Button>
            </Group>
          )}
        </Stack>
      </form>
    </Card>
  );
}
