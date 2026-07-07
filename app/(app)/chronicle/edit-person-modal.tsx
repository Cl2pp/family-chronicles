'use client';

import { useEffect, useTransition } from 'react';
import { Button, Group, Modal, Select, Stack, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import type { Gender } from '@/lib/people';
import { useI18n } from '@/lib/i18n/client';
import { editPersonAction } from './actions';
import { genderOptions, type PersonRow } from './types';

function yearOf(d: Date | string | null | undefined): string {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? '' : String(date.getUTCFullYear());
}

/** Edit an existing person's name, surname, and birth/death years. */
export function EditPersonModal({
  chronicleId,
  person,
  opened,
  onClose,
}: {
  chronicleId: string;
  person: PersonRow | null;
  opened: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [pending, startTransition] = useTransition();
  const form = useForm({
    initialValues: {
      displayName: '',
      familyName: '',
      birthFamilyName: '',
      gender: null as Gender | null,
      bornYear: '',
      diedYear: '',
    },
    validate: {
      displayName: (v) => (v.trim() ? null : t.person.nameRequired),
      bornYear: (v) => (v === '' || /^\d{1,4}$/.test(v) ? null : t.person.use4DigitYear),
      diedYear: (v) => (v === '' || /^\d{1,4}$/.test(v) ? null : t.person.use4DigitYear),
    },
  });

  useEffect(() => {
    if (opened && person) {
      form.setValues({
        displayName: person.displayName,
        familyName: person.familyName ?? '',
        birthFamilyName: person.birthFamilyName ?? '',
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
          chronicleId,
          personId: person.id,
          displayName: values.displayName,
          familyName: values.familyName.trim() || null,
          birthFamilyName: values.birthFamilyName.trim() || null,
          gender: values.gender,
          bornYear: values.bornYear ? Number(values.bornYear) : null,
          diedYear: values.diedYear ? Number(values.diedYear) : null,
        });
        notifications.show({ message: t.person.updated });
        onClose();
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : t.person.couldNotUpdate,
        });
      }
    });
  }

  return (
    <Modal opened={opened} onClose={onClose} title={t.person.editTitle} radius="md">
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack>
          <TextInput label={t.person.name} required {...form.getInputProps('displayName')} />
          <TextInput
            label={t.person.familyName}
            placeholder={t.common.optional}
            {...form.getInputProps('familyName')}
          />
          <TextInput
            label={t.person.birthName}
            placeholder={t.person.birthNamePlaceholder}
            {...form.getInputProps('birthFamilyName')}
          />
          <Select
            label={t.person.gender}
            placeholder={t.common.optional}
            data={genderOptions(t)}
            clearable
            {...form.getInputProps('gender')}
          />
          <Group grow>
            <TextInput
              label={t.person.birthYear}
              placeholder={t.person.birthYearPlaceholder}
              {...form.getInputProps('bornYear')}
            />
            <TextInput
              label={t.person.deathYear}
              placeholder={t.person.deathYearPlaceholder}
              {...form.getInputProps('diedYear')}
            />
          </Group>
          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={onClose} disabled={pending}>
              {t.common.cancel}
            </Button>
            <Button type="submit" loading={pending}>
              {t.common.saveChanges}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
