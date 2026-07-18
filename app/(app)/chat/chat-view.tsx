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
  Loader,
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
import { MessageMarkdown } from './message-markdown';
import { MessageRow } from './message-row';
import { endConversation, persistActiveChronicle, presignUpload, syncChat } from './actions';
import { progressLabel } from './progress-label';
import type { SendResult } from './respond';
import type { ChatStreamEvent, ChatStreamRequest } from './stream-events';
import type { ChatAttachment, Msg } from './types';

// Icons paired by index with t.chat.setupSuggestions / t.chat.familySuggestions.
const setupSuggestionIcons = [IconBook2, IconUserPlus, IconMicrophone];
const familySuggestionIcons = [IconMoodKid, IconHeart, IconUsersPlus];

/** Photos attachable to one message. */
const MAX_PHOTOS = 20;

/**
 * After returning to a tab with a send still in flight, how long to give that request
 * to settle on its own before reconciling with the server. Mobile browsers kill
 * in-flight fetches when a tab is backgrounded — the request may never settle at all.
 */
const RESYNC_GRACE_MS = 8_000;

/** Poll spacing while the server reports a reply is still being generated. */
const SYNC_RETRY_MS = 5_000;

/**
 * Give up reconciling after this many polls/retries (~3.75 minutes). Must outlast the
 * server's claim staleness (REPLY_CLAIM_STALE_MS, 3 min): if a crashed request left an
 * orphaned claim, the polling has to still be running when the claim goes stale so the
 * reply gets regenerated instead of erroring out just before recovery became possible.
 */
