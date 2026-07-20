'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Image,
  Modal,
  Overlay,
  SimpleGrid,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconArrowLeft, IconEye, IconEyeOff, IconPhoto, IconTrash } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useI18n } from '@/lib/i18n/client';
import { BulkPhotoUploader } from '@/components/bulk-photo-uploader';
import { deleteBookAction, setPhotoExcludedAction } from '../actions';

export interface PhotoBookPhotoView {
  assetId: string;
  url: string;
  excluded: boolean;
  /** True once the `photo-meta` job has recorded this photo's perceptual hash. */
  analyzed: boolean;
}

interface PhotoBookInfo {
  id: string;
  title: string;
  status: 'draft' | 'rendering' | 'preview_ready' | 'render_failed' | 'ordered';
}

/**
 * The photo-book builder (PR 1 scope): bulk upload + a grid to review what's in the
 * book so far, with an exclude/include toggle and an analysis-progress indicator.
 * Layout/preview/PDF are later PRs — this view only manages the photo set itself.
 */
export function PhotoBookBuilder({
  book,
  photos,
}: {
  book: PhotoBookInfo;
  photos: PhotoBookPhotoView[];
}) {
  const { t } = useI18n();
  const tb = t.books.builder;
  const tp = tb.photoBook;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const locked = book.status === 'ordered';
  const totalCount = photos.length;
  const analyzedCount = photos.filter((p) => p.analyzed).length;

  // Analysis runs server-side (the `photo-meta` worker job) with no other signal the
  // client can see — poll while photos are still unanalyzed, same pattern as the
  // story-book builder's "designing" poll (book-builder.tsx).
  useEffect(() => {
    if (totalCount === 0 || analyzedCount >= totalCount) return;
    const timer = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(timer);
  }, [totalCount, analyzedCount, router]);

  function toggleExcluded(assetId: string, excluded: boolean) {
    startTransition(async () => {
      const result = await setPhotoExcludedAction({ bookId: book.id, assetId, excluded });
      if (result.error) {
        notifications.show({ message: result.error, color: 'red' });
        return;
      }
      router.refresh();
    });
  }

  function confirmDelete() {
    startTransition(async () => {
      const result = await deleteBookAction(book.id);
      if (result.error) {
        setDeleteOpen(false);
        notifications.show({ message: result.error, color: 'red' });
        return;
      }
      router.push('/books');
    });
  }

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap">
        <Group gap="sm">
          <Anchor component={Link} href="/books" fz={13} c="dimmed">
            <Group gap={4}>
              <IconArrowLeft size={14} />
              {tb.backToBooks}
            </Group>
          </Anchor>
          <Title order={2}>{book.title}</Title>
          <Badge variant="light">{t.books.status[book.status]}</Badge>
        </Group>
        {!locked && (
          <Tooltip label={tb.deleteBook}>
            <ActionIcon
              variant="subtle"
              color="red"
              size="lg"
              aria-label={tb.deleteBook}
              disabled={pending}
              onClick={() => setDeleteOpen(true)}
            >
              <IconTrash size={18} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>

      {!locked && (
        <Card withBorder radius="md" p="md">
          <BulkPhotoUploader bookId={book.id} />
        </Card>
      )}

      <Card withBorder radius="md" p="md">
        <Group justify="space-between" mb="sm" wrap="wrap">
          <Title order={4}>{tp.photos}</Title>
          {totalCount > 0 && (
            <Text fz={13} c="dimmed">
              {tp.analyzedProgress(analyzedCount, totalCount)}
            </Text>
          )}
        </Group>

        {totalCount === 0 ? (
          <Stack align="center" gap={4} py="xl">
            <IconPhoto size={28} stroke={1.4} color="var(--mantine-color-slate-4)" />
            <Text c="dimmed" ta="center">
              {tp.noPhotosYet}
            </Text>
            <Text fz={12} c="dimmed" ta="center">
              {tp.noPhotosHint}
            </Text>
          </Stack>
        ) : (
          <SimpleGrid cols={{ base: 2, xs: 3, sm: 4, md: 5 }} spacing="xs">
            {photos.map((p) => (
              <Box key={p.assetId} pos="relative">
                <Card
                  withBorder
                  p={0}
                  radius="sm"
                  style={{ overflow: 'hidden', aspectRatio: '1 / 1' }}
                >
                  <Image src={p.url} alt="" w="100%" h="100%" fit="cover" />
                  {p.excluded && <Overlay color="#000" backgroundOpacity={0.5} />}
                </Card>
                {!locked && (
                  <Tooltip label={p.excluded ? tp.include : tp.exclude}>
                    <ActionIcon
                      variant="filled"
                      color={p.excluded ? 'gray' : 'dark'}
                      size="sm"
                      radius="xl"
                      aria-label={p.excluded ? tp.include : tp.exclude}
                      disabled={pending}
                      style={{ position: 'absolute', top: 4, right: 4 }}
                      onClick={() => toggleExcluded(p.assetId, !p.excluded)}
                    >
                      {p.excluded ? <IconEye size={14} /> : <IconEyeOff size={14} />}
                    </ActionIcon>
                  </Tooltip>
                )}
                {!p.analyzed && (
                  <Badge
                    size="xs"
                    variant="light"
                    color="gray"
                    style={{ position: 'absolute', bottom: 4, left: 4 }}
                  >
                    {tp.analyzing}
                  </Badge>
                )}
              </Box>
            ))}
          </SimpleGrid>
        )}
      </Card>

      <Modal
        opened={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={tb.deleteConfirmTitle}
        centered
      >
        <Text size="sm">{tb.deleteConfirmBody}</Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={() => setDeleteOpen(false)} disabled={pending}>
            {t.common.cancel}
          </Button>
          <Button color="red" onClick={confirmDelete} loading={pending}>
            {tb.deleteConfirm}
          </Button>
        </Group>
      </Modal>
    </Stack>
  );
}
