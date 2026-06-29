'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import { IconCheck, IconSend, IconSparkles } from '@tabler/icons-react';
import type { Proposal, StoryProposal, TreeProposal } from '@/lib/ai/chat';
import { acceptStory, acceptTree, sendMessage } from './actions';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  proposal?: Proposal | null;
  result?: { kind: 'story'; storyId: string } | { kind: 'tree'; name: string };
}

const SUGGESTIONS = ['A childhood memory', 'About Grandma', 'Add a relative to the tree'];

export function ChatView({
  conversationId: initialConversationId,
  initialMessages,
  family,
}: {
  conversationId: string | null;
  initialMessages: { role: 'user' | 'assistant'; content: string }[];
  family?: { id: string; name: string };
}) {
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  if (!family) {
    return (
      <Box p="lg" maw={760} mx="auto">
        <Card withBorder radius="md" p="xl">
          <Stack align="center" gap="sm">
            <Text fw={600} size="lg">
              Create a family first
            </Text>
            <Text c="dimmed" ta="center" maw={420}>
              Chat turns your memories into stories for a family. Make your first family to
              get started.
            </Text>
            <Button component={Link} href="/family/new" mt="sm">
              Create a family
            </Button>
          </Stack>
        </Card>
      </Box>
    );
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', content: trimmed }]);
    setSending(true);
    try {
      const res = await sendMessage({
        conversationId,
        familyId: family!.id,
        text: trimmed,
      });
      setConversationId(res.conversationId);
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: res.reply, proposal: res.proposal },
      ]);
    } catch {
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: 'Sorry — something went wrong. Please try again.' },
      ]);
    } finally {
      setSending(false);
    }
  }

  function setResult(index: number, result: Msg['result']) {
    setMessages((m) => m.map((msg, i) => (i === index ? { ...msg, result } : msg)));
  }

  const empty = messages.length === 0;

  return (
    <Box
      maw={820}
      mx="auto"
      px="md"
      style={{ display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 56px)' }}
    >
      <Box style={{ flex: 1, overflowY: 'auto' }} py="lg">
        {empty ? (
          <Stack gap="lg" mt="xl">
            <Stack gap={4}>
              <Title order={2}>What would you like to do?</Title>
              <Text c="dimmed">
                Talk to me — I&apos;ll write stories and grow your family tree.
              </Text>
            </Stack>
            <Group gap="sm">
              {SUGGESTIONS.map((s) => (
                <Button key={s} variant="light" size="xs" radius="xl" onClick={() => send(s)}>
                  {s}
                </Button>
              ))}
            </Group>
          </Stack>
        ) : (
          <Stack gap="md">
            {messages.map((m, i) => (
              <MessageRow
                key={i}
                msg={m}
                family={family!}
                conversationId={conversationId}
                onResult={(r) => setResult(i, r)}
              />
            ))}
            {sending && (
              <Group justify="flex-start">
                <Paper bg="slate.1" p="sm" radius="md">
                  <Text size="sm" c="dimmed">
                    Thinking…
                  </Text>
                </Paper>
              </Group>
            )}
          </Stack>
        )}
        <div ref={endRef} />
      </Box>

      <Box pb="md">
        <Group
          gap="xs"
          align="flex-end"
          p="xs"
          style={{
            border: '1px solid var(--mantine-color-slate-3)',
            borderRadius: 12,
            background: '#fff',
          }}
        >
          <Textarea
            flex={1}
            variant="unstyled"
            autosize
            minRows={1}
            maxRows={6}
            placeholder="Message…"
            value={input}
            onChange={(e) => setInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
          />
          <ActionIcon
            size={36}
            radius="md"
            disabled={!input.trim() || sending}
            onClick={() => send(input)}
            aria-label="Send"
          >
            <IconSend size={18} />
          </ActionIcon>
        </Group>
      </Box>
    </Box>
  );
}

function MessageRow({
  msg,
  family,
  conversationId,
  onResult,
}: {
  msg: Msg;
  family: { id: string; name: string };
  conversationId: string | null;
  onResult: (r: Msg['result']) => void;
}) {
  if (msg.role === 'user') {
    return (
      <Group justify="flex-end">
        <Paper bg="brand.6" c="white" p="sm" radius="md" maw="80%">
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {msg.content}
          </Text>
        </Paper>
      </Group>
    );
  }

  return (
    <Stack gap="xs" align="flex-start">
      <Paper bg="slate.1" p="sm" radius="md" maw="80%">
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
          {msg.content}
        </Text>
      </Paper>
      {msg.result?.kind === 'story' && (
        <Badge
          color="green"
          variant="light"
          leftSection={<IconCheck size={12} />}
          component={Link}
          href={`/stories/${msg.result.storyId}`}
          style={{ cursor: 'pointer' }}
        >
          Saved to {family.name} — View story
        </Badge>
      )}
      {msg.result?.kind === 'tree' && (
        <Badge color="green" variant="light" leftSection={<IconCheck size={12} />}>
          Added {msg.result.name} to the tree
        </Badge>
      )}
      {msg.proposal && !msg.result && (
        <ProposalCard
          proposal={msg.proposal}
          family={family}
          conversationId={conversationId}
          onResult={onResult}
        />
      )}
    </Stack>
  );
}

function ProposalCard({
  proposal,
  family,
  conversationId,
  onResult,
}: {
  proposal: Proposal;
  family: { id: string; name: string };
  conversationId: string | null;
  onResult: (r: Msg['result']) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  if (discarded) return null;

  if (proposal.kind === 'story') {
    return (
      <StoryDraftCard
        proposal={proposal}
        family={family}
        conversationId={conversationId}
        busy={busy}
        setBusy={setBusy}
        onDiscard={() => setDiscarded(true)}
        onResult={onResult}
      />
    );
  }
  return (
    <TreeChangeCard
      proposal={proposal}
      family={family}
      busy={busy}
      setBusy={setBusy}
      onDiscard={() => setDiscarded(true)}
      onResult={onResult}
    />
  );
}

function StoryDraftCard({
  proposal,
  family,
  conversationId,
  busy,
  setBusy,
  onDiscard,
  onResult,
}: {
  proposal: StoryProposal;
  family: { id: string; name: string };
  conversationId: string | null;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onDiscard: () => void;
  onResult: (r: Msg['result']) => void;
}) {
  const [title, setTitle] = useState(proposal.title);
  const [body, setBody] = useState(proposal.body);
  const [year, setYear] = useState(proposal.eventYear ? String(proposal.eventYear) : '');

  async function accept() {
    setBusy(true);
    try {
      const res = await acceptStory({
        conversationId: conversationId ?? '',
        familyId: family.id,
        proposal: {
          ...proposal,
          title,
          body,
          eventYear: year ? Number(year) : null,
        },
      });
      onResult({ kind: 'story', storyId: res.storyId });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card withBorder radius="md" p="md" maw={560} w="100%">
      <Group gap={6} mb="xs">
        <IconSparkles size={15} color="var(--mantine-color-brand-6)" />
        <Text size="xs" fw={600} c="brand.7" tt="uppercase">
          Story draft · {family.name}
        </Text>
      </Group>
      <TextInput
        label="Title"
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        mb="xs"
      />
      {proposal.summary && (
        <Text size="sm" c="dimmed" mb="xs">
          {proposal.summary}
        </Text>
      )}
      <Textarea
        label="Story"
        value={body}
        onChange={(e) => setBody(e.currentTarget.value)}
        autosize
        minRows={4}
        maxRows={14}
        mb="xs"
      />
      <TextInput
        label="Year (optional)"
        value={year}
        onChange={(e) => setYear(e.currentTarget.value.replace(/[^0-9]/g, ''))}
        w={140}
        mb="md"
      />
      <Group gap="xs">
        <Button size="xs" onClick={accept} loading={busy}>
          Accept &amp; save
        </Button>
        <Button size="xs" variant="default" onClick={onDiscard} disabled={busy}>
          Discard
        </Button>
      </Group>
    </Card>
  );
}

function TreeChangeCard({
  proposal,
  family,
  busy,
  setBusy,
  onDiscard,
  onResult,
}: {
  proposal: TreeProposal;
  family: { id: string; name: string };
  busy: boolean;
  setBusy: (b: boolean) => void;
  onDiscard: () => void;
  onResult: (r: Msg['result']) => void;
}) {
  async function accept() {
    setBusy(true);
    try {
      await acceptTree({ familyId: family.id, proposal });
      onResult({ kind: 'tree', name: proposal.personName });
    } finally {
      setBusy(false);
    }
  }

  const rel =
    proposal.relativeName && proposal.relation
      ? `${proposal.relation} of ${proposal.relativeName}`
      : 'new person';
  const years =
    proposal.bornYear || proposal.diedYear
      ? ` · ${proposal.bornYear ?? ''}–${proposal.diedYear ?? ''}`
      : '';

  return (
    <Card withBorder radius="md" p="md" maw={480} w="100%">
      <Group gap={6} mb="xs">
        <IconSparkles size={15} color="var(--mantine-color-brand-6)" />
        <Text size="xs" fw={600} c="brand.7" tt="uppercase">
          Tree change · {family.name}
        </Text>
      </Group>
      <Text fw={600}>{proposal.personName}</Text>
      <Text size="sm" c="dimmed" mb="md">
        {rel}
        {years}
      </Text>
      <Group gap="xs">
        <Button size="xs" onClick={accept} loading={busy}>
          Add to tree
        </Button>
        <Button size="xs" variant="default" onClick={onDiscard} disabled={busy}>
          Not now
        </Button>
      </Group>
    </Card>
  );
}
