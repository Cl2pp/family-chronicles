import { cookies } from 'next/headers';
import { requireUser } from '@/lib/session';
import { resolveActiveFamily } from '@/lib/families';
import { attachmentsByMessage, latestConversation, listMessages } from '@/lib/conversations';
import { presignGet } from '@/lib/s3';
import type { Receipt } from '@/lib/ai/tools';
import { ChatView } from './chat-view';

export default async function ChatPage() {
  const user = await requireUser();
  const cookieValue = (await cookies()).get('activeFamilyId')?.value;
  const { active } = await resolveActiveFamily(user.id, cookieValue);

  const convo = await latestConversation(user.id);
  const stored = convo ? await listMessages(convo.id) : [];
  const visible = stored.filter((m) => m.role === 'user' || m.role === 'assistant');

  // Resolve in-chat uploads to presigned URLs so history renders audio/photos.
  const attachMap = await attachmentsByMessage(visible.map((m) => m.id));
  const initialMessages = await Promise.all(
    visible.map(async (m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
      receipts: (m.metadata as { receipts?: Receipt[] } | null)?.receipts ?? undefined,
      attachments: await Promise.all(
        (attachMap.get(m.id) ?? []).map(async (a) => ({
          kind: a.kind,
          url: await presignGet(a.s3Key),
        })),
      ),
    })),
  );

  return (
    <ChatView
      conversationId={convo?.id ?? null}
      initialMessages={initialMessages}
      family={active ? { id: active.id, name: active.name } : undefined}
    />
  );
}
