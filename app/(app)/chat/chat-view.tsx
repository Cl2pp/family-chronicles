'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
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
import {
  IconBook2,
  IconHeart,
  IconMicrophone,
  IconMoodKid,
  IconPhoto,
  IconPlus,
  IconSend,
  IconUserPlus,
  IconUsersPlus,
  IconX,
} from '@tabler/icons-react';
import { AudioRecorder, type RecordedAudio } from '@/components/audio-recorder';
import { MOBILE_TABBAR_OFFSET } from '@/components/app-shell';
import { CONVERSATION_IDLE_MS } from '@/lib/chat-idle';
import { PHOTO_ACCEPT, readDimensions } from '@/lib/uploads';
import { useI18n } from '@/lib/i18n/client';
import { MessageRow } from './message-row';
import { endConversation, presignUpload, sendMessage, sendVoiceMessage } from './actions';
import type { ChatAttachment, Msg } from './types';

// Icons paired by index with t.chat.setupSuggestions / t.chat.familySuggestions.
const setupSuggestionIcons = [IconBook2, IconUserPlus, IconMicrophone];
const familySuggestionIcons = [IconMoodKid, IconHeart, IconUsersPlus];

/** Photos attachable to one message. */
const MAX_PHOTOS = 20;

interface PendingPhoto {
  s3Key: string;
  mimeType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  previewUrl: string;
}

/**
 * Upload a blob straight to storage via a presigned PUT.
 *
 * The server signs a canonical content type (`audio/webm`, not the recorder's
 * `audio/webm;codecs=opus`) and the exact byte length — both are part of the signature,
 * so the PUT must echo the type the server returned rather than the browser's own.
 */
async function uploadBlob(
  kind: 'audio' | 'photo',
  blob: Blob,
  rawMimeType: string,
): Promise<{ s3Key: string; mimeType: string }> {
  const { url, s3Key, mimeType } = await presignUpload({
    kind,
    mimeType: rawMimeType,
    bytes: blob.size,
  });
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: blob,
  });
  if (!res.ok) throw new Error('Upload failed');
  return { s3Key, mimeType };
}

