import type { SendResult } from './respond';

/**
 * The wire protocol of POST /api/chat/stream: newline-delimited JSON, one event per
 * line, in order. `text` deltas belong to the model's current step; the `step` event
 * that follows says whether they were the actual reply (`final` — keep them on screen)
 * or pre-tool working notes (`tools` — show as a status line, not as a message).
 * `result` is always last on success and is authoritative — whatever it carries
 * replaces everything accumulated before it.
 */
export type ChatStreamEvent =
  | { type: 'transcript'; text: string }
  | { type: 'text'; text: string }
  | { type: 'step'; kind: 'tools' | 'final' }
  | { type: 'tool'; name: string; args: Record<string, string> }
  | { type: 'result'; result: SendResult }
  | { type: 'error'; message: string };

/** Request body of POST /api/chat/stream — a text message or a recorded voice note. */
export type ChatStreamRequest =
  | {
      kind: 'text';
      conversationId: string | null;
      text: string;
      attachments?: Array<{
        kind: 'photo';
        s3Key: string;
        mimeType: string;
        bytes?: number | null;
        width?: number | null;
        height?: number | null;
      }>;
    }
  | {
      kind: 'voice';
      conversationId: string | null;
      s3Key: string;
      mimeType: string;
      bytes?: number | null;
      durationSec?: number | null;
    };
