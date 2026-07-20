'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Group, Progress, Stack, Text } from '@mantine/core';
import { IconAlertCircle, IconPhotoPlus } from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';
import { MAX_PHOTOS_PER_BOOK, PHOTO_ACCEPT, readDimensions } from '@/lib/uploads';
import { readClientExif } from '@/lib/exif-client';
import { addBookPhotosAction, presignBookPhotosAction } from '@/app/(app)/books/actions';
import type { AddBookPhotoInput } from '@/lib/books';
/** How many files upload in parallel — plenty of throughput without saturating the
 *  browser or the presigned-PUT-per-object S3 backend. */
const CONCURRENCY = 5;
/** Register a batch with the server every this many successful uploads, instead of
 *  one giant call at the very end — the grid fills in as uploads land, and a closed
 *  tab loses at most one partial batch (the rest is already registered). */
const FLUSH_SIZE = 10;
const MAX_RETRIES = 2;

/**
 * Multi-select bulk uploader for photo books (docs/PHOTO_BOOK_PLAN.md §3): reads
 * dimensions + EXIF client-side, uploads straight to storage via presigned PUTs
 * through a bounded concurrency pool (so a 150–300 file selection never blocks the
 * main thread or opens hundreds of connections at once), and registers finished
 * uploads with `addBookPhotos` in batches.
 */
export function BulkPhotoUploader({ bookId }: { bookId: string }) {
  const { t } = useI18n();
  const tp = t.books.builder.photoBook;
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [total, setTotal] = useState(0);
  const [settled, setSettled] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function uploadWithRetry(url: string, mimeType: string, file: File, attempt = 0): Promise<void> {
    try {
      const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: file });
      if (!res.ok) throw new Error(`upload failed with status ${res.status}`);
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      return uploadWithRetry(url, mimeType, file, attempt + 1);
    }
  }

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const capped = fileList.length > MAX_PHOTOS_PER_BOOK;
    const files = Array.from(fileList).slice(0, MAX_PHOTOS_PER_BOOK);
    setBusy(true);
    setError(null);
    setTotal(files.length);
    setSettled(0);

    let failedCount = 0;
    let invalidCount = 0;
    let settledCount = 0;
    let registerError: string | null = null;

    try {
      const presigned = await presignBookPhotosAction({
        bookId,
        files: files.map((f) => ({ mimeType: f.type, bytes: f.size })),
      });
      if ('error' in presigned) throw new Error(presigned.error);
      const slots = presigned.uploads;

      let pendingFlush: AddBookPhotoInput[] = [];

      async function flush(force: boolean) {
        if (pendingFlush.length === 0) return;
        if (!force && pendingFlush.length < FLUSH_SIZE) return;
        const batch = pendingFlush;
        pendingFlush = [];
        const result = await addBookPhotosAction({ bookId, photos: batch });
        // Photos in a failed batch are already uploaded to storage but not yet
        // registered — the orphan sweeper reclaims the objects if nothing ever
        // registers them; surfaced so the user knows to retry the selection.
        if (result.error) registerError = result.error;
      }

      let cursor = 0;
      async function worker() {
        while (cursor < files.length) {
          const index = cursor++;
          const file = files[index];
          const slot = slots[index];
          // A missing slot is unexpected (the server always echoes one per file); a
          // present-but-`ok: false` slot is the expected per-file validation failure
          // (unsupported type / over the size limit) — either way this file is
          // skipped without aborting the rest of the batch.
          if (!slot || !slot.ok) {
            invalidCount++;
            settledCount++;
            setSettled(settledCount);
            continue;
          }
          try {
            const [dims, exif] = await Promise.all([readDimensions(file), readClientExif(file)]);
            await uploadWithRetry(slot.url, slot.mimeType, file);
            pendingFlush.push({
              s3Key: slot.s3Key,
              mimeType: slot.mimeType,
              bytes: file.size,
              width: dims?.width,
              height: dims?.height,
              takenAt: exif.takenAt,
              gpsLat: exif.gpsLat,
              gpsLng: exif.gpsLng,
            });
            await flush(false);
          } catch {
            failedCount++;
          } finally {
            settledCount++;
            setSettled(settledCount);
          }
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker()),
      );
      await flush(true);

      router.refresh();
      const messages: string[] = [];
      if (capped) messages.push(tp.selectionCapped(MAX_PHOTOS_PER_BOOK));
      if (invalidCount > 0) messages.push(tp.invalidSkipped(invalidCount));
      if (failedCount > 0) messages.push(tp.someFailed(failedCount));
      if (registerError) messages.push(registerError);
      if (messages.length > 0) setError(messages.join(' '));
    } catch (err) {
      setError(err instanceof Error ? err.message : tp.uploadFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack gap="xs">
      <input
        ref={fileRef}
        type="file"
        accept={PHOTO_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          void handleFiles(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
      />
      <Group>
        <Button
          leftSection={<IconPhotoPlus size={16} />}
          loading={busy}
          onClick={() => fileRef.current?.click()}
        >
          {tp.addPhotos}
        </Button>
        {busy && total > 0 && (
          <Text fz={13} c="dimmed">
            {tp.uploadProgress(settled, total)}
          </Text>
        )}
      </Group>
      {busy && total > 0 && <Progress value={(settled / total) * 100} size="sm" />}
      {error && (
        <Alert color="red" icon={<IconAlertCircle size={16} />}>
          {error}
        </Alert>
      )}
    </Stack>
  );
}
