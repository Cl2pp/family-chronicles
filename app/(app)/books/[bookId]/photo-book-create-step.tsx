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
  Loader,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
  useMantineTheme,
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
  IconSettings,
  IconSparkles,
} from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';
import { PHOTO_BOOK_STYLES, type PhotoBookStyle } from '@/lib/photo-book-plan';
import type { BookCoverType, BookFormat } from '@/lib/gelato';
import { PhotoBookChat } from './photo-book-chat';
import { PhotoBookPhotoTile } from './photo-book-photo-tile';
import type { PhotoBookInfo, PhotoBookPhotoView } from './photo-book-builder';

/** Trim aspect ratio (width / height) per format — a client-safe duplicate of the
 *  width/height pairs in `TRIM` (`lib/book-content.ts`), which can't be imported here: it
 *  pulls in `sharp`/`drizzle`/server-only code. Only the ratio is needed client-side, to
 *  size the preview iframe (see its `aspectRatio` style, below) so exactly one full page
 *  fits — the iframe used to be a fixed `height: 560`, showing a cropped, native-size
 *  top-left corner of page one instead of the whole page; `fitPages()` in
 *  `lib/photo-book-layout.ts` does the matching client-side zoom-to-fit inside whatever
 *  height this aspect ratio produces. */
const TRIM_ASPECT: Record<BookFormat, number> = {
  'hardcover-21x28': 210 / 280,
  'hardcover-20x20': 200 / 200,
};

type SettingsPatch = {
  title?: string;
  subtitle?: string | null;
  format?: BookFormat;
  coverType?: BookCoverType;
};

/**
 * The config panel — style suite, cover type, size, and front-cover title/subtitle
 * (docs/PHOTO_BOOK_PLAN.md builder restructure PR6). Shown full-size before the book has
 * ever been generated (`PhotoBookCreateStep`'s "not generated yet" view) and again, for
 * tweaking, inside the settings `Modal` once it has. Text fields save on blur (same
 * "local draft + onBlur commit" pattern as the story builder's settings card,
 * `book-builder.tsx`) so typing doesn't fire a server action per keystroke; the
 * style/cover-type/size controls save immediately on click, same as the style picker
 * always did.
 */
function PhotoBookConfigPanel({
  book,
  locked,
  pending,
  onSetStyle,
  onUpdateSettings,
}: {
  book: PhotoBookInfo;
  locked: boolean;
  pending: boolean;
  onSetStyle: (style: PhotoBookStyle) => void;
  onUpdateSettings: (patch: SettingsPatch) => void;
}) {
  const { t } = useI18n();
  const tp = t.books.builder.photoBook;
  const tc = tp.config;
  // Local draft + onBlur commit, initialized from the book — same pattern (and the same
  // "doesn't re-sync from an external change after mount" tradeoff) as the story
  // builder's settings card (`book-builder.tsx`'s `title`/`subtitle` state).
  const [title, setTitle] = useState(book.title);
  const [subtitle, setSubtitle] = useState(book.subtitle ?? '');

  const disabled = locked || pending;

  return (
    <Stack gap="md">
      <TextInput
        label={tc.bookTitle}
        value={title}
        disabled={disabled}
        onChange={(e) => setTitle(e.currentTarget.value)}
        onBlur={() => title.trim() && title !== book.title && onUpdateSettings({ title })}
      />
      <TextInput
        label={tc.subtitle}
        value={subtitle}
        disabled={disabled}
        onChange={(e) => setSubtitle(e.currentTarget.value)}
        onBlur={() =>
          subtitle !== (book.subtitle ?? '') && onUpdateSettings({ subtitle: subtitle || null })
        }
      />
      <Box>
        <Text fz={13} fw={500} mb={6}>
          {tp.style}
        </Text>
        <Group gap={8}>
          {PHOTO_BOOK_STYLES.map((style) => (
            <Button
              key={style}
              size="compact-sm"
              variant={style === book.style ? 'filled' : 'default'}
              disabled={disabled}
              onClick={() => onSetStyle(style)}
            >
              {tp.styleNames[style]}
            </Button>
          ))}
        </Group>
      </Box>
      <Box>
        <Text fz={13} fw={500} mb={6}>
          {tc.coverType}
        </Text>
        <Group gap={8}>
          {(['hardcover', 'softcover'] as const).map((coverType) => (
            <Button
              key={coverType}
              size="compact-sm"
              variant={coverType === book.coverType ? 'filled' : 'default'}
              disabled={disabled}
              onClick={() => coverType !== book.coverType && onUpdateSettings({ coverType })}
            >
              {tc.coverTypeOptions[coverType]}
            </Button>
          ))}
        </Group>
      </Box>
      <Select
        label={tc.size}
        value={book.format}
        disabled={disabled}
        data={[
          { value: 'hardcover-21x28', label: tc.sizeOptions['hardcover-21x28'] },
          { value: 'hardcover-20x20', label: tc.sizeOptions['hardcover-20x20'] },
        ]}
        onChange={(v) => v && v !== book.format && onUpdateSettings({ format: v as BookFormat })}
        allowDeselect={false}
      />
    </Stack>
  );
}

