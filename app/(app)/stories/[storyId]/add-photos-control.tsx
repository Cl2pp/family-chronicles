'use client';

import { useRef, useState } from 'react';
import { Button, Text } from '@mantine/core';
import { IconPhotoPlus } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n/client';
import { PHOTO_ACCEPT, readDimensions } from '@/lib/uploads';
import { addStoryPhotos, presignStoryPhotoUpload } from './actions';

/** Photos attachable in one go. */
const MAX_PHOTOS = 20;

/** Picks photos, uploads them straight to storage, then attaches them to the story. */
export function AddPhotosControl({ storyId }: { storyId: string }) {
  const router = useRouter();
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    const chosen = Array.from(files).slice(0, MAX_PHOTOS);
    setBusy(true);
    setError(null);
    try {
      const uploaded = await Promise.all(
        chosen.map(async (file) => {
          const [{ url, s3Key, mimeType }, size] = await Promise.all([
            presignStoryPhotoUpload({ storyId, mimeType: file.type, bytes: file.size }),
            readDimensions(file),
          ]);
          // Content-Type and Content-Length are both signed — echo what the server chose.
          const res = await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': mimeType },
            body: file,
          });
          if (!res.ok) throw new Error(t.story.photoUploadFailed);
          return {
            s3Key,
            mimeType,
            bytes: file.size,
            width: size?.width,
            height: size?.height,
          };
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
        accept={PHOTO_ACCEPT}
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
