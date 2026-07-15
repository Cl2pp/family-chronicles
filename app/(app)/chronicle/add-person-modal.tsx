'use client';

import { useEffect, useTransition } from 'react';
import { Button, Group, Modal, Select, Stack, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import type { Gender } from '@/lib/people';
import { useI18n } from '@/lib/i18n/client';
import type { Dictionary } from '@/lib/i18n';
import { EventDateInput, eventDateValueToParts, type EventDateValue } from '@/components/event-date-input';
import { addPersonAction } from './actions';
import { genderOptions, type AddTarget } from './types';

const EMPTY_DATE: EventDateValue = { day: '', month: '', year: '' };

const RELATION_TITLE: Record<AddTarget['relation'], (t: Dictionary, name: string) => string> = {
  parent: (t, n) => t.person.addTitleParent(n),
  child: (t, n) => t.person.addTitleChild(n),
  partner: (t, n) => t.person.addTitlePartner(n),
};

export function AddPersonModal({
  chronicleId,
  opened,
  target,
  onClose,
}: {
  chronicleId: string;
  opened: boolean;
  target?: AddTarget;
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
    if (opened) form.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const title = target
    ? RELATION_TITLE[target.relation](t, target.personName)
    : t.person.addTitle;

  function handleSubmit(values: typeof form.values) {
    startTransition(async () => {
      try {
        await addPersonAction({
          chronicleId,
          displayName: values.displayName,
          familyName: values.familyName || undefined,
          birthFamilyName: values.birthFamilyName || undefined,
          gender: values.gender,
          born: eventDateValueToParts(values.born),
          died: eventDateValueToParts(values.died),
          connectTo: target
            ? { personId: target.personId, relation: target.relation }
            : undefined,
        });
        notifications.show({ message: t.person.added });
        onClose();
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : t.person.couldNotAdd,
        });
      }
    });
  }

  return (
    <Modal opened={opened} onClose={onClose} title={title} radius="md">
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack>
          <TextInput
            label={t.person.name}
            placeholder={t.person.fullNamePlaceholder}
            required
            {...form.getInputProps('displayName')}
          />
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
            <Button variant="default" onClick={onClose}>
              {t.common.cancel}
            </Button>
            <Button type="submit" loading={pending}>
              {t.person.add}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
