import type { Proposal } from '@/lib/ai/chat';

export interface ChatAttachment {
  kind: 'audio' | 'photo';
  url: string;
}

export interface Msg {
  role: 'user' | 'assistant';
  content: string;
  attachments?: ChatAttachment[];
  proposal?: Proposal | null;
  result?: { kind: 'story'; storyId: string } | { kind: 'tree'; name: string };
}

export type MsgResult = Msg['result'];
