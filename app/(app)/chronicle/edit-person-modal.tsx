'use client';

import { useEffect, useTransition } from 'react';
import { Button, Group, Modal, Select, Stack, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import type { Gender } from '@/lib/people';
import { useI18n } from '@/lib/i18n/client';
import { eventDateToParts } from '@/lib/dates';
import type { DatePrecision } from '@/lib/stories';
import {
  EventDateInput,
  eventDateValueFromParts,
  eventDateValueToParts,
  type EventDateValue,
} from '@/components/event-date-input';
import { editPersonAction } from './actions';
import { genderOptions, type PersonRow } from './types';

const EMPTY_DATE: EventDateValue = { day: '', month: '', year: '' };

/** Edit an existing person's name, surname, and birth/death dates. */
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
      born: EMPTY_DATE,
      died: EMPTY_DATE,
    },
    validate: {
      displayName: (v) => (v.trim() ? null : t.person.nameRequired),
    },
  });

  useEffect(() => {
    if (opened && person) {
      form.setValues({
        displayName: person.displayName,
        familyName: person.familyName ?? '',
        birthFamilyName: person.birthFamilyName ?? '',
        gender: person.gender,
        born: eventDateValueFromParts(
          eventDateToParts(person.bornOn, person.bornPrecision as DatePrecision | null),
        ),
        died: eventDateValueFromParts(
          eventDateToParts(person.diedOn, person.diedPrecision as DatePrecision | null),
        ),
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
          born: eventDateValueToParts(values.born),
          died: eventDateValueToParts(values.died),
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
          <Group grow align="flex-start">
            <EventDateInput
              label={t.person.birthDate}
              description={t.person.dateHint}
              value={form.values.born}
              onChange={(v) => form.setFieldValue('born', v)}
            />
            <EventDateInput
              label={t.person.deathDate}
              value={form.values.died}
              onChange={(v) => form.setFieldValue('died', v)}
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
