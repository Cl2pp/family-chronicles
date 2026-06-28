'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Group, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { PhotoUploader } from '@/components/photo-uploader';
import { uploadImages } from '../upload-images';
import { addPhotosAction } from '../actions';

export function AddPhotos({ chronicleId, storyId }: { chronicleId: string; storyId: string }) {
  const [files, setFiles] = useState<File[]>([]);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function submit() {
    if (files.length === 0) return;
    startTransition(async () => {
      try {
        const photos = await uploadImages(chronicleId, files);
        await addPhotosAction({ chronicleId, storyId, photos });
        setFiles([]);
        router.refresh();
        notifications.show({ color: 'teal', message: 'Photos added' });
      } catch {
        notifications.show({ color: 'red', message: 'Could not add photos' });
      }
    });
  }

  return (
    <Stack gap="xs">
      <PhotoUploader files={files} onChange={setFiles} />
      {files.length > 0 && (
        <Group justify="flex-end">
          <Button size="xs" onClick={submit} loading={pending}>
            Add {files.length} photo{files.length > 1 ? 's' : ''}
          </Button>
        </Group>
      )}
    </Stack>
  );
}
