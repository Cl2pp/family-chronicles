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
import { presignAvatarUpload, saveAvatar, updateDisplayName } from './actions';
import { SignOutButton } from './sign-out-button';

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

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
  const [uploading, setUploading] = useState(false);
  const [saving, startTransition] = useTransition();
  const form = useForm({
    initialValues: { name },
    validate: { name: (v) => (v.trim() ? null : 'A name is required') },
  });

  async function handleAvatar(file: File | null) {
    if (!file) return;
    if (file.size > MAX_AVATAR_BYTES) {
      notifications.show({ color: 'red', message: 'Photos can be at most 5 MB.' });
      return;
    }
    setUploading(true);
    try {
      const { url, s3Key } = await presignAvatarUpload({
        mimeType: file.type,
        filename: file.name,
      });
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!res.ok) throw new Error('Upload failed');
      await saveAvatar({ s3Key });
      notifications.show({ message: 'Photo updated' });
      router.refresh();
    } catch (e) {
      notifications.show({
        color: 'red',
        message: e instanceof Error ? e.message : 'Could not update the photo',
      });
    } finally {
      setUploading(false);
    }
  }

  function handleSubmit(values: typeof form.values) {
    startTransition(async () => {
      try {
        await updateDisplayName({ name: values.name });
        notifications.show({ message: 'Name updated' });
        form.resetDirty(values);
        router.refresh();
      } catch (e) {
        notifications.show({
          color: 'red',
          message: e instanceof Error ? e.message : 'Could not update the name',
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
            <FileButton onChange={handleAvatar} accept="image/png,image/jpeg,image/webp">
              {(props) => (
                <Button
                  {...props}
                  variant="default"
                  size="xs"
                  loading={uploading}
                  leftSection={<IconCamera size={14} />}
                >
                  Change photo
                </Button>
              )}
            </FileButton>
            <Text size="xs" c="dimmed">
              Also used for you in the family tree.
            </Text>
          </Stack>
        </Group>
        <SignOutButton />
      </Group>

      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack mt="lg">
          <TextInput label="Display name" required {...form.getInputProps('name')} />
          <TextInput
            label="Email"
            value={email}
            disabled
            description="Email can't be changed"
          />
          <Group justify="flex-end">
            <Button type="submit" loading={saving} disabled={!form.isDirty()}>
              Save changes
            </Button>
          </Group>
        </Stack>
      </form>
    </Card>
  );
}
