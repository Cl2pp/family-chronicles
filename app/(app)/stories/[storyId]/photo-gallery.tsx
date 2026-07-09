'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  ActionIcon,
  Box,
  Button,
  Group,
  Image,
  Modal,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { IconChevronLeft, IconChevronRight, IconPencil } from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';
import { updatePhotoCaption } from './actions';

export interface GalleryPhoto {
  id: string;
  url: string;
  caption: string | null;
  width: number | null;
  height: number | null;
}

/** Grid of a story's photos; clicking one opens a lightbox with its caption. */
export function PhotoGallery({
  storyId,
  photos,
  canEdit,
  storyTitle,
}: {
  storyId: string;
  photos: GalleryPhoto[];
  canEdit: boolean;
  storyTitle: string;
}) {
  const { t } = useI18n();
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const active = openIndex === null ? null : photos[openIndex];

  function step(delta: number) {
    setOpenIndex((i) => (i === null ? null : (i + delta + photos.length) % photos.length));
  }

  return (
    <>
      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
        {photos.map((p, i) => (
          <Stack key={p.id} gap={4}>
            <UnstyledButton
              onClick={() => setOpenIndex(i)}
              aria-label={p.caption ?? t.story.viewPhoto}
            >
              <Image src={p.url} alt={p.caption ?? storyTitle} radius="md" fit="cover" h={200} />
            </UnstyledButton>
            {p.caption && (
              <Text size="sm" c="dimmed" lineClamp={2}>
                {p.caption}
              </Text>
            )}
          </Stack>
        ))}
      </SimpleGrid>

      <Modal
        opened={active !== null}
        onClose={() => setOpenIndex(null)}
        size="xl"
        centered
        withCloseButton={false}
        padding="xs"
        title={null}
      >
        {active && (
          <Stack gap="sm">
            <Box pos="relative">
              <Image
                src={active.url}
                alt={active.caption ?? storyTitle}
                fit="contain"
                mah="75vh"
                radius="sm"
                // Intrinsic dimensions (captured at upload) hold the box open while the
                // full-size image loads, so the caption and arrows don't jump.
                style={
                  active.width && active.height
                    ? { aspectRatio: `${active.width} / ${active.height}` }
                    : undefined
                }
              />
              {photos.length > 1 && (
                <>
                  <ActionIcon
                    variant="filled"
                    color="dark"
                    radius="xl"
                    pos="absolute"
                    left={8}
                    top="50%"
                    onClick={() => step(-1)}
                    aria-label={t.story.previousPhoto}
                  >
                    <IconChevronLeft size={18} />
                  </ActionIcon>
                  <ActionIcon
                    variant="filled"
                    color="dark"
                    radius="xl"
                    pos="absolute"
                    right={8}
                    top="50%"
                    onClick={() => step(1)}
                    aria-label={t.story.nextPhoto}
                  >
                    <IconChevronRight size={18} />
                  </ActionIcon>
                </>
              )}
            </Box>
            <CaptionRow
              key={active.id}
              storyId={storyId}
              photo={active}
              canEdit={canEdit}
              counter={photos.length > 1 ? `${(openIndex ?? 0) + 1} / ${photos.length}` : null}
            />
          </Stack>
        )}
      </Modal>
    </>
  );
}

/** The caption under the lightbox image — read-only, or an inline editor for editors. */
function CaptionRow({
  storyId,
  photo,
  canEdit,
  counter,
}: {
  storyId: string;
  photo: GalleryPhoto;
  canEdit: boolean;
  counter: string | null;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(photo.caption ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, startTransition] = useTransition();

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await updatePhotoCaption({ storyId, assetId: photo.id, caption: value });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  if (editing) {
    return (
      <Stack gap="xs">
        <TextInput
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          placeholder={t.story.captionPlaceholder}
          maxLength={280}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
        {error && (
          <Text size="sm" c="red">
            {error}
          </Text>
        )}
        <Group gap="xs">
          <Button size="xs" onClick={save} loading={saving}>
            {t.story.saveCaption}
          </Button>
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            onClick={() => {
              setValue(photo.caption ?? '');
              setEditing(false);
            }}
          >
            {t.common.cancel}
          </Button>
        </Group>
      </Stack>
    );
  }

  return (
    <Group justify="space-between" align="center" wrap="nowrap" gap="sm">
      <Text size="sm" c={photo.caption ? undefined : 'dimmed'} fs={photo.caption ? undefined : 'italic'}>
        {photo.caption ?? (canEdit ? t.story.noCaption : '')}
      </Text>
      <Group gap="xs" wrap="nowrap">
        {counter && (
          <Text size="xs" c="dimmed">
            {counter}
          </Text>
        )}
        {canEdit && (
          <ActionIcon
            variant="subtle"
            color="gray"
            onClick={() => setEditing(true)}
            aria-label={t.story.editCaption}
          >
            <IconPencil size={16} />
          </ActionIcon>
        )}
      </Group>
    </Group>
  );
}