/**
 * Step 2 — Create (docs/PHOTO_BOOK_PLAN.md, builder restructure PR6: "configure →
 * generate → book"). Gated on `book.generatedAt`:
 *
 * - **Not generated yet** (`generatedAt == null`): the config panel (style, cover type,
 *   size, title/subtitle) is front and center with the "Create book" CTA; the book area
 *   on the right shows a placeholder, or a spinner while the first design pass is
 *   running (`book.designing`). No chat, no tray — there's no book yet to edit.
 * - **Generated**: the familiar layout returns — collapsible AI chat on the left, live
 *   preview on the right, photo tray along the bottom — plus a settings (gear) button on
 *   the preview card that reopens the same config panel in a `Modal`, alongside the
 *   "Design again" / "Regenerate" affordances for an explicit re-run.
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
  onCreateBook,
  onDesignBook,
  onSetStyle,
  onUpdateSettings,
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
  onCreateBook: () => void;
  onDesignBook: () => void;
  onSetStyle: (style: PhotoBookStyle) => void;
  onUpdateSettings: (patch: SettingsPatch) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const { t } = useI18n();
  const tb = t.books.builder;
  const tp = tb.photoBook;
  const theme = useMantineTheme();
  // Desktop gets the full 3-pane layout (chat | preview, tray below); narrower than this
  // the chat pane moves into a Drawer instead of fighting the preview for width. Driven
  // off `theme.breakpoints.md` (992px) so this exactly matches the `Flex` below's
  // `md: 'row'` breakpoint — a hardcoded 900px here previously created a 900–992px
  // dead-band where `isDesktop` was already true (fixed sidebar `Box` rendered) but the
  // `Flex` was still `column`, breaking the layout.
  const isDesktop = useMediaQuery(`(min-width: ${theme.breakpoints.md})`, true);
  const [chatCollapsed, setChatCollapsed] = useLocalStorage<boolean>({
    key: 'photobook-chat-collapsed',
    defaultValue: false,
  });
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const hasGenerated = book.generatedAt != null;
  const chatPane = <PhotoBookChat bookId={bookId} locked={locked} />;

  /** The book area (right pane in both states): a spinner while a design pass is in
   *  flight, the placeholder before the book has ever been generated, or the live
   *  preview iframe once it has. */
  const bookArea = book.designing ? (
    <Stack align="center" gap={8} py="xl">
      <Loader size="md" />
      <Text c="dimmed" ta="center">
        {tp.bookAreaGenerating}
      </Text>
    </Stack>
  ) : !hasGenerated ? (
    <Stack align="center" gap={4} py="xl">
      <IconPhoto size={28} stroke={1.4} color="var(--mantine-color-slate-4)" />
      <Text c="dimmed" ta="center">
        {tp.bookAreaPlaceholder}
      </Text>
    </Stack>
  ) : (
    <Box
      component="iframe"
      key={book.previewVersion}
      src={`/api/books/${book.id}/preview-html?v=${book.previewVersion}`}
      style={{
        width: '100%',
        // Sized to the book's own trim aspect ratio (not a fixed height) so the iframe's
        // shape roughly matches one page — the injected `fitPages()` script
        // (`lib/photo-book-layout.ts`) then zooms the page stack to fit exactly within
        // whatever height that produces, so a whole page is visible instead of a
        // native-size crop of its top-left corner. `maxHeight` keeps a portrait trim from
        // growing the iframe absurdly tall on a wide desktop pane — `fitPages` still fits
        // one full page inside whatever height results (it takes the min of width- and
        // height-fit), so capping this never re-introduces cropping.
        aspectRatio: TRIM_ASPECT[book.format],
        maxHeight: '75vh',
        border: '1px solid var(--mantine-color-slate-2)',
        borderRadius: 8,
        background: '#fff',
      }}
      title={tp.preview}
    />
  );

  if (!hasGenerated) {
    return (
      <Stack gap="md">
        <Flex direction={{ base: 'column', md: 'row' }} gap="md" align="stretch">
          <Box w={{ base: '100%', md: 380 }} style={{ flexShrink: 0 }}>
            <Card withBorder radius="md" p="md">
              <Title order={4} mb={4}>
                {tp.config.title}
              </Title>
              <Text fz={13} c="dimmed" mb="md">
                {tp.config.intro}
              </Text>
              <PhotoBookConfigPanel
                book={book}
                locked={locked}
                pending={pending}
                onSetStyle={onSetStyle}
                onUpdateSettings={onUpdateSettings}
              />
              <Button
                fullWidth
                mt="md"
                leftSection={<IconSparkles size={16} />}
                loading={book.designing || designPending}
                disabled={locked || photos.length === 0}
                onClick={onCreateBook}
              >
                {book.designing ? tp.config.creating : tp.config.createBook}
              </Button>
            </Card>
          </Box>

          <Box style={{ flex: 1, minWidth: 0 }}>
            <Card withBorder radius="md" p="md" h="100%">
              <Title order={4} mb="sm">
                {tp.preview}
              </Title>
              {bookArea}
            </Card>
          </Box>
        </Flex>

        <Group justify="space-between">
          <Button variant="default" leftSection={<IconArrowLeft size={16} />} onClick={onBack}>
            {tp.back}
          </Button>
          <Stack gap={2} align="flex-end">
            <Text fz={12} c="dimmed">
              {tp.waitingForGeneration}
            </Text>
            <Button rightSection={<IconArrowRight size={16} />} disabled onClick={onNext}>
              {tp.next}
            </Button>
          </Stack>
        </Group>
      </Stack>
    );
  }

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
              <Group gap={4}>
                <Anchor href={`/api/books/${book.id}/preview-html`} target="_blank" fz={13}>
                  <Group gap={4}>
                    <IconExternalLink size={14} />
                    {tb.openInNewTab}
                  </Group>
                </Anchor>
                <Tooltip label={tp.settings}>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    aria-label={tp.settings}
                    onClick={() => setSettingsOpen(true)}
                  >
                    <IconSettings size={16} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Group>
            <Text fz={12} c="dimmed" mb="sm">
              {tp.previewHint}
            </Text>

            {bookArea}
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

      <Modal
        opened={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title={tp.settingsModalTitle}
        centered
      >
        <PhotoBookConfigPanel
          book={book}
          locked={locked}
          pending={pending}
          onSetStyle={onSetStyle}
          onUpdateSettings={onUpdateSettings}
        />
        <Group mt="lg" wrap="wrap">
          <Tooltip label={tb.designBookHint} disabled={locked}>
            <Button
              variant="light"
              size="sm"
              leftSection={<IconSparkles size={16} />}
              loading={book.designing || designPending}
              disabled={locked || photos.length === 0}
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
      </Modal>
    </Stack>
  );
}
