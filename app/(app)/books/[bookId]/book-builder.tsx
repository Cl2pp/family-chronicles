'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Image,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconArrowDown,
  IconArrowLeft,
  IconArrowUp,
  IconExternalLink,
  IconFileTypePdf,
  IconInfoCircle,
  IconMessageCircle,
  IconPhoto,
  IconPlus,
  IconShoppingCart,
  IconX,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useI18n } from '@/lib/i18n/client';
import { setBookStoriesAction, updateBookAction } from '../actions';

export interface CoverOption {
  assetId: string;
  url: string;
  caption: string | null;
}

interface Chapter {
  storyId: string;
  title: string;
  year: number | null;
  photoCount: number;
}

interface BuilderBook {
  id: string;
  title: string;
  subtitle: string | null;
  dedication: string | null;
  coverAssetId: string | null;
  format: 'hardcover-21x28' | 'hardcover-20x20';
  status: 'draft' | 'rendering' | 'preview_ready' | 'render_failed' | 'ordered';
  errorMessage: string | null;
  pageCount: number | null;
  hasPreview: boolean;
  /** Cache-buster for the preview iframe — bumps whenever the book row changes. */
  previewVersion: number;
  chronicleName: string;
  chapters: Chapter[];
}

interface ChronicleStory {
  id: string;
  title: string;
  year: number | null;
}

