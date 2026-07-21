'use client';

import { useState } from 'react';
import {
  ActionIcon,
  Anchor,
  Box,
  Button,
  Card,
  Drawer,
  Flex,
  Group,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { useMediaQuery, useLocalStorage } from '@mantine/hooks';
import {
  IconArrowLeft,
  IconArrowRight,
  IconExternalLink,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconMessageCircle,
  IconPhoto,
  IconSparkles,
} from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';
import { PHOTO_BOOK_STYLES, type PhotoBookStyle } from '@/lib/photo-book-plan';
import { PhotoBookChat } from './photo-book-chat';
import { PhotoBookPhotoTile } from './photo-book-photo-tile';
import type { PhotoBookInfo, PhotoBookPhotoView } from './photo-book-builder';

/** Desktop gets the full 3-pane layout (chat | preview, tray below); narrower than this
 *  the chat pane moves into a Drawer instead of fighting the preview for width. */
const DESKTOP_QUERY = '(min-width: 900px)';

/**
 * Step 2 — Create (docs/PHOTO_BOOK_PLAN.md, builder restructure): the AI chat on the
 * left (collapsible, so the preview can take the full width), the live book preview on
 * the right, and a horizontal tray of every uploaded photo along the bottom (exclude/
 * include toggle included — bug fix C). On narrow screens the chat moves into a Drawer
 * behind a "Show AI chat" button instead of squeezing three columns into one viewport.
 */
export function PhotoBookCreateStep({
  bookId,
  book,
  photos,
  locked,
  pending,
  onToggleExcluded,
  regenerating,
  onRegenerate,
  designPending,
  onDesignBook,
  onSetStyle,
  onBack,
  onNext,
}: {
  bookId: string;
  book: PhotoBookInfo;
  photos: PhotoBookPhotoView[];
  locked: boolean;
  pending: boolean;
  onToggleExcluded: (assetId: string, excluded: boolean) => void;
  regenerating: boolean;
  onRegenerate: () => void;
  designPending: boolean;
  onDesignBook: () => void;
  onSetStyle: (style: PhotoBookStyle) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const { t } = useI18n();
  const tb = t.books.builder;
  const tp = tb.photoBook;
  const isDesktop = useMediaQuery(DESKTOP_QUERY, true);
  const [chatCollapsed, setChatCollapsed] = useLocalStorage<boolean>({
    key: 'photobook-chat-collapsed',
    defaultValue: false,
  });
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const settledCount = photos.filter((p) => p.metaSettled).length;

  const chatPane = <PhotoBookChat bookId={bookId} locked={locked} />;

  return (
    <Stack gap="md">
      <Flex direction={{ base: 'column', md: 'row' }} gap="md" align="stretch">
        {isDesktop ? (
          <Box w={chatCollapsed ? 56 : 380} style={{ flexShrink: 0 }}>
            {chatCollapsed ? (
              <Card
                withBorder
                radius="md"
                p={8}
                h="100%"
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}
              >
                <Tooltip label={tp.expandChat} position="right">
                  <ActionIcon
                    variant="subtle"
                    aria-label={tp.expandChat}
                    onClick={() => setChatCollapsed(false)}
                  >
                    <IconLayoutSidebarLeftExpand size={18} />
                  </ActionIcon>
                </Tooltip>
                <IconSparkles size={16} color="var(--mantine-color-slate-5)" />
              </Card>
            ) : (
              <Stack gap={4} h="100%">
                <Group justify="flex-end">
                  <Tooltip label={tp.collapseChat}>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label={tp.collapseChat}
                      onClick={() => setChatCollapsed(true)}
                    >
                      <IconLayoutSidebarLeftCollapse size={18} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
                {chatPane}
              </Stack>
            )}
          </Box>
        ) : (
          <Button
            variant="light"
            leftSection={<IconMessageCircle size={16} />}
            onClick={() => setMobileChatOpen(true)}
          >
            {tp.showChatMobile}
          </Button>
        )}

        <Box style={{ flex: 1, minWidth: 0 }}>
          <Card withBorder radius="md" p="md">
            <Group justify="space-between" mb="sm" wrap="wrap">
              <Title order={4}>{tp.preview}</Title>
              <Anchor href={`/api/books/${book.id}/preview-html`} target="_blank" fz={13}>
                <Group gap={4}>
                  <IconExternalLink size={14} />
                  {tb.openInNewTab}
                </Group>
              </Anchor>
            </Group>
            <Text fz={12} c="dimmed" mb="sm">
              {tp.previewHint}
            </Text>

            <Text fz={13} fw={500} mb={6}>
              {tp.style}
            </Text>
            <Group gap={8} mb="md">
              {PHOTO_BOOK_STYLES.map((style) => (
                <Button
                  key={style}
                  size="compact-sm"
                  variant={style === book.style ? 'filled' : 'default'}
                  disabled={locked || pending}
                  onClick={() => onSetStyle(style)}
                >
                  {tp.styleNames[style]}
                </Button>
              ))}
            </Group>

            <Group mb="sm">
              <Tooltip label={tb.designBookHint} disabled={locked}>
                <Button
                  variant="light"
                  size="sm"
                  leftSection={<IconSparkles size={16} />}
                  loading={book.designing}
                  disabled={locked || photos.length === 0 || designPending}
                  onClick={onDesignBook}
                >
                  {book.designing ? tb.designingBook : tb.designBook}
                </Button>
              </Tooltip>
              <Tooltip label={tp.regenerateHint} disabled={locked}>
                <Button
                  variant="light"
                  size="sm"
                  leftSection={<IconSparkles size={16} />}
                  loading={regenerating}
                  disabled={locked || photos.length === 0}
                  onClick={onRegenerate}
                >
                  {regenerating ? tp.regenerating : tp.regenerate}
                </Button>
              </Tooltip>
            </Group>

            {settledCount > 0 ? (
              <Box
                component="iframe"
                key={book.previewVersion}
                src={`/api/books/${book.id}/preview-html?v=${book.previewVersion}`}
                style={{
                  width: '100%',
                  height: 560,
                  border: '1px solid var(--mantine-color-slate-2)',
                  borderRadius: 8,
                  background: '#fff',
                }}
                title={tp.preview}
              />
            ) : (
              <Stack align="center" gap={4} py="xl">
                <IconPhoto size={28} stroke={1.4} color="var(--mantine-color-slate-4)" />
                <Text c="dimmed" ta="center">
                  {tp.waitingForPhotos}
                </Text>
              </Stack>
            )}
          </Card>
        </Box>
      </Flex>

      <Card withBorder radius="md" p="md">
        <Title order={5} mb="xs">
          {tp.photos}
        </Title>
        <Group wrap="nowrap" gap="xs" style={{ overflowX: 'auto', paddingBottom: 4 }}>
          {photos.map((p) => (
            <PhotoBookPhotoTile
              key={p.assetId}
              photo={p}
              locked={locked}
              pending={pending}
              onToggleExcluded={onToggleExcluded}
              size="tray"
            />
          ))}
        </Group>
      </Card>

      <Group justify="space-between">
        <Button variant="default" leftSection={<IconArrowLeft size={16} />} onClick={onBack}>
          {tp.back}
        </Button>
        <Button rightSection={<IconArrowRight size={16} />} onClick={onNext}>
          {tp.next}
        </Button>
      </Group>

      <Drawer
        opened={!isDesktop && mobileChatOpen}
        onClose={() => setMobileChatOpen(false)}
        position="right"
        size="xl"
        title={tp.chat.title}
      >
        {chatPane}
      </Drawer>
    </Stack>
  );
}
