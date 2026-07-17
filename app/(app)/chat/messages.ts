import { attachmentsByMessage, listMessages } from '@/lib/conversations';
import { presignGet } from '@/lib/s3';
import type { Receipt, StoryDraft } from '@/lib/ai/tools';
import type { PeopleDraft } from '@/lib/people-changes';
import type { Msg } from './types';

/** What `messages.metadata` can hold, as written by the chat server actions. */
export type MessageMetadata = {
  receipts?: Receipt[];
  storyDraft?: StoryDraft;
  /** Set once the user saved or discarded this message's draft card. */
  draftResolved?: boolean;
  peopleDraft?: PeopleDraft;
  /** Set once the user applied or discarded this message's tree-changes card. */
  peopleDraftResolved?: boolean;
} | null;

/**
 * The conversation as the client renders it: visible rows only, receipts and any
 * still-live draft card from metadata, uploads resolved to presigned URLs. Shared by
 * the page's initial render and the `syncChat` recovery action, so a resumed mobile
 * tab reconciles to exactly what a fresh load would show.
 */
export async function buildChatMessages(conversationId: string): Promise<Msg[]> {
  const stored = await listMessages(conversationId);
  // System rows are agent-only notes — except ones carrying receipts, which render
  // as persistent ✓ chips (e.g. "Saved <story>"); their note text stays hidden.
  const visible = stored.filter(
    (m) =>
      m.role === 'user' ||
      m.role === 'assistant' ||
      (m.role === 'system' && (m.metadata as MessageMetadata)?.receipts?.length),
  );

  const attachMap = await attachmentsByMessage(visible.map((m) => m.id));
  return Promise.all(
    visible.map(async (m) => {
      const meta = m.metadata as MessageMetadata;
      return {
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.role === 'system' ? '' : m.content,
        receipts: meta?.receipts ?? undefined,
        // A card the user never saved or discarded is still live — re-render it so a
        // reload (or the PWA being backgrounded) doesn't silently drop the story.
        storyDraft: meta?.storyDraft && !meta.draftResolved ? meta.storyDraft : undefined,
        peopleDraft: meta?.peopleDraft && !meta.peopleDraftResolved ? meta.peopleDraft : undefined,
        attachments: await Promise.all(
          (attachMap.get(m.id) ?? []).map(async (a) => ({
            kind: a.kind,
            url: await presignGet(a.s3Key, a.mimeType),
          })),
        ),
      };
    }),
  );
}
