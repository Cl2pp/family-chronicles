import type { Receipt, StoryDraft } from '@/lib/ai/tools';

export interface ChatAttachment {
  kind: 'audio' | 'photo';
  url: string;
}

export interface Msg {
  /** `system` rows carry only receipts (persistent ✓ chips) — no bubble text. */
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: ChatAttachment[];
  /** Actions the assistant applied this turn (shown as ✓ chips). */
  receipts?: Receipt[];
  /** A story draft awaiting the user's review + save. */
  storyDraft?: StoryDraft | null;
  /** Set once a draft on this message has been saved (created or updated). */
  result?: { kind: 'story' | 'story-update'; storyId: string; chronicleName: string; title: string };
}

export type MsgResult = Msg['result'];
