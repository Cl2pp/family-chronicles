'use client';

import { useTransition } from 'react';
import { Button, Card, Group, Select, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { useI18n } from '@/lib/i18n/client';
import { isLocale, LOCALE_NAMES, LOCALES, type Locale } from '@/lib/i18n/config';
import { saveChronicleSettings } from './actions';

/** Settings of the active chronicle: name, description, writing style, story language. */
export function ChronicleSettingsCard({
  chronicleId,
  name,
  description,
  styleGuide,
  storyLanguage,
  canManage: manage,
}: {
  chronicleId: string;
  name: string;
  description: string;
  styleGuide: string;
  storyLanguage: string | null;
  canManage: boolean;
}) {
  const { t } = useI18n();
  const [pending, startTransition] = useTransition();
  const form = useForm({
    initialValues: {
      name,
      description,
      styleGuide,
      storyLanguage: (isLocale(storyLanguage) ? storyLanguage : 'auto') as Locale | 'auto',
    },
    validate: { name: (v) => (v.trim() ? null : t.settings.chronicleNameRequired) },
  });

  function handleSubmit(values: typeof form.values) {
    startTransition(async () => {
      try {
        await saveChronicleSettings({ chronicleId, ...values });
        notifications.show({ message: t.settings.settingsSaved });
        form.resetDirty(values);
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : t.settings.couldNotSaveSettings,
        });
      }
    });
  }

  return (
    <Card withBorder radius="md" p="lg">
      {!manage && (
        <Text c="dimmed" size="sm" mb="md">
          {t.settings.onlyOwners}
        </Text>
      )}
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack>
          <TextInput
            label={t.settings.chronicleName}
            required
            disabled={!manage}
            {...form.getInputProps('name')}
          />
          <Textarea
            label={t.settings.description}
            autosize
            minRows={2}
            disabled={!manage}
            {...form.getInputProps('description')}
          />
          <Textarea
            label={t.settings.writingStyle}
            description={t.settings.writingStyleDescription}
            autosize
            minRows={4}
            disabled={!manage}
            {...form.getInputProps('styleGuide')}
          />
          <Select
            label={t.settings.storyLanguage}
            description={t.settings.storyLanguageDescription}
            data={[
              { value: 'auto', label: t.settings.storyLanguageAuto },
              ...LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] })),
            ]}
            allowDeselect={false}
            disabled={!manage}
            maw={280}
            {...form.getInputProps('storyLanguage')}
          />
          {manage && (
            <Group justify="flex-end">
              <Button type="submit" loading={pending}>
                {t.common.saveChanges}
              </Button>
            </Group>
          )}
        </Stack>
      </form>
    </Card>
  );
}
