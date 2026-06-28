'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Group, Stack, Text } from '@mantine/core';
import { IconMicrophone, IconPlayerStopFilled, IconTrash } from '@tabler/icons-react';

export interface RecordedAudio {
  blob: Blob;
  mimeType: string;
  durationSec: number;
}

function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  if (typeof MediaRecorder === 'undefined') return '';
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export function AudioRecorder({ onChange }: { onChange: (a: RecordedAudio | null) => void }) {
  const [state, setState] = useState<'idle' | 'recording' | 'recorded'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickMimeType();
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const type = rec.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        const durationSec = Math.max(1, Math.round((Date.now() - startRef.current) / 1000));
        const url = URL.createObjectURL(blob);
        setPreviewUrl(url);
        setState('recorded');
        onChange({ blob, mimeType: type, durationSec });
        streamRef.current?.getTracks().forEach((t) => t.stop());
      };

      recorderRef.current = rec;
      startRef.current = Date.now();
      setElapsed(0);
      rec.start();
      setState('recording');
      timerRef.current = setInterval(
        () => setElapsed(Math.round((Date.now() - startRef.current) / 1000)),
        500,
      );
    } catch {
      setError('Microphone access was denied or is unavailable.');
    }
  }

  function stop() {
    recorderRef.current?.stop();
    if (timerRef.current) clearInterval(timerRef.current);
  }

  function reset() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setState('idle');
    setElapsed(0);
    onChange(null);
  }

  return (
    <Stack gap="xs">
      {state === 'idle' && (
        <Button
          variant="light"
          leftSection={<IconMicrophone size={16} />}
          onClick={start}
          w="fit-content"
        >
          Start recording
        </Button>
      )}

      {state === 'recording' && (
        <Group>
          <Button
            color="red"
            leftSection={<IconPlayerStopFilled size={16} />}
            onClick={stop}
          >
            Stop
          </Button>
          <Text c="red">● {formatTime(elapsed)}</Text>
        </Group>
      )}

      {state === 'recorded' && previewUrl && (
        <Stack gap="xs">
          <audio controls src={previewUrl} style={{ width: '100%' }} />
          <Button
            variant="subtle"
            color="gray"
            leftSection={<IconTrash size={16} />}
            onClick={reset}
            w="fit-content"
          >
            Record again
          </Button>
        </Stack>
      )}

      {error && (
        <Text c="red" size="sm">
          {error}
        </Text>
      )}
    </Stack>
  );
}
