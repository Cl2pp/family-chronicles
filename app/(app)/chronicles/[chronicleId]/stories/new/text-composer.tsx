'use client';

import { useState, useTransition } from 'react';
import { Button, Group, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { PhotoUploader } from '@/components/photo-uploader';
import { createTextStoryAction } from '../actions';
import { uploadImages } from '../upload-images';
import { DateField, type DatePayload } from './date-field';

export function TextComposer({ chronicleId }: { chronicleId: string }) {
  const [date, setDate] = useState<DatePayload>({ eventDate: null, eventDatePrecision: null });
  const [photos, setPhotos] = useState<File[]>([]);
  const [pending, startTransition] = useTransition();

  const form = useForm({
    initialValues: { title: '', body: '' },
    validate: {
      title: (v) => (v.trim().length > 0 ? null : 'Give the story a title'),
      body: (v) => (v.trim().length > 0 ? null : 'Write something first'),
    },
  });

  function handleSubmit(values: typeof form.values) {
    startTransition(async () => {
      try {
        const uploaded = photos.length ? await uploadImages(chronicleId, photos) : undefined;
        await createTextStoryAction({
          chronicleId,
          title: values.title,
          body: values.body,
          eventDate: date.eventDate,
          eventDatePrecision: date.eventDatePrecision,
          photos: uploaded,
        });
      } catch (err) {
        if (err && typeof err === 'object' && 'digest' in err) throw err;
        notifications.show({ color: 'red', message: 'Could not save the story' });
      }
    });
  }

  return (
    <form onSubmit={form.onSubmit(handleSubmit)}>
      <Stack>
        <TextInput
          label="Title"
          placeholder="The summer at the lake house"
          {...form.getInputProps('title')}
        />
        <Textarea
          label="The story"
          description="Tell it however it comes to you — we'll gently retell it in the family's voice."
          placeholder="Write the story here..."
          autosize
          minRows={8}
          {...form.getInputProps('body')}
        />
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
          <Button type="submit" loading={pending}>
            Save story
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