export function BookBuilder({
  book,
  chronicleStories,
  coverOptions,
}: {
  book: BuilderBook;
  chronicleStories: ChronicleStory[];
  coverOptions: CoverOption[];
}) {
  const { t } = useI18n();
  const tb = t.books.builder;
  const [pending, startTransition] = useTransition();

  const locked = book.status === 'ordered';
  const included = new Set(book.chapters.map((c) => c.storyId));
  const notIncluded = chronicleStories.filter((s) => !included.has(s.id));

  // Settings form (uncontrolled-ish, saved on blur/submit)
  const [title, setTitle] = useState(book.title);
  const [subtitle, setSubtitle] = useState(book.subtitle ?? '');
  const [dedication, setDedication] = useState(book.dedication ?? '');

  // No status polling here — the preview pane is live HTML (see below), always
  // current. A `rendering`/`render_failed` status only ever describes the print
  // proof PDF now, which the order flow polls for itself.

  function run(action: () => Promise<{ error?: string }>) {
    startTransition(async () => {
      const result = await action();
      if (result.error) notifications.show({ message: result.error, color: 'red' });
    });
  }

  function saveSettings(patch: Parameters<typeof updateBookAction>[0]) {
    run(() => updateBookAction(patch));
  }

  function moveChapter(index: number, delta: -1 | 1) {
    const ids = book.chapters.map((c) => c.storyId);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    run(() => setBookStoriesAction({ bookId: book.id, storyIds: ids }));
  }

  function removeChapter(storyId: string) {
    const ids = book.chapters.map((c) => c.storyId).filter((id) => id !== storyId);
    run(() => setBookStoriesAction({ bookId: book.id, storyIds: ids }));
  }

  function addChapter(storyId: string) {
    const ids = [...book.chapters.map((c) => c.storyId), storyId];
    run(() => setBookStoriesAction({ bookId: book.id, storyIds: ids }));
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
        <Group gap="sm">
          <Tooltip label={tb.editWithAIHint}>
            <Button
              component={Link}
              href="/chat"
              variant="light"
              leftSection={<IconMessageCircle size={16} />}
            >
              {tb.editWithAI}
            </Button>
          </Tooltip>
          <Button
            component={Link}
            href={`/books/${book.id}/order`}
            leftSection={<IconShoppingCart size={16} />}
            disabled={book.status !== 'preview_ready'}
          >
            {tb.orderCta}
          </Button>
        </Group>
      </Group>

      {locked && (
        <Alert color="grape" icon={<IconInfoCircle size={16} />}>
          {tb.orderedNote}
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        {/* ── Left: chapters + settings ─────────────────────── */}
        <Stack gap="md">
          <Card withBorder radius="md" p="md">
            <Title order={4} mb={4}>
              {tb.chapters}
            </Title>
            <Text fz={13} c="dimmed" mb="sm">
              {tb.chaptersHint}
            </Text>
            <Stack gap={6}>
              {book.chapters.map((c, i) => (
                <Group key={c.storyId} justify="space-between" wrap="nowrap" gap={8}>
                  <Text fz={14} truncate style={{ flex: 1 }}>
                    {i + 1}. {c.title}
                    {c.year ? (
                      <Text span c="dimmed" fz={12}>
                        {' '}
                        ({c.year})
                      </Text>
                    ) : null}
                    {c.photoCount > 0 && (
                      <Text span c="dimmed" fz={12}>
                        {' '}
                        · <IconPhoto size={11} style={{ verticalAlign: -1 }} /> {c.photoCount}
                      </Text>
                    )}
                  </Text>
                  {!locked && (
                    <Group gap={2} wrap="nowrap">
                      <ActionIcon
                        variant="subtle"
                        size="sm"
                        aria-label={tb.moveUp}
                        disabled={i === 0 || pending}
                        onClick={() => moveChapter(i, -1)}
                      >
                        <IconArrowUp size={14} />
                      </ActionIcon>
                      <ActionIcon
                        variant="subtle"
                        size="sm"
                        aria-label={tb.moveDown}
                        disabled={i === book.chapters.length - 1 || pending}
                        onClick={() => moveChapter(i, 1)}
                      >
                        <IconArrowDown size={14} />
                      </ActionIcon>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        size="sm"
                        aria-label={tb.removeStory}
                        disabled={book.chapters.length <= 1 || pending}
                        onClick={() => removeChapter(c.storyId)}
                      >
                        <IconX size={14} />
                      </ActionIcon>
                    </Group>
                  )}
                </Group>
              ))}
            </Stack>

            {!locked && notIncluded.length > 0 && (
              <>
                <Title order={6} mt="md" mb={2} c="dimmed">
                  {tb.moreStories}
                </Title>
                <Text fz={12} c="dimmed" mb="xs">
                  {tb.moreStoriesHint}
                </Text>
                <Stack gap={4}>
                  {notIncluded.map((s) => (
                    <Group key={s.id} justify="space-between" wrap="nowrap">
                      <Text fz={13} c="dimmed" truncate>
                        {s.title}
                        {s.year ? ` (${s.year})` : ''}
                      </Text>
                      <Button
                        size="compact-xs"
                        variant="light"
                        leftSection={<IconPlus size={12} />}
                        disabled={pending}
                        onClick={() => addChapter(s.id)}
                      >
                        {tb.addStory}
                      </Button>
                    </Group>
                  ))}
                </Stack>
              </>
            )}
          </Card>

          <Card withBorder radius="md" p="md">
            <Title order={4} mb="sm">
              {tb.settings}
            </Title>
            <Stack gap="sm">
              <TextInput
                label={tb.bookTitle}
                value={title}
                disabled={locked}
                onChange={(e) => setTitle(e.currentTarget.value)}
                onBlur={() => title.trim() !== book.title && saveSettings({ bookId: book.id, title })}
              />
              <TextInput
                label={tb.subtitle}
                value={subtitle}
                disabled={locked}
                onChange={(e) => setSubtitle(e.currentTarget.value)}
                onBlur={() =>
                  subtitle !== (book.subtitle ?? '') &&
                  saveSettings({ bookId: book.id, subtitle: subtitle || null })
                }
              />
              <Textarea
                label={tb.dedication}
                description={tb.dedicationHint}
                value={dedication}
                autosize
                minRows={2}
                disabled={locked}
                onChange={(e) => setDedication(e.currentTarget.value)}
                onBlur={() =>
                  dedication !== (book.dedication ?? '') &&
                  saveSettings({ bookId: book.id, dedication: dedication || null })
                }
              />
              <Select
                label={tb.format}
                value={book.format}
                disabled={locked}
                data={[
                  { value: 'hardcover-21x28', label: 'Hardcover 21 × 28 cm' },
                  { value: 'hardcover-20x20', label: 'Hardcover 20 × 20 cm' },
                ]}
                onChange={(v) =>
                  v && v !== book.format &&
                  saveSettings({ bookId: book.id, format: v as BuilderBook['format'] })
                }
                allowDeselect={false}
              />

              <Box>
                <Text fz={14} fw={500} mb={2}>
                  {tb.cover}
                </Text>
                <Text fz={12} c="dimmed" mb={6}>
                  {tb.coverHint}
                </Text>
                <Group gap={6}>
                  <Card
                    withBorder
                    p={4}
                    radius="sm"
                    style={{
                      cursor: locked ? 'default' : 'pointer',
                      outline: !book.coverAssetId
                        ? '2px solid var(--mantine-color-brand-5)'
                        : undefined,
                      width: 72,
                      height: 72,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    onClick={() =>
                      !locked && book.coverAssetId &&
                      saveSettings({ bookId: book.id, coverAssetId: null })
                    }
                  >
                    <Text fz={9} c="dimmed" ta="center">
                      {tb.autoCover}
                    </Text>
                  </Card>
                  {coverOptions.map((c) => (
                    <Card
                      key={c.assetId}
                      withBorder
                      p={0}
                      radius="sm"
                      style={{
                        cursor: locked ? 'default' : 'pointer',
                        outline:
                          book.coverAssetId === c.assetId
                            ? '2px solid var(--mantine-color-brand-5)'
                            : undefined,
                        overflow: 'hidden',
                        width: 72,
                        height: 72,
                      }}
                      onClick={() =>
                        !locked &&
                        book.coverAssetId !== c.assetId &&
                        saveSettings({ bookId: book.id, coverAssetId: c.assetId })
                      }
                    >
                      <Image src={c.url} alt={c.caption ?? ''} w={72} h={72} fit="cover" />
                    </Card>
                  ))}
                </Group>
              </Box>
            </Stack>
          </Card>
        </Stack>

        {/* ── Right: preview ────────────────────────────────── */}
        <Card withBorder radius="md" p="md" style={{ minHeight: 480 }}>
          <Group justify="space-between" mb="sm" wrap="wrap">
            <Title order={4}>{tb.preview}</Title>
            <Group gap="sm">
              <Anchor href={`/api/books/${book.id}/preview-html`} target="_blank" fz={13}>
                <Group gap={4}>
                  <IconExternalLink size={14} />
                  {tb.openInNewTab}
                </Group>
              </Anchor>
              {book.hasPreview && (
                <Anchor href={`/api/books/${book.id}/preview`} target="_blank" fz={13}>
                  <Group gap={4}>
                    <IconFileTypePdf size={14} />
                    {tb.pdfProof}
                  </Group>
                </Anchor>
              )}
            </Group>
          </Group>

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
            title={tb.preview}
          />
          <Text fz={11} c="dimmed" mt={6}>
            {tb.livePreviewNote}
            {book.pageCount ? ` · ${t.books.pageCount(book.pageCount)}` : ''}
          </Text>
        </Card>
      </SimpleGrid>
    </Stack>
  );
}
