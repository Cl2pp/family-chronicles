import type { Receipt, StoryDraft } from '@/lib/ai/tools';
import type { PeopleDraft } from '@/lib/people-changes';

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
  /** Staged tree edits awaiting the user's Apply/Discard on this message's card. */
  peopleDraft?: PeopleDraft | null;
  /** Set once a draft on this message has been resolved. */
  result?:
    | { kind: 'story' | 'story-update'; storyId: string; chronicleName: string; title: string }
    | { kind: 'people'; receipts: Receipt[]; errors: string[] };
}

export type MsgResult = Msg['result'];
