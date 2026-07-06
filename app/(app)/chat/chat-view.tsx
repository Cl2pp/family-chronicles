'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Box,
  Button,
  Card,
  Group,
  Image,
  Paper,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { IconMicrophone, IconPhoto, IconSend, IconX } from '@tabler/icons-react';
import { AudioRecorder, type RecordedAudio } from '@/components/audio-recorder';
import { MessageRow } from './message-row';
import { presignUpload, sendMessage, sendVoiceMessage } from './actions';
import type { ChatAttachment, Msg } from './types';

const SETUP_SUGGESTIONS = ['Set up my family', 'Add a relative', 'Record a memory'];
const FAMILY_SUGGESTIONS = ['A childhood memory', 'About Grandma', 'Add a relative to the tree'];

interface PendingPhoto {
  s3Key: string;
  mimeType: string;
  bytes: number;
  previewUrl: string;
}

/** Upload a blob straight to storage via a presigned PUT; returns its S3 key. */
async function uploadBlob(
  kind: 'audio' | 'photo',
  blob: Blob,
  mimeType: string,
  filename?: string,
): Promise<string> {
  const { url, s3Key } = await presignUpload({ kind, mimeType, filename });
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: blob,
  });
  if (!res.ok) throw new Error('Upload failed');
  return s3Key;
}

