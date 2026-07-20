'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ActionIcon, Box, Card, Group, Loader, Paper, Stack, Text, Textarea, Title } from '@mantine/core';
import { IconCheck, IconMicrophone, IconSend, IconSparkles, IconX } from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';
import type { Receipt } from '@/lib/ai/tools';
import { AudioRecorder, type RecordedAudio } from '@/components/audio-recorder';
import { presignUpload } from '../../chat/actions';
import { MessageMarkdown } from '../../chat/message-markdown';
import { photoBookChatAction, photoBookChatVoiceAction } from '../actions';

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  receipts?: Receipt[];
  /** Set on a voice-sent user turn while its transcript hasn't landed yet. */
  transcribing?: boolean;
}

/**
 * The photo-book builder's embedded AI chat — the photo-book counterpart of
 * `book-chat.tsx`, differing only in which server action/agent it runs and in
 * supporting VOICE messages (docs/PHOTO_BOOK_PLAN.md §9: "typed or by voice message").
 * Per-visit like the story book's chat (nothing is persisted — the book itself is the
 * durable state); every send runs the photo-book-scoped agent server-side and then
 * refreshes the route so the live preview re-keys with the edits applied.
 */
export function PhotoBookChat({ bookId, locked }: { bookId: string; locked: boolean }) {
  const { t } = useI18n();
  const tc = t.books.builder.photoBook.chat;
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState<RecordedAudio | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = viewportRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  async function send() {
    const text = input.trim();
    if (!text || busy || locked) return;
    const history = messages.map(({ role, content }) => ({ role, content }));
    setMessages((m) => [...m, { role: 'user', content: text }]);
    setInput('');
    setBusy(true);
    setBusyLabel(tc.thinking);
    try {
      const result = await photoBookChatAction({ bookId, history, message: text });
      if (result.error || !result.reply) {
        setMessages((m) => [...m, { role: 'assistant', content: result.error ?? tc.error }]);
        return;
      }
      setMessages((m) => [...m, { role: 'assistant', content: result.reply!, receipts: result.receipts }]);
      if (result.receipts?.length) router.refresh();
    } catch {
      setMessages((m) => [...m, { role: 'assistant', content: tc.error }]);
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  }

  async function sendRecording() {
    if (!recorded || busy || locked) return;
    const audio = recorded;
    const history = messages.map(({ role, content }) => ({ role, content }));
    setRecording(false);
    setRecorded(null);
    setBusy(true);
    setBusyLabel(tc.uploadingRecording);
    const pendingIndex = messages.length;
    setMessages((m) => [...m, { role: 'user', content: '', transcribing: true }]);
    try {
      const { url, s3Key, mimeType } = await presignUpload({
        kind: 'audio',
        mimeType: audio.mimeType,
        bytes: audio.blob.size,
      });
      const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: audio.blob });
      if (!res.ok) throw new Error('Upload failed');
      setBusyLabel(tc.transcribing);
      const result = await photoBookChatVoiceAction({ bookId, history, s3Key, mimeType });
      if (result.error) {
        setMessages((m) => [
          ...m.slice(0, pendingIndex),
          { role: 'user', content: result.transcript ?? '' },
          { role: 'assistant', content: result.error! },
        ]);
        return;
      }
      setMessages((m) => [
        ...m.slice(0, pendingIndex),
        { role: 'user', content: result.transcript ?? '' },
        { role: 'assistant', content: result.reply ?? tc.error, receipts: result.receipts },
      ]);
      if (result.receipts?.length) router.refresh();
    } catch {
      setMessages((m) => [
        ...m.slice(0, pendingIndex),
        { role: 'assistant', content: tc.error },
      ]);
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  }

  return (
    <Card withBorder radius="md" p="md">
      <Group gap={6} mb={4}>
        <IconSparkles size={18} />
        <Title order={4}>{tc.title}</Title>
      </Group>
      <Text fz={13} c="dimmed" mb="sm">
        {tc.hint}
      </Text>

      {(messages.length > 0 || busy) && (
        <Box ref={viewportRef} mb="sm" style={{ maxHeight: 360, overflowY: 'auto' }}>
          <Stack gap="xs">
            {messages.map((msg, i) =>
              msg.role === 'user' ? (
                <Paper
                  key={i}
                  bg="brand.0"
                  px="sm"
                  py={6}
                  radius="md"
                  style={{ alignSelf: 'flex-end', maxWidth: '85%' }}
                >
                  <Text fz={14} style={{ whiteSpace: 'pre-wrap' }} fs={msg.transcribing ? 'italic' : undefined}>
                    {msg.transcribing ? tc.voiceMessage : msg.content}
                  </Text>
                </Paper>
              ) : (
                <Box key={i} style={{ alignSelf: 'flex-start', maxWidth: '85%' }}>
                  <MessageMarkdown content={msg.content} />
                  {msg.receipts?.map((r, j) => (
                    <Group key={j} gap={4} mt={2}>
                      <IconCheck size={13} color="var(--mantine-color-teal-6)" />
                      <Text fz={12} c="dimmed">
                        {r.label}
                      </Text>
                    </Group>
                  ))}
                </Box>
              ),
            )}
            {busy && (
              <Group gap={6}>
                <Loader size={14} />
                <Text fz={13} c="dimmed">
                  {busyLabel ?? tc.thinking}
                </Text>
              </Group>
            )}
          </Stack>
        </Box>
      )}

      {recording ? (
        <Stack gap="xs">
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <AudioRecorder onChange={setRecorded} />
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label={t.common.cancel}
              disabled={busy}
              onClick={() => {
                setRecording(false);
                setRecorded(null);
              }}
            >
              <IconX size={16} />
            </ActionIcon>
          </Group>
          <Group justify="flex-end">
            <ActionIcon
              size={36}
              variant="filled"
              aria-label={tc.sendVoiceMessage}
              disabled={locked || busy || !recorded}
              onClick={() => void sendRecording()}
            >
              <IconSend size={18} />
            </ActionIcon>
          </Group>
        </Stack>
      ) : (
        <Group gap="xs" align="flex-end" wrap="nowrap">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.currentTarget.value)}
            placeholder={tc.placeholder}
            disabled={locked || busy}
            autosize
            minRows={1}
            maxRows={5}
            style={{ flex: 1 }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <ActionIcon
            size={36}
            variant="light"
            aria-label={tc.recordVoiceAria}
            disabled={locked || busy}
            onClick={() => setRecording(true)}
          >
            <IconMicrophone size={18} />
          </ActionIcon>
          <ActionIcon
            size={36}
            variant="filled"
            aria-label={tc.send}
            disabled={locked || busy || !input.trim()}
            onClick={() => void send()}
          >
            <IconSend size={18} />
          </ActionIcon>
        </Group>
      )}
    </Card>
  );
}
