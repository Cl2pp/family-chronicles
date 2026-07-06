'use client';

import { useEffect, useTransition } from 'react';
import { Button, Group, Modal, Stack, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { addPersonAction } from './actions';
import type { AddTarget } from './types';

const RELATION_TITLE: Record<AddTarget['relation'], (name: string) => string> = {
  parent: (n) => `Add a parent of ${n}`,
  child: (n) => `Add a child of ${n}`,
  partner: (n) => `Add a partner of ${n}`,
};

export function AddPersonModal({
  familyId,
  opened,
  target,
  onClose,
}: {
  familyId: string;
  opened: boolean;
  target?: AddTarget;
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const form = useForm({
    initialValues: { displayName: '', familyName: '', bornYear: '', diedYear: '' },
    validate: {
      displayName: (v) => (v.trim() ? null : 'A name is required'),
      bornYear: (v) => (v === '' || /^\d{1,4}$/.test(v) ? null : 'Use a 4-digit year'),
      diedYear: (v) => (v === '' || /^\d{1,4}$/.test(v) ? null : 'Use a 4-digit year'),
    },
  });

  useEffect(() => {
    if (opened) form.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const title = target ? RELATION_TITLE[target.relation](target.personName) : 'Add a person';

  function handleSubmit(values: typeof form.values) {
    startTransition(async () => {
      try {
        await addPersonAction({
          familyId,
          displayName: values.displayName,
          familyName: values.familyName || undefined,
          bornYear: values.bornYear ? Number(values.bornYear) : undefined,
          diedYear: values.diedYear ? Number(values.diedYear) : undefined,
          connectTo: target
            ? { personId: target.personId, relation: target.relation }
            : undefined,
        });
        notifications.show({ message: 'Person added' });
        onClose();
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : 'Could not add person',
        });
      }
    });
  }

  return (
    <Modal opened={opened} onClose={onClose} title={title} radius="md">
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack>
          <TextInput
            label="Name"
            placeholder="Full name"
            required
            {...form.getInputProps('displayName')}
          />
          <TextInput
            label="Family name (surname)"
            placeholder="Optional"
            {...form.getInputProps('familyName')}
          />
          <Group grow>
            <TextInput
              label="Birth year"
              placeholder="e.g. 1948"
              {...form.getInputProps('bornYear')}
            />
            <TextInput
              label="Death year"
              placeholder="e.g. 2019"
              {...form.getInputProps('diedYear')}
            />
          </Group>
          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Add person
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
