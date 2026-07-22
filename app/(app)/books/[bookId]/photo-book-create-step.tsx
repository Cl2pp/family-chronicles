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
  IconCircle,
  IconCircleCheck,
  IconExternalLink,
  IconInfoCircle,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconMessageCircle,
  IconPhoto,
  IconSettings,
  IconSparkles,
} from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';
import { PHOTO_BOOK_STYLES, type PhotoBookStyle } from '@/lib/photo-book-plan';
import {
  designStageIndex,
  PHOTO_BOOK_DESIGN_STAGES,
  type PhotoBookDesignStage,
} from '@/lib/photo-book-design-stage';
import {
  groupingCoverage,
  PHOTO_BOOK_GROUPINGS,
  type PhotoBookGrouping,
} from '@/lib/photo-book-grouping';
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
  dedication?: string | null;
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
  photos,
  locked,
  pending,
  onSetStyle,
  onSetGrouping,
  onUpdateSettings,
}: {
  book: PhotoBookInfo;
  photos: PhotoBookPhotoView[];
  locked: boolean;
  pending: boolean;
  onSetStyle: (style: PhotoBookStyle) => void;
  onSetGrouping: (grouping: PhotoBookGrouping) => void;
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
  const [dedication, setDedication] = useState(book.dedication ?? '');

  const disabled = locked || pending;
  const hasChapters = book.chapterCount > 0;

  // "By place" needs EXIF GPS and "by topic" needs a vision score; a photo set that mostly
  // lacks either would silently collapse into one meaningless chapter (photos stripped of
  // location by a messaging app, scans, screenshots — the first real book we looked at had
  // GPS on exactly none of its 36 photos). Say so before the user generates a book, not
  // after.
  // The caveat for the grouping that is actually SELECTED. It was briefly rendered under
  // every option the photos couldn't support, so the user would learn about the problem
  // before clicking — but a three-line orange warning permanently parked under an option
  // nobody had chosen dominated the panel and buried the hint for the option they HAD
  // chosen. The pre-click protection lives in the builder's `setGrouping` instead, which
  // asks before switching to a grouping the photos can't carry, so nothing is lost by
  // scoping this line to the current choice.
  const coverage = groupingCoverage(photos, book.photoGrouping);
  const selectedWarning = coverage.sufficient
    ? null
    : book.photoGrouping === 'location'
      ? tc.groupingWarnings.location(coverage.supported, coverage.total)
      : tc.groupingWarnings.topic(coverage.supported, coverage.total);

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
      {/* A dedication sits on the title page, which only a book with chapters prints —
          hidden for a pure photo book so its panel stays as short as it was. */}
      {hasChapters && (
        <TextInput
          label={t.books.builder.dedication}
          description={t.books.builder.dedicationHint}
          value={dedication}
          disabled={disabled}
          onChange={(e) => setDedication(e.currentTarget.value)}
          onBlur={() =>
            dedication !== (book.dedication ?? '') && onUpdateSettings({ dedication: dedication || null })
          }
        />
      )}
      {/* How the book is organised. This is the most consequential choice on the panel —
          the same photos become a timeline, a book of occasions, or a book of places — so
          it sits above the visual settings, with each option's effect spelled out rather
          than left to the label. It only takes effect on the next generation, which is why
          `onSetGrouping` re-runs the design pass once the book already exists. */}
      <Box>
        <Text fz={13} fw={500} mb={2}>
          {tc.grouping}
        </Text>
        <Text fz={12} c="dimmed" mb={8}>
          {/* With chapters present, each story is already its own section — the grouping
              only decides how the UPLOADED photos are clustered after them. */}
          {hasChapters ? tc.groupingIntroWithChapters : tc.groupingIntro}
        </Text>
        <Stack gap={6}>
          {PHOTO_BOOK_GROUPINGS.map((option) => (
            <Button
              key={option}
              fullWidth
              size="compact-sm"
              variant={option === book.photoGrouping ? 'filled' : 'default'}
              disabled={disabled}
              justify="flex-start"
              onClick={() => option !== book.photoGrouping && onSetGrouping(option)}
            >
              {tc.groupingOptions[option]}
            </Button>
          ))}
        </Stack>
        <Text fz={11} c="dimmed" mt={6}>
          {tc.groupingHints[book.photoGrouping]}
        </Text>
        {selectedWarning && (
          <Text fz={11} c="orange.7" mt={4}>
            {selectedWarning}
          </Text>
        )}
      </Box>
      <Box>
        {/* "Stil" says nothing by itself — the info bubble explains what a style even
            changes, and the line under the picker describes the currently selected one
            (same pattern as the grouping hint above). */}
        <Group gap={4} mb={6} align="center">
          <Text fz={13} fw={500}>
            {tp.style}
          </Text>
          <Tooltip label={tp.styleIntro} multiline w={280} events={{ hover: true, focus: true, touch: true }}>
            <Text component="span" c="dimmed" lh={0} style={{ cursor: 'help' }} aria-label={tp.styleIntro}>
              <IconInfoCircle size={15} />
            </Text>
          </Tooltip>
        </Group>
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
        <Text fz={11} c="dimmed" mt={6}>
          {tp.styleDescriptions[book.style]}
        </Text>
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
 * The live progress checklist shown while a design pass runs (docs/PHOTO_BOOK_PLAN.md —
 * the pass takes minutes: a vision call over every photo, a Chromium render of the draft,
 * then a second vision call reviewing those rendered pages). A bare spinner for that long
 * reads as "stuck", so every stage the worker publishes (`books.design_stage`, polled by
 * `photo-book-builder.tsx`) is ticked off here: done steps get a check, the current one
 * gets a spinner, later ones stay dimmed.
 *
 * Robust to a missing stage: `designStageIndex(null)` is -1, which renders the first step
 * as running — a queued pass is always at least about to prepare.
 */
function DesignProgressChecklist({ stage }: { stage: PhotoBookDesignStage | null }) {
  const { t } = useI18n();
  const tp = t.books.builder.photoBook;
  const current = Math.max(0, designStageIndex(stage));

  return (
    <Stack gap={10} py="lg" px="md">
      <Text fw={500} ta="center" mb={4}>
        {tp.bookAreaGenerating}
      </Text>
      {PHOTO_BOOK_DESIGN_STAGES.map((s, i) => {
        const done = i < current;
        const running = i === current;
        return (
          <Group key={s} gap={10} wrap="nowrap">
            <Box w={18} h={18} style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {done ? (
                <IconCircleCheck size={18} color="var(--mantine-color-green-6)" />
              ) : running ? (
                <Loader size={14} />
              ) : (
                <IconCircle size={16} color="var(--mantine-color-slate-3)" />
              )}
            </Box>
            <Text fz={14} c={done ? 'dimmed' : running ? undefined : 'dimmed'} fw={running ? 500 : 400}>
              {tp.designStages[s]}
            </Text>
          </Group>
        );
      })}
      <Text fz={12} c="dimmed" ta="center" mt={6}>
        {tp.designProgressHint}
      </Text>
    </Stack>
  );
}

/**
 * Step 2 — Create (docs/PHOTO_BOOK_PLAN.md, builder restructure PR6: "configure →
 * generate → book"). Gated on `book.generatedAt`:
 *
 * - **Not generated yet** (`generatedAt == null`): the config panel (style, cover type,
 *   size, title/subtitle) is front and center with the "Create book" CTA; the book area
 *   on the right shows a placeholder, or the design-progress checklist while the first
 *   pass is running (`book.designing`). No chat, no tray — there's no book yet to edit.
 * - **Generated**: the familiar layout returns — collapsible AI chat on the left, live
 *   preview on the right, photo tray along the bottom — plus a settings (gear) button on
 *   the preview card that reopens the same config panel in a `Modal`, alongside the
 *   "Design again" / "Regenerate" affordances for an explicit re-run.
 */
export function PhotoBookCreateStep({
  bookId,
  book,
  active,
  designStage,
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
  onSetGrouping,
  onUpdateSettings,
  onBack,
  onNext,
}: {
  bookId: string;
  book: PhotoBookInfo;
  /** True when this is the step the user is actually looking at. The Stepper keeps every
   *  step mounted, so without this the preview iframe would load inside a `display: none`
   *  panel — see `bookArea` below for why that produced a blank preview. */
  active: boolean;
  designStage: PhotoBookDesignStage | null;
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
  onSetGrouping: (grouping: PhotoBookGrouping) => void;
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
  // Latches true the first time this step is shown and stays true — see `bookArea` below.
  // Adjusted during render (React's "adjusting state when a prop changes" pattern) rather
  // than in an effect, so the iframe mounts in the same commit the step becomes visible
  // instead of a render later.
  const [mountedPreview, setMountedPreview] = useState(active);
  if (active && !mountedPreview) setMountedPreview(true);

  const hasGenerated = book.generatedAt != null;
  const chatPane = <PhotoBookChat bookId={bookId} locked={locked} />;

  /** The book area (right pane in both states): the progress checklist while a design pass
   *  is in flight, the placeholder before the book has ever been generated, or the live
   *  preview iframe once it has.
   *
   *  The iframe is mounted ONLY while this step is on screen. The preview HTML paginates
   *  itself with Paged.js and then zooms the page stack to fit its viewport
   *  (`fitPages` in `lib/photo-book-layout.ts`); inside the Stepper's hidden panel the
   *  iframe has no layout box at all, so that fit resolved against a 0×0 viewport and
   *  scaled the whole book to nothing. Coming back to a finished book therefore showed an
   *  empty preview — the book was fine, its rendering had been sized away. Mounting on
   *  first activation (and keeping it mounted afterwards, via `mountedPreview`, so
   *  switching steps doesn't re-fetch and re-paginate every time) fixes it at the source. */
  const bookArea = book.designing ? (
    <DesignProgressChecklist stage={designStage} />
  ) : !hasGenerated ? (
    <Stack align="center" gap={4} py="xl">
      <IconPhoto size={28} stroke={1.4} color="var(--mantine-color-slate-4)" />
      <Text c="dimmed" ta="center">
        {tp.bookAreaPlaceholder}
      </Text>
    </Stack>
  ) : !mountedPreview ? (
    <Stack align="center" gap={8} py="xl">
      <Loader size="sm" />
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
                photos={photos}
                locked={locked}
                pending={pending}
                onSetStyle={onSetStyle}
                onSetGrouping={onSetGrouping}
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
          photos={photos}
          locked={locked}
          pending={pending}
          onSetStyle={onSetStyle}
          onSetGrouping={onSetGrouping}
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
