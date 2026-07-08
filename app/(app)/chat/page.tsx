import { cookies } from 'next/headers';
import { requireUser } from '@/lib/session';
import { resolveActiveChronicle } from '@/lib/chronicles';
import { attachmentsByMessage, listMessages, resumableConversation } from '@/lib/conversations';
import { presignGet } from '@/lib/s3';
import { getI18n } from '@/lib/i18n/server';
import type { Receipt } from '@/lib/ai/tools';
import { ChatView } from './chat-view';

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ intent?: string }>;
}) {
  const { intent } = await searchParams;
  const user = await requireUser();
  const { t } = await getI18n();
  const cookieValue = (await cookies()).get('activeChronicleId')?.value;
  const { active } = await resolveActiveChronicle(user.id, cookieValue);

  const convo = await resumableConversation(user.id);
  const stored = convo ? await listMessages(convo.id) : [];
  // System rows are agent-only notes — except ones carrying receipts, which render
  // as persistent ✓ chips (e.g. "Saved <story>"); their note text stays hidden.
  const visible = stored.filter(
    (m) =>
      m.role === 'user' ||
      m.role === 'assistant' ||
      (m.role === 'system' && (m.metadata as { receipts?: Receipt[] } | null)?.receipts?.length),
  );

  // Resolve in-chat uploads to presigned URLs so history renders audio/photos.
  const attachMap = await attachmentsByMessage(visible.map((m) => m.id));
  const initialMessages = await Promise.all(
    visible.map(async (m) => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.role === 'system' ? '' : m.content,
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
      lastActivityAt={convo?.updatedAt.getTime() ?? null}
      chronicle={active ? { id: active.id, name: active.name } : undefined}
      autoPrompt={intent === 'add-story' ? t.chat.addStoryPrompt : undefined}
    />
  );
}
