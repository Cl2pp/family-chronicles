'use client';

import { Button, Card, Group, Progress, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IconArrowRight, IconPhoto } from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';
import { BulkPhotoUploader } from '@/components/bulk-photo-uploader';
import { PhotoBookPhotoTile } from './photo-book-photo-tile';
import type { PhotoBookPhotoView } from './photo-book-builder';

/**
 * Step 1 — Upload (docs/PHOTO_BOOK_PLAN.md, builder restructure): the bulk uploader
 * (drag-and-drop + click-to-select, its own upload progress bar) and the full photo
 * grid with the analysis progress bar and the exclude/include toggle. The "Next" control
 * is gated on every photo being *settled* (scored or permanently failed —
 * `metaSettled`), so a partially-analyzed book never advances into step 2's auto-design
 * trigger on incomplete data.
 */
export function PhotoBookUploadStep({
  bookId,
  photos,
  locked,
  pending,
  onToggleExcluded,
  settledCount,
  totalCount,
  analysisComplete,
  onNext,
}: {
  bookId: string;
  photos: PhotoBookPhotoView[];
  locked: boolean;
  pending: boolean;
  onToggleExcluded: (assetId: string, excluded: boolean) => void;
  settledCount: number;
  totalCount: number;
  analysisComplete: boolean;
  onNext: () => void;
}) {
  const { t } = useI18n();
  const tp = t.books.builder.photoBook;
  const failedCount = photos.filter((p) => p.metaFailed).length;

  return (
    <Stack gap="md">
      {!locked && (
        <Card withBorder radius="md" p="md">
          <BulkPhotoUploader bookId={bookId} />
        </Card>
      )}

      <Card withBorder radius="md" p="md">
        <Group justify="space-between" mb="sm" wrap="wrap">
          <Title order={4}>{tp.photos}</Title>
          {totalCount > 0 && (
            <Text fz={13} c="dimmed">
              {tp.analyzedProgress(settledCount, totalCount)}
            </Text>
          )}
        </Group>
        {totalCount > 0 && (
          <Progress value={(settledCount / totalCount) * 100} size="sm" mb="sm" color={analysisComplete ? 'brand' : 'gray'} />
        )}
        {failedCount > 0 && (
          <Text fz={12} c="dimmed" mb="sm">
            {tp.someUnanalyzed(failedCount)}
          </Text>
        )}

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
              <PhotoBookPhotoTile
                key={p.assetId}
                photo={p}
                locked={locked}
                pending={pending}
                onToggleExcluded={onToggleExcluded}
                size="grid"
              />
            ))}
          </SimpleGrid>
        )}
      </Card>

      <Group justify="flex-end">
        <Stack gap={2} align="flex-end">
          {!analysisComplete && totalCount > 0 && (
            <Text fz={12} c="dimmed">
              {tp.waitingForAnalysis}
            </Text>
          )}
          <Button rightSection={<IconArrowRight size={16} />} disabled={!analysisComplete} onClick={onNext}>
            {tp.next}
          </Button>
        </Stack>
      </Group>
    </Stack>
  );
}
