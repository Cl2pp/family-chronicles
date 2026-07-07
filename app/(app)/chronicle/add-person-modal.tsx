'use client';

import { useEffect, useTransition } from 'react';
import { Button, Group, Modal, Select, Stack, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import type { Gender } from '@/lib/people';
import { useI18n } from '@/lib/i18n/client';
import type { Dictionary } from '@/lib/i18n';
import { addPersonAction } from './actions';
import type { AddTarget } from './types';

export function genderOptions(t: Dictionary) {
  return [
    { value: 'male', label: t.person.male },
    { value: 'female', label: t.person.female },
  ];
}

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
          bornYear: values.bornYear ? Number(values.bornYear) : undefined,
          diedYear: values.diedYear ? Number(values.diedYear) : undefined,
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
