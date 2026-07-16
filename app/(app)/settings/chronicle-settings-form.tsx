'use client';

import { useTransition } from 'react';
import { Alert, Button, Group, Select, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { IconUserQuestion } from '@tabler/icons-react';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { useI18n } from '@/lib/i18n/client';
import { isLocale, LOCALE_NAMES, LOCALES, type Locale } from '@/lib/i18n/config';
import type { StoryAccessMode } from '@/lib/chronicles';
import { saveChronicleSettings } from './actions';

/** Settings form of one chronicle: name, description, writing style, story language, story access. */
export function ChronicleSettingsForm({
  chronicleId,
  name,
  description,
  styleGuide,
  storyLanguage,
  storyAccess,
  unlinkedMemberCount,
  canManage: manage,
}: {
  chronicleId: string;
  name: string;
  description: string;
  styleGuide: string;
  storyLanguage: string | null;
  storyAccess: StoryAccessMode;
  /** Member accounts with no person in the tree — they'd only see their own stories in 'family' mode. */
  unlinkedMemberCount: number;
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
      storyAccess,
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
    <form onSubmit={form.onSubmit(handleSubmit)}>
      <Stack>
        {!manage && (
          <Text c="dimmed" size="sm">
            {t.settings.onlyOwners}
          </Text>
        )}
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
        <Select
          label={t.settings.storyAccess}
          description={t.settings.storyAccessDescription}
          data={[
            { value: 'open', label: t.settings.storyAccessOpen },
            { value: 'family', label: t.settings.storyAccessFamily },
          ]}
          allowDeselect={false}
          disabled={!manage}
          maw={280}
          {...form.getInputProps('storyAccess')}
        />
        {manage && form.values.storyAccess === 'family' && unlinkedMemberCount > 0 && (
          <Alert icon={<IconUserQuestion size={18} />} color="yellow">
            {t.settings.storyAccessUnlinkedWarning(unlinkedMemberCount)}
          </Alert>
        )}
        {manage && (
          <Group justify="flex-end">
            <Button type="submit" loading={pending}>
              {t.common.saveChanges}
            </Button>
          </Group>
        )}
      </Stack>
    </form>
  );
}
