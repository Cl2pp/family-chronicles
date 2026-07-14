import { cookies } from 'next/headers';
import { requireUser } from '@/lib/session';
import { resolveActiveChronicle } from '@/lib/chronicles';
import { resumableConversation } from '@/lib/conversations';
import { getI18n } from '@/lib/i18n/server';
import { buildChatMessages } from './messages';
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
  const initialMessages = convo ? await buildChatMessages(convo.id) : [];

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