const MAX_SYNC_ATTEMPTS = 45;

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
  // Second line under the busy label. Only the upload phase of a voice send uses it:
  // the recording exists nowhere but in page memory until the PUT finishes, so the
  // user must not close the app — once the server has the turn, closing is safe.
  const [busyHint, setBusyHint] = useState<string | null>(null);
  // The reply-in-progress, streamed token by token. Mirrored in a ref so stream
  // events can move it into the status line without a stale-closure read.
  const [liveText, setLiveText] = useState('');
  const liveTextRef = useRef('');
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState<RecordedAudio | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const autoPromptSent = useRef(false);
  const lastActivityRef = useRef(lastActivityAt ?? Date.now());
  const router = useRouter();

  // Reconcile machinery. A send is one long request; when the mobile browser
  // backgrounds the tab it kills that request, so the reply (and any draft card it
  // carried) is stored server-side but never arrives — or was never generated at all.
  // `syncChat` fetches the canonical conversation (regenerating the missing reply if
  // needed); the turn counter makes sure only the first path to settle a turn — the
  // original request or a reconcile — gets to touch the visible state.
  const turnRef = useRef(0);
  const conversationRef = useRef(initialConversationId);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncingRef = useRef(false);
  const syncAttemptsRef = useRef(0);
  /** Set while a send is in flight, so a reconcile can tell "reply lost" (the message
   * is stored) from "send lost" (it never arrived — surface an error, don't swallow it). */
  const sendBaselineRef = useRef<{ turn: number; userCount: number; errorText: string | null } | null>(null);

  const sending = busyLabel !== null;

  /** Claim the visible state for a new settling path; stale handlers and timers no-op. */
  function advanceTurn() {
    turnRef.current += 1;
    sendBaselineRef.current = null;
    syncAttemptsRef.current = 0;
    liveTextRef.current = '';
    setLiveText('');
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
  }

  function adoptConversation(id: string) {
    conversationRef.current = id;
    setConversationId(id);
  }

  /** Start a send: cancel stale reconciles and record the pre-send baseline. */
  function beginSendTurn(): number {
    advanceTurn();
    setBusyHint(null); // only the voice upload phase re-sets it
    const turn = turnRef.current;
    sendBaselineRef.current = {
      turn,
      userCount: messages.filter((m) => m.role === 'user').length,
      errorText: null,
    };
    lastActivityRef.current = Date.now();
    return turn;
  }

  function settleWithError(text: string | null) {
    advanceTurn();
    setBusyLabel(null);
    setMessages((m) => [...m, { role: 'assistant', content: text ?? t.chat.somethingWentWrong }]);
  }

  function applyServerMessages(id: string, msgs: Msg[]) {
    advanceTurn();
    adoptConversation(id);
    lastActivityRef.current = Date.now();
    setMessages(msgs);
    setBusyLabel(null);
  }

  function scheduleSync(delayMs: number) {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    const turn = turnRef.current;
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      if (turn === turnRef.current) void syncNow();
    }, delayMs);
  }

  /** One reconcile attempt against the stored conversation. */
  async function syncNow() {
    if (syncingRef.current) return;
    const turn = turnRef.current;
    const baseline = sendBaselineRef.current;
    syncingRef.current = true;
    try {
      const res = await syncChat(conversationRef.current);
      if (turn !== turnRef.current) return;
      if (res.status === 'pending') {
        // Another live request is mid-generation — poll until its reply is stored.
        if (syncAttemptsRef.current++ >= MAX_SYNC_ATTEMPTS) settleWithError(baseline?.errorText ?? null);
        else scheduleSync(SYNC_RETRY_MS);
        return;
      }
      if (res.status === 'failed') {
        settleWithError(baseline?.errorText ?? null);
        return;
      }
      if (res.status === 'gone') {
        if (baseline) {
          settleWithError(baseline.errorText);
        } else {
          advanceTurn();
          setBusyLabel(null);
        }
        return;
      }
      // ok — but if a send was in flight and its message never reached the server,
      // applying the stored list would silently swallow it; report the failure instead.
      const serverUserCount = res.messages.filter((m) => m.role === 'user').length;
      if (baseline && serverUserCount <= baseline.userCount) {
        settleWithError(baseline.errorText);
        return;
      }
      applyServerMessages(res.conversationId, res.messages);
    } catch {
      // The network right after a tab resume is often still flaky — retry.
      if (turn !== turnRef.current) return;
      if (syncAttemptsRef.current++ >= MAX_SYNC_ATTEMPTS) settleWithError(baseline?.errorText ?? null);
      else scheduleSync(SYNC_RETRY_MS);
    } finally {
      syncingRef.current = false;
    }
  }

  // Height of the visible area while the keyboard overlays it, null when it doesn't.
  const [keyboardViewportH, setKeyboardViewportH] = useState<number | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busyLabel, liveText, keyboardViewportH]);

  // iOS never resizes the layout viewport for the keyboard (no `interactive-widget`
  // support in WebKit) — it pans the whole app upward to reveal the focused input,
  // scrolling the header away and sometimes leaving the view stuck half-shifted.
  // Instead, size the chat column to the visual viewport (what's actually visible)
  // and pin the window, so the composer sits above the keyboard without any panning.
  // On Android `interactive-widget=resizes-content` already shrinks the layout
  // viewport, so the visual viewport matches `window.innerHeight` and this stays inert.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    function update() {
      if (!vv) return;
      const overlaid = window.innerHeight - vv.height > 80;
      setKeyboardViewportH(overlaid ? Math.round(vv.height) : null);
      if (overlaid) window.scrollTo(0, 0);
    }
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

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

  // A killed send can leave the stored conversation ending on a user message that
  // never got its reply (the page renders exactly that after a reload on mobile).
  // Reconcile once on mount so the reply is regenerated instead of the chat going mute.
  useEffect(() => {
    const lastTurn = [...initialMessages].reverse().find((m) => m.role !== 'system');
    if (lastTurn?.role === 'user' && conversationRef.current) {
      setBusyLabel(t.chat.thinking);
      void syncNow();
    }
    return () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A send in flight when the tab was backgrounded may sit on a connection the mobile
  // browser already killed — it would neither resolve nor reject. On return, give it a
  // grace period to settle on its own, then reconcile with the server.
  useEffect(() => {
    if (!sending) return;
    function resyncSoon() {
      if (document.visibilityState === 'hidden') return;
      scheduleSync(RESYNC_GRACE_MS);
    }
    document.addEventListener('visibilitychange', resyncSoon);
    window.addEventListener('focus', resyncSoon);
    return () => {
      document.removeEventListener('visibilitychange', resyncSoon);
      window.removeEventListener('focus', resyncSoon);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending]);

  // Entry points like the "Add story" button open the chat with a ready-made
  // opener; send it once, then drop the query param so a reload won't repeat it.
  useEffect(() => {
    if (!autoPrompt || autoPromptSent.current) return;
    autoPromptSent.current = true;
    router.replace('/chat');
    void send(autoPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPrompt]);

  /** Server-state side effects of a settled turn the streaming route can't do itself:
   *  persist a chronicle switch (cookies can't be set mid-stream) and refresh the
   *  router cache so the tree/stories pages reflect applied actions. */
  function applyResultSideEffects(res: SendResult) {
    if (res.activeChronicleChanged) {
      void persistActiveChronicle(res.activeChronicleChanged).catch(() => {});
    }
    if (res.receipts.length || res.activeChronicleChanged) router.refresh();
  }

  /**
   * POST the turn to the streaming endpoint and fold its events into the view:
   * status lines while tools run, live token deltas for the reply, then the
   * authoritative `result`. Events for a superseded turn are dropped.
   */
  async function streamTurn(
    body: ChatStreamRequest,
    turn: number,
    onTranscript?: (transcript: string) => void,
  ): Promise<SendResult> {
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) throw new Error(t.chat.somethingWentWrong);

    let result: SendResult | null = null;
    let serverError: string | null = null;
    const handle = (event: ChatStreamEvent) => {
      if (turn !== turnRef.current) return;
      switch (event.type) {
        case 'stage':
          // Pre-transcript voice steps — compression only happens for long recordings.
          setBusyLabel(event.stage === 'compressing' ? t.chat.compressing : t.chat.transcribing);
          break;
        case 'transcript':
          onTranscript?.(event.text);
          break;
        case 'text':
          liveTextRef.current += event.text;
          setLiveText(liveTextRef.current);
          break;
        case 'step':
          // Pre-tool prose ("Let me check the tree…") is a status line, not part of
          // the reply; the final step's text stays and is replaced by the canonical
          // reply when `result` lands.
          if (event.kind === 'tools') {
            const note = liveTextRef.current.trim();
            if (note) setBusyLabel(note.length > 140 ? `${note.slice(0, 140)}…` : note);
            liveTextRef.current = '';
            setLiveText('');
          }
          break;
        case 'tool':
          setBusyLabel(progressLabel(t.chat, event.name, event.args));
          break;
        case 'result':
          result = event.result;
          break;
        case 'error':
          serverError = event.message;
          break;
      }
    };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          handle(JSON.parse(line) as ChatStreamEvent);
        }
      }
    } finally {
      // A parse error mid-loop must not leave the connection dangling until the
      // server finishes the whole turn. Cancel after normal completion is a no-op.
      void reader.cancel().catch(() => {});
    }
    if (serverError) throw new Error(serverError);
    // A stream that ended without a result died mid-turn — throw so the caller
    // reconciles with the server instead of going silently mute.
    if (!result) throw new Error(t.chat.somethingWentWrong);
    return result;
  }

  /** A fresh tree-changes card replaces any older pending one (the server already
   *  superseded it) — retire stale cards from view instead of leaving two live. */
  function withoutSupersededCards(msgs: Msg[]): Msg[] {
    return msgs.map((m) => (m.peopleDraft && !m.peopleResult ? { ...m, peopleDraft: null } : m));
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if ((!trimmed && photos.length === 0) || sending) return;

    const attachments: ChatAttachment[] = photos.map((p) => ({ kind: 'photo', url: p.previewUrl }));
    const pendingPhotos = photos;
    const turn = beginSendTurn();
    setInput('');
    setPhotos([]);
    setMessages((m) => [...m, { role: 'user', content: trimmed, attachments }]);
    setBusyLabel(t.chat.thinking);
    try {
      const res = await streamTurn(
        {
          kind: 'text',
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
        },
        turn,
      );
      if (turn !== turnRef.current) return; // a reconcile already settled this turn
      advanceTurn();
      adoptConversation(res.conversationId);
      setMessages((m) => [
        ...(res.peopleDraft ? withoutSupersededCards(m) : m),
        {
          role: 'assistant',
          content: res.reply,
          receipts: res.receipts,
          storyDraft: res.storyDraft,
          peopleDraft: res.peopleDraft,
          peopleDraftMessageId: res.peopleDraftMessageId,
        },
      ]);
      setBusyLabel(null);
      applyResultSideEffects(res);
    } catch (err) {
      // The request may have died mid-flight (a backgrounded mobile tab) while the
      // server finished — or can redo — the turn. Reconcile before declaring failure —
      // and drop any half-streamed reply so it can't sit frozen (and hide the busy
      // label) for the whole regeneration.
      if (turn !== turnRef.current) return;
      liveTextRef.current = '';
      setLiveText('');
      setBusyLabel(t.chat.thinking);
      if (sendBaselineRef.current?.turn === turn) {
        sendBaselineRef.current.errorText = err instanceof Error ? err.message : null;
      }
      void syncNow();
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
    const turn = beginSendTurn();
    setRecording(false);
    setRecorded(null);
    setBusyLabel(t.chat.uploadingRecording);
    // Short notes upload sub-second — only warn when the transfer is long enough
    // that pocketing the phone mid-upload is a realistic way to lose the recording.
    if (audio.blob.size > 2 * 1024 * 1024) setBusyHint(t.chat.keepAppOpen);
    // Show the voice note straight away — uploading + transcribing takes seconds, and
    // without a bubble a fresh chat would sit on its empty state as if nothing was sent.
    // The transcript event fills this same bubble in while the agent is still thinking.
    const pending: Msg = { role: 'user', content: '', attachments: [{ kind: 'audio', url: previewUrl }] };
    setMessages((m) => [...m, pending]);
    try {
      const { s3Key, mimeType } = await uploadBlob('audio', audio.blob, audio.mimeType);
      // Uploaded — from here the server owns the turn and closing the app is safe.
      setBusyHint(null);
      // The server's `stage` events refine this into compressing/transcribing.
      setBusyLabel(t.chat.transcribing);
      const res = await streamTurn(
        {
          kind: 'voice',
          conversationId,
          s3Key,
          mimeType,
          bytes: audio.blob.size,
          durationSec: audio.durationSec,
        },
        turn,
        (transcript) => {
          setBusyLabel(t.chat.thinking);
          setMessages((m) =>
            m.map((msg) => (msg === pending ? { ...pending, content: transcript } : msg)),
          );
        },
      );
      if (turn !== turnRef.current) return; // a reconcile already settled this turn
      advanceTurn();
      adoptConversation(res.conversationId);
      setMessages((m) => [
        ...(res.peopleDraft ? withoutSupersededCards(m) : m),
        {
          role: 'assistant',
          content: res.reply,
          receipts: res.receipts,
          storyDraft: res.storyDraft,
          peopleDraft: res.peopleDraft,
          peopleDraftMessageId: res.peopleDraftMessageId,
        },
      ]);
      setBusyLabel(null);
      applyResultSideEffects(res);
    } catch (err) {
      // Real failures (e.g. "couldn't transcribe") carry a message worth showing —
      // but a killed request does not mean failure: the server may have stored the
      // message and finished the reply. Reconcile decides which case this is.
      if (turn !== turnRef.current) return;
      liveTextRef.current = '';
      setLiveText('');
      setBusyHint(null);
      setBusyLabel(t.chat.thinking);
      if (sendBaselineRef.current?.turn === turn) {
        sendBaselineRef.current.errorText = err instanceof Error ? err.message : null;
      }
      void syncNow();
    }
  }

  function setResult(index: number, result: Msg['result']) {
    setMessages((m) => m.map((msg, i) => (i === index ? { ...msg, result } : msg)));
  }

  function setPeopleResult(index: number, peopleResult: Msg['peopleResult']) {
    setMessages((m) => m.map((msg, i) => (i === index ? { ...msg, peopleResult } : msg)));
  }

  /** Clear the view back to a fresh, empty chat. */
  function resetChat() {
    advanceTurn(); // in-flight sends and scheduled reconciles must not resurrect the old thread
    conversationRef.current = null;
    setConversationId(null);
    setMessages([]);
    setInput('');
    setPhotos([]);
    setRecording(false);
    setRecorded(null);
    setBusyLabel(null);
    setBusyHint(null);
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
      // While the keyboard overlays the page (iOS), the tab bar is hidden behind it —
      // use the visible height as-is, no offset.
      h={
        keyboardViewportH !== null
          ? keyboardViewportH
          : { base: `calc(100dvh - ${MOBILE_TABBAR_OFFSET}px)`, sm: '100dvh' }
      }
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
                onPeopleResult={(r) => setPeopleResult(i, r)}
              />
            ))}
          </Stack>
        )}
        {/* The reply forming, token by token — replaced by the canonical message when
            the turn's result lands. */}
        {liveText && (
          <Stack gap="xs" align="flex-start" maw="80%" mt="md">
            <Paper bg="slate.1" p="sm" radius="md">
              <MessageMarkdown content={liveText} />
            </Paper>
          </Stack>
        )}
        {/* Outside the empty/non-empty branch: a send that hasn't produced a bubble yet
            must still show progress rather than leave the welcome screen looking idle.
            Hidden while reply tokens are streaming — the forming bubble IS the status. */}
        {busyLabel && !liveText && (
          <Group justify="flex-start" mt="md">
            <Paper bg="slate.1" p="sm" radius="md">
              <Group gap="xs" wrap="nowrap">
                <Loader type="dots" size="xs" color="gray" />
                <Stack gap={2}>
                  <Text size="sm" c="dimmed">
                    {busyLabel}
                  </Text>
                  {busyHint && (
                    <Text size="xs" c="dimmed">
                      {busyHint}
                    </Text>
                  )}
                </Stack>
              </Group>
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
