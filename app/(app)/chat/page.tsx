import { cookies } from 'next/headers';
import { requireUser } from '@/lib/session';
import { resolveActiveFamily } from '@/lib/families';
import { latestConversation, listMessages } from '@/lib/conversations';
import { ChatView } from './chat-view';

export default async function ChatPage() {
  const user = await requireUser();
  const cookieValue = (await cookies()).get('activeFamilyId')?.value;
  const { active } = await resolveActiveFamily(user.id, cookieValue);

  const convo = await latestConversation(user.id);
  const stored = convo ? await listMessages(convo.id) : [];
  const initialMessages = stored
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  return (
    <ChatView
      conversationId={convo?.id ?? null}
      initialMessages={initialMessages}
      family={active ? { id: active.id, name: active.name } : undefined}
    />
  );
}