export function ChatView({
  conversationId: initialConversationId,
  initialMessages,
  lastActivityAt,
  chronicle,
  autoPrompt,
}: {
  conversationId: string | null;
  initialMessages: Msg[];
  /** When the resumed conversation last saw a message (ms epoch), if any. */
  lastActivityAt?: number | null;
  chronicle?: { id: string; name: string };
  /** Message sent on the user's behalf right after mount (e.g. "Add story" entry point). */
  autoPrompt?: string;
}) {
  const { t } = useI18n();
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [input, setInput] = useState('');
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState<RecordedAudio | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const autoPromptSent = useRef(false);
  const lastActivityRef = useRef(lastActivityAt ?? Date.now());
  const router = useRouter();

  const sending = busyLabel !== null;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busyLabel]);

  // A resumed PWA can sit on a days-old render without ever hitting the server.
  // When the app returns to the foreground past the idle window, drop the stale
  // thread client-side — mirroring what `resumableConversation` does on a reload.
  useEffect(() => {
    function dropIfStale() {
      if (document.visibilityState === 'hidden') return;
      if (Date.now() - lastActivityRef.current > CONVERSATION_IDLE_MS) resetChat();
    }
    document.addEventListener('visibilitychange', dropIfStale);
    window.addEventListener('focus', dropIfStale);
    return () => {
      document.removeEventListener('visibilitychange', dropIfStale);
      window.removeEventListener('focus', dropIfStale);
    };
  }, []);

  // Entry points like the "Add story" button open the chat with a ready-made
  // opener; send it once, then drop the query param so a reload won't repeat it.
  useEffect(() => {
    if (!autoPrompt || autoPromptSent.current) return;
    autoPromptSent.current = true;
    router.replace('/chat');
    void send(autoPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPrompt]);

  function pushError() {
    setMessages((m) => [...m, { role: 'assistant', content: t.chat.somethingWentWrong }]);
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if ((!trimmed && photos.length === 0) || sending) return;

    const attachments: ChatAttachment[] = photos.map((p) => ({ kind: 'photo', url: p.previewUrl }));
    const pendingPhotos = photos;
    lastActivityRef.current = Date.now();
    setInput('');
    setPhotos([]);
    setMessages((m) => [...m, { role: 'user', content: trimmed, attachments }]);
    setBusyLabel(t.chat.thinking);
    try {
      const res = await sendMessage({
        conversationId,
        text: trimmed,
        attachments: pendingPhotos.map((p) => ({
          kind: 'photo',
          s3Key: p.s3Key,
          mimeType: p.mimeType,
          bytes: p.bytes,
          width: p.width,
          height: p.height,
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
    const chosen = Array.from(files).slice(0, MAX_PHOTOS);
    try {
      const uploaded = await Promise.all(
        chosen.map(async (file) => {
          const [{ s3Key, mimeType }, size] = await Promise.all([
            uploadBlob('photo', file, file.type),
            readDimensions(file),
          ]);
          return {
            s3Key,
            mimeType,
            bytes: file.size,
            width: size?.width ?? null,
            height: size?.height ?? null,
            previewUrl: URL.createObjectURL(file),
          };
        }),
      );
      setPhotos((p) => [...p, ...uploaded].slice(0, MAX_PHOTOS));
    } catch (err) {
      // Size/type rejections come back from the presign action with a usable message.
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: err instanceof Error ? err.message : t.chat.somethingWentWrong },
      ]);
    }
  }

  async function sendRecording() {
    if (!recorded || sending) return;
    const audio = recorded;
    const previewUrl = URL.createObjectURL(audio.blob);
    lastActivityRef.current = Date.now();
    setRecording(false);
    setRecorded(null);
    setBusyLabel(t.chat.transcribing);
    // Show the voice note straight away — uploading + transcribing takes seconds, and
    // without a bubble a fresh chat would sit on its empty state as if nothing was sent.
    // The transcript fills this same bubble in once the server returns it.
    const pending: Msg = { role: 'user', content: '', attachments: [{ kind: 'audio', url: previewUrl }] };
    setMessages((m) => [...m, pending]);
    try {
      const { s3Key, mimeType } = await uploadBlob('audio', audio.blob, audio.mimeType);
      const res = await sendVoiceMessage({
        conversationId,
        s3Key,
        mimeType,
        bytes: audio.blob.size,
        durationSec: audio.durationSec,
      });
      setConversationId(res.conversationId);
      setMessages((m) => {
        const next = [...m];
        const i = next.lastIndexOf(pending);
        if (i !== -1) next[i] = { ...pending, content: res.transcript };
        return [
          ...next,
          { role: 'assistant', content: res.reply, receipts: res.receipts, storyDraft: res.storyDraft },
        ];
      });
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          content: err instanceof Error ? err.message : t.chat.somethingWentWrong,
        },
      ]);
    } finally {
      setBusyLabel(null);
    }
  }

  function setResult(index: number, result: Msg['result']) {
    setMessages((m) => m.map((msg, i) => (i === index ? { ...msg, result } : msg)));
  }

  /** Clear the view back to a fresh, empty chat. */
  function resetChat() {
    setConversationId(null);
    setMessages([]);
    setInput('');
    setPhotos([]);
    setRecording(false);
    setRecorded(null);
    lastActivityRef.current = Date.now();
  }

  /**
   * Start a fresh conversation. The old one is closed server-side so a reload or
   * PWA reopen won't resume it; it stays stored and linked to its stories.
   */
  function startNewChat() {
    if (conversationId) void endConversation(conversationId).catch(() => {});
    resetChat();
  }

  const empty = messages.length === 0;
  const suggestions = chronicle ? t.chat.familySuggestions : t.chat.setupSuggestions;
  const suggestionIcons = chronicle ? familySuggestionIcons : setupSuggestionIcons;

  return (
    <Box
      maw={820}
      mx="auto"
      px="md"
      // On mobile the fixed bottom tab bar eats into the viewport; size the chat
      // column to what's actually visible so the header and composer never scroll away.
      h={{ base: `calc(100dvh - ${MOBILE_TABBAR_OFFSET}px)`, sm: '100dvh' }}
      style={{ display: 'flex', flexDirection: 'column' }}
    >
      {!empty && (
        <Group
          justify="space-between"
          align="center"
          py={6}
          style={{
            // Keeps the header clear of the status bar in the installed PWA.
            paddingTop: 'max(env(safe-area-inset-top), 6px)',
            borderBottom: '1px solid var(--mantine-color-slate-2)',
          }}
        >
          <Text size="sm" fw={600} c="dimmed" truncate>
            {chronicle?.name ?? t.nav.chat}
          </Text>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconPlus size={14} />}
            onClick={startNewChat}
            disabled={sending}
          >
            {t.chat.newChat}
          </Button>
        </Group>
      )}
      <Box style={{ flex: 1, overflowY: 'auto' }} py="lg">
        {empty ? (
          <Stack gap="lg" mt="xl">
            <Stack gap={4}>
              <Title order={2}>
                {chronicle ? t.chat.welcomeTitle : t.chat.welcomeTitleSetup}
              </Title>
              <Text c="dimmed">
                {chronicle ? t.chat.welcomeText : t.chat.welcomeTextSetup}
              </Text>
            </Stack>
            <Group gap="sm">
              {suggestions.map((s, i) => {
                const Icon = suggestionIcons[i];
                return (
                  <Button
                    key={s}
                    variant="light"
                    size="xs"
                    radius="xl"
                    leftSection={Icon ? <Icon size={14} /> : undefined}
                    onClick={() => send(s)}
                  >
                    {s}
                  </Button>
                );
              })}
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
          </Stack>
        )}
        {/* Outside the empty/non-empty branch: a send that hasn't produced a bubble yet
            must still show progress rather than leave the welcome screen looking idle. */}
        {busyLabel && (
          <Group justify="flex-start" mt="md">
            <Paper bg="slate.1" p="sm" radius="md">
              <Text size="sm" c="dimmed">
                {busyLabel}
              </Text>
            </Paper>
          </Group>
        )}
        <div ref={endRef} />
      </Box>

      <Box pb="md">
        {recording && (
          <Card withBorder radius="md" p="sm" mb="xs">
            <Group justify="space-between" mb="xs">
              <Text size="sm" fw={600}>
                {t.chat.voiceMessage}
              </Text>
              <ActionIcon
                variant="subtle"
                color="gray"
                onClick={() => {
                  setRecording(false);
                  setRecorded(null);
                }}
                aria-label={t.chat.cancelRecordingAria}
              >
                <IconX size={16} />
              </ActionIcon>
            </Group>
            <AudioRecorder onChange={setRecorded} />
            {recorded && (
              <Button size="xs" mt="sm" onClick={sendRecording} loading={sending}>
                {t.chat.sendVoiceMessage}
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
                  aria-label={t.chat.removePhotoAria}
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
            accept={PHOTO_ACCEPT}
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
            aria-label={t.chat.addPhotosAria}
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
            aria-label={t.chat.recordVoiceAria}
          >
            <IconMicrophone size={18} />
          </ActionIcon>
          <Textarea
            flex={1}
            variant="unstyled"
            autosize
            minRows={1}
            maxRows={6}
            placeholder={t.chat.messagePlaceholder}
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
            aria-label={t.chat.sendAria}
          >
            <IconSend size={18} />
          </ActionIcon>
        </Group>
      </Box>
    </Box>
  );
}