export function ChatView({
  conversationId: initialConversationId,
  initialMessages,
  family,
}: {
  conversationId: string | null;
  initialMessages: Msg[];
  family?: { id: string; name: string };
}) {
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [input, setInput] = useState('');
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState<RecordedAudio | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const sending = busyLabel !== null;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busyLabel]);

  function pushError() {
    setMessages((m) => [
      ...m,
      { role: 'assistant', content: 'Sorry — something went wrong. Please try again.' },
    ]);
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if ((!trimmed && photos.length === 0) || sending) return;

    const attachments: ChatAttachment[] = photos.map((p) => ({ kind: 'photo', url: p.previewUrl }));
    const pendingPhotos = photos;
    setInput('');
    setPhotos([]);
    setMessages((m) => [...m, { role: 'user', content: trimmed, attachments }]);
    setBusyLabel('Thinking…');
    try {
      const res = await sendMessage({
        conversationId,
        text: trimmed || 'Here are some photos.',
        attachments: pendingPhotos.map((p) => ({
          kind: 'photo',
          s3Key: p.s3Key,
          mimeType: p.mimeType,
          bytes: p.bytes,
        })),
      });
      setConversationId(res.conversationId);
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: res.reply, receipts: res.receipts, storyDraft: res.storyDraft },
      ]);
    } catch {
      pushError();
    } finally {
      setBusyLabel(null);
    }
  }

  async function pickPhotos(files: FileList | null) {
    if (!files || files.length === 0) return;
    const chosen = Array.from(files).slice(0, 20);
    try {
      const uploaded = await Promise.all(
        chosen.map(async (file) => ({
          s3Key: await uploadBlob('photo', file, file.type, file.name),
          mimeType: file.type,
          bytes: file.size,
          previewUrl: URL.createObjectURL(file),
        })),
      );
      setPhotos((p) => [...p, ...uploaded].slice(0, 20));
    } catch {
      pushError();
    }
  }

  async function sendRecording() {
    if (!recorded || sending) return;
    const audio = recorded;
    const previewUrl = URL.createObjectURL(audio.blob);
    setRecording(false);
    setRecorded(null);
    setBusyLabel('Transcribing…');
    try {
      const s3Key = await uploadBlob('audio', audio.blob, audio.mimeType, `note.${audio.mimeType.includes('mp4') ? 'mp4' : 'webm'}`);
      const res = await sendVoiceMessage({
        conversationId,
        s3Key,
        mimeType: audio.mimeType,
        bytes: audio.blob.size,
        durationSec: audio.durationSec,
      });
      setConversationId(res.conversationId);
      setMessages((m) => [
        ...m,
        { role: 'user', content: res.transcript, attachments: [{ kind: 'audio', url: previewUrl }] },
        { role: 'assistant', content: res.reply, receipts: res.receipts, storyDraft: res.storyDraft },
      ]);
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          content: err instanceof Error ? err.message : 'Sorry — something went wrong.',
        },
      ]);
    } finally {
      setBusyLabel(null);
    }
  }

  function setResult(index: number, result: Msg['result']) {
    setMessages((m) => m.map((msg, i) => (i === index ? { ...msg, result } : msg)));
  }

  const empty = messages.length === 0;
  const suggestions = family ? FAMILY_SUGGESTIONS : SETUP_SUGGESTIONS;

  return (
    <Box
      maw={820}
      mx="auto"
      px="md"
      style={{ display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 56px)' }}
    >
      <Box style={{ flex: 1, overflowY: 'auto' }} py="lg">
        {empty ? (
          <Stack gap="lg" mt="xl">
            <Stack gap={4}>
              <Title order={2}>
                {family ? 'What would you like to do?' : 'Welcome — let’s begin your chronicle'}
              </Title>
              <Text c="dimmed">
                {family
                  ? "Talk or type — I’ll write stories and grow your family tree."
                  : "Tell me about your family and I’ll set it up, then we can start collecting memories."}
              </Text>
            </Stack>
            <Group gap="sm">
              {suggestions.map((s) => (
                <Button key={s} variant="light" size="xs" radius="xl" onClick={() => send(s)}>
                  {s}
                </Button>
              ))}
            </Group>
          </Stack>
        ) : (
          <Stack gap="md">
            {messages.map((m, i) => (
              <MessageRow
                key={i}
                msg={m}
                conversationId={conversationId}
                onResult={(r) => setResult(i, r)}
              />
            ))}
            {busyLabel && (
              <Group justify="flex-start">
                <Paper bg="slate.1" p="sm" radius="md">
                  <Text size="sm" c="dimmed">
                    {busyLabel}
                  </Text>
                </Paper>
              </Group>
            )}
          </Stack>
        )}
        <div ref={endRef} />
      </Box>

      <Box pb="md">
        {recording && (
          <Card withBorder radius="md" p="sm" mb="xs">
            <Group justify="space-between" mb="xs">
              <Text size="sm" fw={600}>
                Voice message
              </Text>
              <ActionIcon
                variant="subtle"
                color="gray"
                onClick={() => {
                  setRecording(false);
                  setRecorded(null);
                }}
                aria-label="Cancel recording"
              >
                <IconX size={16} />
              </ActionIcon>
            </Group>
            <AudioRecorder onChange={setRecorded} />
            {recorded && (
              <Button size="xs" mt="sm" onClick={sendRecording} loading={sending}>
                Send voice message
              </Button>
            )}
          </Card>
        )}

        {photos.length > 0 && (
          <Group gap="xs" mb="xs">
            {photos.map((p, i) => (
              <Box key={p.s3Key} pos="relative">
                <Image src={p.previewUrl} radius="sm" h={56} w={56} fit="cover" alt="" />
                <ActionIcon
                  size="xs"
                  color="dark"
                  variant="filled"
                  pos="absolute"
                  top={2}
                  right={2}
                  onClick={() => setPhotos((ps) => ps.filter((_, j) => j !== i))}
                  aria-label="Remove photo"
                >
                  <IconX size={12} />
                </ActionIcon>
              </Box>
            ))}
          </Group>
        )}

        <Group
          gap="xs"
          align="flex-end"
          p="xs"
          style={{
            border: '1px solid var(--mantine-color-slate-3)',
            borderRadius: 12,
            background: '#fff',
          }}
        >
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void pickPhotos(e.currentTarget.files);
              e.currentTarget.value = '';
            }}
          />
          <ActionIcon
            size={36}
            radius="md"
            variant="subtle"
            color="gray"
            disabled={sending}
            onClick={() => fileRef.current?.click()}
            aria-label="Add photos"
          >
            <IconPhoto size={18} />
          </ActionIcon>
          <ActionIcon
            size={36}
            radius="md"
            variant={recording ? 'filled' : 'subtle'}
            color="gray"
            disabled={sending}
            onClick={() => setRecording((r) => !r)}
            aria-label="Record voice message"
          >
            <IconMicrophone size={18} />
          </ActionIcon>
          <Textarea
            flex={1}
            variant="unstyled"
            autosize
            minRows={1}
            maxRows={6}
            placeholder="Message…"
            value={input}
            onChange={(e) => setInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
          />
          <ActionIcon
            size={36}
            radius="md"
            disabled={(!input.trim() && photos.length === 0) || sending}
            onClick={() => send(input)}
            aria-label="Send"
          >
            <IconSend size={18} />
          </ActionIcon>
        </Group>
      </Box>
    </Box>
  );
}
