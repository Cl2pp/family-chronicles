'use client';

import { useRef, useState } from 'react';
import { Button, Text } from '@mantine/core';
import { IconPhotoPlus } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n/client';
import { addStoryPhotos, presignStoryPhotoUpload } from './actions';

/** Picks photos, uploads them straight to storage, then attaches them to the story. */
export function AddPhotosControl({ storyId }: { storyId: string }) {
  const router = useRouter();
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    const chosen = Array.from(files).slice(0, 20);
    setBusy(true);
    setError(null);
    try {
      const uploaded = await Promise.all(
        chosen.map(async (file) => {
          const { url, s3Key } = await presignStoryPhotoUpload({
            storyId,
            mimeType: file.type,
            filename: file.name,
          });
          const res = await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': file.type },
            body: file,
          });
          if (!res.ok) throw new Error(t.story.photoUploadFailed);
          return { s3Key, mimeType: file.type, bytes: file.size };
        }),
      );
      const result = await addStoryPhotos({ storyId, photos: uploaded });
      if (!result.ok) throw new Error(result.error);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.story.photoUploadFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void upload(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
      />
      <Button
        size="xs"
        variant="light"
        leftSection={<IconPhotoPlus size={14} />}
        loading={busy}
        onClick={() => fileRef.current?.click()}
      >
        {t.story.addPhotos}
      </Button>
      {error && (
        <Text size="sm" c="red">
          {error}
        </Text>
      )}
    </>
  );
}
