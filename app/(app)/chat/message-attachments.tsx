'use client';

import { Image, SimpleGrid } from '@mantine/core';
import type { ChatAttachment } from './types';

/** Renders a message's in-chat uploads: an audio player and/or a photo grid. */
export function MessageAttachments({ attachments }: { attachments: ChatAttachment[] }) {
  if (attachments.length === 0) return null;
  const audio = attachments.filter((a) => a.kind === 'audio');
  const photos = attachments.filter((a) => a.kind === 'photo');

  return (
    <>
      {audio.map((a, i) => (
        <audio key={`audio-${i}`} controls src={a.url} style={{ width: '100%', maxWidth: 320 }} />
      ))}
      {photos.length > 0 && (
        <SimpleGrid cols={{ base: 3, sm: 4 }} spacing="xs" w="100%">
          {photos.map((p, i) => (
            <Image key={`photo-${i}`} src={p.url} radius="sm" h={90} fit="cover" alt="" />
          ))}
        </SimpleGrid>
      )}
    </>
  );
}
