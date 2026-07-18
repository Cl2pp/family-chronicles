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
  /** Voice message whose transcription failed — the audio is kept and replayable. */
  transcriptionFailed?: boolean;
  /** Actions the assistant applied this turn (shown as ✓ chips). */
  receipts?: Receipt[];
  /** A story draft awaiting the user's review + save. */
  storyDraft?: StoryDraft | null;
  /** Staged tree edits awaiting the user's Apply/Discard on this message's card. */
  peopleDraft?: PeopleDraft | null;
  /** The stored message carrying `peopleDraft` — Apply/Discard target exactly it. */
  peopleDraftMessageId?: string | null;
  /** Set once the story draft on this message has been saved (created or updated). */
  result?: { kind: 'story' | 'story-update'; storyId: string; chronicleName: string; title: string };
  /** Set once the tree-changes card on this message has been applied. Its own slot —
   *  one message can carry BOTH cards, and each resolves independently. */
  peopleResult?: { receipts: Receipt[]; errors: string[] };
}

export type MsgResult = Msg['result'];
export type MsgPeopleResult = NonNullable<Msg['peopleResult']>;
