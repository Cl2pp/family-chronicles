'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ActionIcon, Box, Card, Group, Loader, Paper, Stack, Text, Textarea, Title } from '@mantine/core';
import { IconCheck, IconSend, IconSparkles } from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';
import type { Receipt } from '@/lib/ai/tools';
import { MessageMarkdown } from '../../chat/message-markdown';
import { bookChatAction } from '../actions';

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  receipts?: Receipt[];
}

/**
 * The builder's embedded AI chat: the way to change a book beyond the basic settings.
 * Per-visit (nothing is persisted — the book itself is the durable state); every send
 * runs the book-scoped agent server-side and then refreshes the route so the live
 * preview re-keys with the edits applied.
 */
export function BookChat({ bookId, locked }: { bookId: string; locked: boolean }) {
  const { t } = useI18n();
  const tc = t.books.builder.chat;
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);

  // Keep the newest turn in view — the thread grows downward.
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
    try {
      const result = await bookChatAction({ bookId, history, message: text });
      if (result.error || !result.reply) {
        setMessages((m) => [...m, { role: 'assistant', content: result.error ?? tc.error }]);
        return;
      }
      setMessages((m) => [...m, { role: 'assistant', content: result.reply!, receipts: result.receipts }]);
      // Any applied edit changed the book row — refetch so the preview iframe re-keys.
      if (result.receipts?.length) router.refresh();
    } catch {
      setMessages((m) => [...m, { role: 'assistant', content: tc.error }]);
    } finally {
      setBusy(false);
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
        <Box
          ref={viewportRef}
          mb="sm"
          style={{ maxHeight: 360, overflowY: 'auto' }}
        >
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
                  <Text fz={14} style={{ whiteSpace: 'pre-wrap' }}>
                    {msg.content}
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
                  {tc.thinking}
                </Text>
              </Group>
            )}
          </Stack>
        </Box>
      )}

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
          variant="filled"
          aria-label={tc.send}
          disabled={locked || busy || !input.trim()}
          onClick={() => void send()}
        >
          <IconSend size={18} />
        </ActionIcon>
      </Group>
    </Card>
  );
}
