'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Avatar,
  Button,
  Card,
  FileButton,
  Group,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCamera } from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';
import { MAX_AVATAR_BYTES, PHOTO_ACCEPT } from '@/lib/uploads';
import { presignAvatarUpload, saveAvatar, updateDisplayName } from './account-actions';
import { SignOutButton } from './sign-out-button';

function initials(name: string) {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function ProfileCard({
  name,
  email,
  avatarUrl,
}: {
  name: string;
  email: string;
  avatarUrl: string | null;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const [uploading, setUploading] = useState(false);
  const [saving, startTransition] = useTransition();
  const form = useForm({
    initialValues: { name },
    validate: { name: (v) => (v.trim() ? null : t.account.nameRequired) },
  });

  async function handleAvatar(file: File | null) {
    if (!file) return;
    if (file.size > MAX_AVATAR_BYTES) {
      notifications.show({ color: 'red', message: t.account.photoTooLarge });
      return;
    }
    setUploading(true);
    try {
      const { url, s3Key, mimeType } = await presignAvatarUpload({
        mimeType: file.type,
        bytes: file.size,
      });
      // Content-Type is part of the signature — send back the canonical type the
      // server signed, not the browser's raw `file.type`.
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': mimeType },
        body: file,
      });
      if (!res.ok) throw new Error(t.account.uploadFailed);
      await saveAvatar({ s3Key });
      notifications.show({ message: t.account.photoUpdated });
      router.refresh();
    } catch (e) {
      notifications.show({
        color: 'red',
        message: e instanceof Error ? e.message : t.account.couldNotUpdatePhoto,
      });
    } finally {
      setUploading(false);
    }
  }

  function handleSubmit(values: typeof form.values) {
    startTransition(async () => {
      try {
        await updateDisplayName({ name: values.name });
        notifications.show({ message: t.account.nameUpdated });
        form.resetDirty(values);
        router.refresh();
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : t.account.couldNotUpdateName,
        });
      }
    });
  }

  return (
    <Card withBorder radius="md" p="lg">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Group wrap="nowrap" align="center">
          <Avatar size={72} radius="xl" color="brand" src={avatarUrl}>
            {initials(name)}
          </Avatar>
          <Stack gap={4}>
            <FileButton onChange={handleAvatar} accept={PHOTO_ACCEPT}>
              {(props) => (
                <Button
                  {...props}
                  variant="default"
                  size="xs"
                  loading={uploading}
                  leftSection={<IconCamera size={14} />}
                >
                  {t.account.changePhoto}
                </Button>
              )}
            </FileButton>
            <Text size="xs" c="dimmed">
              {t.account.avatarHint}
            </Text>
          </Stack>
        </Group>
        <SignOutButton />
      </Group>

      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack mt="lg">
          <TextInput label={t.account.displayName} required {...form.getInputProps('name')} />
          <TextInput
            label={t.auth.email}
            value={email}
            disabled
            description={t.account.emailCantChange}
          />
          <Group justify="flex-end">
            <Button type="submit" loading={saving} disabled={!form.isDirty()}>
              {t.common.saveChanges}
            </Button>
          </Group>
        </Stack>
      </form>
    </Card>
  );
}
