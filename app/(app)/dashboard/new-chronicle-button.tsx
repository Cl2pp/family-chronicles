'use client';

import { useState, useTransition } from 'react';
import { Button, Modal, Stack, Textarea, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconPlus } from '@tabler/icons-react';
import { createChronicleAction } from './actions';

export function NewChronicleButton() {
  const [opened, setOpened] = useState(false);
  const [pending, startTransition] = useTransition();

  const form = useForm({
    initialValues: { name: '', description: '' },
    validate: { name: (v) => (v.trim().length > 0 ? null : 'Give your chronicle a name') },
  });

  function handleSubmit(values: typeof form.values) {
    startTransition(async () => {
      try {
        // Redirects to the new chronicle on success.
        await createChronicleAction({ name: values.name, description: values.description });
      } catch (err) {
        // A redirect throws a special error that Next handles — ignore it.
        if (err && typeof err === 'object' && 'digest' in err) throw err;
        notifications.show({ color: 'red', message: 'Could not create chronicle' });
      }
    });
  }

  return (
    <>
      <Button leftSection={<IconPlus size={16} />} onClick={() => setOpened(true)}>
        New chronicle
      </Button>

      <Modal opened={opened} onClose={() => setOpened(false)} title="New family chronicle">
        <form onSubmit={form.onSubmit(handleSubmit)}>
          <Stack>
            <TextInput
              label="Name"
              placeholder="The Schmidt Family"
              data-autofocus
              {...form.getInputProps('name')}
            />
            <Textarea
              label="Description"
              placeholder="What is this chronicle about? (optional)"
              autosize
              minRows={2}
              {...form.getInputProps('description')}
            />
            <Button type="submit" loading={pending}>
              Create
            </Button>
          </Stack>
        </form>
      </Modal>
    </>
  );
}
