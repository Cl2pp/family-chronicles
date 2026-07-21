'use client';

import { Badge, Box, Card, Image, Overlay } from '@mantine/core';
import { ActionIcon, Tooltip } from '@mantine/core';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';
import type { PhotoBookPhotoView } from './photo-book-builder';

/**
 * One photo tile — the exclude/include toggle plus the analyzing/failed badges (bug fix
 * C: "the image tray in step 2 (and the grid in step 1) must let the user BOTH exclude
 * and re-include, wired to the fixed `setPhotoExcluded`"). Shared by the step 1 grid and
 * the step 2 bottom tray so the two only ever differ in size/layout, never in behavior.
 */
export function PhotoBookPhotoTile({
  photo,
  locked,
  pending,
  onToggleExcluded,
  size,
}: {
  photo: PhotoBookPhotoView;
  locked: boolean;
  pending: boolean;
  onToggleExcluded: (assetId: string, excluded: boolean) => void;
  /** `grid` (step 1's responsive grid) or `tray` (step 2's fixed-size horizontal strip). */
  size: 'grid' | 'tray';
}) {
  const { t } = useI18n();
  const tp = t.books.builder.photoBook;
  const boxProps = size === 'tray' ? { w: 96, h: 96, style: { flex: '0 0 auto' } } : { style: { aspectRatio: '1 / 1' } };

  return (
    <Box pos="relative" {...boxProps}>
      <Card withBorder p={0} radius="sm" style={{ overflow: 'hidden', width: '100%', height: '100%' }}>
        <Image src={photo.url} alt="" w="100%" h="100%" fit="cover" />
        {photo.excluded && <Overlay color="#000" backgroundOpacity={0.5} />}
      </Card>
      {!locked && (
        <Tooltip label={photo.excluded ? tp.include : tp.exclude}>
          <ActionIcon
            variant="filled"
            color={photo.excluded ? 'gray' : 'dark'}
            size="sm"
            radius="xl"
            aria-label={photo.excluded ? tp.include : tp.exclude}
            disabled={pending}
            style={{ position: 'absolute', top: 4, right: 4 }}
            onClick={() => onToggleExcluded(photo.assetId, !photo.excluded)}
          >
            {photo.excluded ? <IconEye size={14} /> : <IconEyeOff size={14} />}
          </ActionIcon>
        </Tooltip>
      )}
      {!photo.metaSettled && (
        <Badge size="xs" variant="light" color="gray" style={{ position: 'absolute', bottom: 4, left: 4 }}>
          {tp.analyzing}
        </Badge>
      )}
      {photo.metaFailed && (
        <Badge size="xs" variant="light" color="red" style={{ position: 'absolute', bottom: 4, left: 4 }}>
          {tp.analysisFailed}
        </Badge>
      )}
    </Box>
  );
}
