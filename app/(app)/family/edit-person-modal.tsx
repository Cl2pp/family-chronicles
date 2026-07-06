'use client';

import { useEffect, useTransition } from 'react';
import { Button, Group, Modal, Select, Stack, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import type { Gender } from '@/lib/people';
import { editPersonAction } from './actions';
import { GENDER_OPTIONS } from './add-person-modal';
import type { PersonRow } from './types';

function yearOf(d: Date | string | null | undefined): string {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? '' : String(date.getUTCFullYear());
}

/** Edit an existing person's name, surname, and birth/death years. */
export function EditPersonModal({
  familyId,
  person,
  opened,
  onClose,
}: {
  familyId: string;
  person: PersonRow | null;
  opened: boolean;
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const form = useForm({
    initialValues: {
      displayName: '',
      familyName: '',
      gender: null as Gender | null,
      bornYear: '',
      diedYear: '',
    },
    validate: {
      displayName: (v) => (v.trim() ? null : 'A name is required'),
      bornYear: (v) => (v === '' || /^\d{1,4}$/.test(v) ? null : 'Use a 4-digit year'),
      diedYear: (v) => (v === '' || /^\d{1,4}$/.test(v) ? null : 'Use a 4-digit year'),
    },
  });

  useEffect(() => {
    if (opened && person) {
      form.setValues({
        displayName: person.displayName,
        familyName: person.familyName ?? '',
        gender: person.gender,
        bornYear: yearOf(person.bornOn),
        diedYear: yearOf(person.diedOn),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, person]);

  function handleSubmit(values: typeof form.values) {
    if (!person) return;
    startTransition(async () => {
      try {
        await editPersonAction({
          familyId,
          personId: person.id,
          displayName: values.displayName,
          familyName: values.familyName.trim() || null,
          gender: values.gender,
          bornYear: values.bornYear ? Number(values.bornYear) : null,
          diedYear: values.diedYear ? Number(values.diedYear) : null,
        });
        notifications.show({ message: 'Person updated' });
        onClose();
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : 'Could not update person',
        });
      }
    });
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Edit person" radius="md">
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack>
          <TextInput label="Name" required {...form.getInputProps('displayName')} />
          <TextInput
            label="Family name (surname)"
            placeholder="Optional"
            {...form.getInputProps('familyName')}
          />
          <Select
            label="Gender"
            placeholder="Optional"
            data={GENDER_OPTIONS}
            clearable
            {...form.getInputProps('gender')}
          />
          <Group grow>
            <TextInput label="Birth year" placeholder="e.g. 1948" {...form.getInputProps('bornYear')} />
            <TextInput label="Death year" placeholder="e.g. 2019" {...form.getInputProps('diedYear')} />
          </Group>
          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Save changes
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
