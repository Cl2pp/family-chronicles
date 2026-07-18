import { z } from 'zod';
import { getSession } from '@/lib/session';
import { runTextTurn, runVoiceTurn } from '@/app/(app)/chat/respond';
import type { ChatStreamEvent } from '@/app/(app)/chat/stream-events';

/**
 * The chat send endpoint: runs the agent turn and streams progress back as
 * newline-delimited JSON (`ChatStreamEvent` per line) — live status while tools run,
 * token deltas for the reply, then one authoritative `result` event. A server action
 * can't stream, hence a route handler; the recovery path (`syncChat`) stays an action
 * and reuses the same turn pipeline from ../respond.
 */

const attachment = z.object({
  kind: z.literal('photo'),
  s3Key: z.string().min(1),
  mimeType: z.string().min(1),
  bytes: z.number().nullish(),
  width: z.number().nullish(),
  height: z.number().nullish(),
});

const body = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    conversationId: z.string().nullable(),
    text: z.string(),
    attachments: z.array(attachment).max(20).optional(),
  }),
  z.object({
    kind: z.literal('voice'),
    conversationId: z.string().nullable(),
    s3Key: z.string().min(1),
    mimeType: z.string().min(1),
    bytes: z.number().nullish(),
    durationSec: z.number().nullish(),
  }),
]);

export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session?.user) return new Response('Unauthorized', { status: 401 });
  const user = { id: session.user.id, name: session.user.name };

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return new Response('Bad request', { status: 400 });
  const input = parsed.data;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // A backgrounded mobile tab kills the connection mid-turn; the turn must still
      // finish and store its reply (that's what the client's reconcile sync recovers
      // from), so a failed enqueue is swallowed rather than allowed to abort the run.
      let open = true;
      const send = (event: ChatStreamEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false;
        }
      };

      try {
        const result =
          input.kind === 'text'
            ? await runTextTurn(
                user,
                {
                  conversationId: input.conversationId,
                  text: input.text,
                  attachments: input.attachments ?? [],
                },
                send,
              )
            : await runVoiceTurn(
                user,
                input,
                send,
                (transcript) => send({ type: 'transcript', text: transcript }),
                (stage) => send({ type: 'stage', stage }),
              );
        send({ type: 'result', result });
      } catch (err) {
        console.error('Chat stream turn failed:', err);
        send({
          type: 'error',
          message: err instanceof Error ? err.message : 'The reply could not be generated.',
        });
      } finally {
        open = false;
        try {
          controller.close();
        } catch {
          // already closed by a client disconnect
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
