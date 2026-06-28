'use client';

import { useState, useTransition } from 'react';
import { Button, Group, Stack, Text, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { AudioRecorder, type RecordedAudio } from '@/components/audio-recorder';
import { PhotoUploader } from '@/components/photo-uploader';
import { createUploadUrlAction, createVoiceStoryAction } from '../actions';
import { uploadImages } from '../upload-images';
import { DateField, type DatePayload } from './date-field';

function extFor(mime: string): string {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  return 'audio';
}

export function VoiceComposer({ chronicleId }: { chronicleId: string }) {
  const [date, setDate] = useState<DatePayload>({ eventDate: null, eventDatePrecision: null });
  const [audio, setAudio] = useState<RecordedAudio | null>(null);
  const [photos, setPhotos] = useState<File[]>([]);
  const [pending, startTransition] = useTransition();

  const form = useForm({
    initialValues: { title: '' },
    validate: { title: (v) => (v.trim().length > 0 ? null : 'Give the story a title') },
  });

  function handleSubmit(values: typeof form.values) {
    if (!audio) {
      notifications.show({ color: 'red', message: 'Record a message first' });
      return;
    }
    const contentType = audio.mimeType || 'application/octet-stream';

    startTransition(async () => {
      try {
        const { key, url } = await createUploadUrlAction({
          chronicleId,
          kind: 'audio',
          contentType,
          filename: `recording.${extFor(audio.mimeType)}`,
        });

        const put = await fetch(url, {
          method: 'PUT',
          body: audio.blob,
          headers: { 'Content-Type': contentType },
        });
        if (!put.ok) throw new Error('upload failed');

        const uploadedPhotos = photos.length ? await uploadImages(chronicleId, photos) : undefined;

        await createVoiceStoryAction({
          chronicleId,
          title: values.title,
          eventDate: date.eventDate,
          eventDatePrecision: date.eventDatePrecision,
          s3Key: key,
          mimeType: audio.mimeType || 'audio/webm',
          bytes: audio.blob.size,
          durationSec: audio.durationSec,
          photos: uploadedPhotos,
        });
      } catch (err) {
        if (err && typeof err === 'object' && 'digest' in err) throw err;
        notifications.show({ color: 'red', message: 'Could not save the recording' });
      }
    });
  }

  return (
    <form onSubmit={form.onSubmit(handleSubmit)}>
      <Stack>
        <TextInput
          label="Title"
          placeholder="Grandpa's story about the farm"
          {...form.getInputProps('title')}
        />
        <div>
          <Text size="sm" fw={500} mb={4}>
            Recording
          </Text>
          <Text size="xs" c="dimmed" mb="xs">
            Speak the story aloud — we&rsquo;ll transcribe it and retell it in the family&rsquo;s
            voice.
          </Text>
          <AudioRecorder onChange={setAudio} />
        </div>
        <div>
          <Text size="sm" fw={500} mb={4}>
            Photos (optional)
          </Text>
          <PhotoUploader files={photos} onChange={setPhotos} />
        </div>
        <DateField onChange={setDate} />
        <Group justify="flex-end" mt="sm">
          <Button component="a" href={`/chronicles/${chronicleId}`} variant="default">
            Cancel
          </Button>
          <Button type="submit" loading={pending} disabled={!audio}>
            Save recording
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
