'use client';

import { useState, useTransition } from 'react';
import {
  Button,
  CopyButton,
  Group,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconCopy, IconUserPlus } from '@tabler/icons-react';
import { inviteMemberAction } from './actions';

export function InviteButton({ chronicleId }: { chronicleId: string }) {
  const [opened, setOpened] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const form = useForm({
    initialValues: { email: '', role: 'editor' as 'editor' | 'viewer' },
    validate: { email: (v) => (/^\S+@\S+\.\S+$/.test(v) ? null : 'Enter a valid email') },
  });

  function handleSubmit(values: typeof form.values) {
    startTransition(async () => {
      try {
        const { url } = await inviteMemberAction({
          chronicleId,
          email: values.email,
          role: values.role,
        });
        setInviteUrl(url);
      } catch {
        notifications.show({ color: 'red', message: 'Could not create invitation' });
      }
    });
  }

  function close() {
    setOpened(false);
    setInviteUrl(null);
    form.reset();
  }

  return (
    <>
      <Button
        size="xs"
        variant="light"
        leftSection={<IconUserPlus size={14} />}
        onClick={() => setOpened(true)}
      >
        Invite
      </Button>

      <Modal opened={opened} onClose={close} title="Invite a family member">
        {inviteUrl ? (
          <Stack>
            <Text size="sm">
              Share this link with them. They&rsquo;ll join the chronicle after signing in.
            </Text>
            <Group gap="xs" wrap="nowrap">
              <TextInput value={inviteUrl} readOnly style={{ flex: 1 }} />
              <CopyButton value={inviteUrl}>
                {({ copied, copy }) => (
                  <Button
                    variant={copied ? 'filled' : 'default'}
                    onClick={copy}
                    leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                )}
              </CopyButton>
            </Group>
            <Button variant="subtle" onClick={close}>
              Done
            </Button>
          </Stack>
        ) : (
          <form onSubmit={form.onSubmit(handleSubmit)}>
            <Stack>
              <TextInput
                label="Email"
                placeholder="relative@example.com"
                data-autofocus
                {...form.getInputProps('email')}
              />
              <Select
                label="Role"
                data={[
                  { value: 'editor', label: 'Editor — can add and edit stories' },
                  { value: 'viewer', label: 'Viewer — can read only' },
                ]}
                allowDeselect={false}
                {...form.getInputProps('role')}
              />
              <Button type="submit" loading={pending}>
                Create invite link
              </Button>
            </Stack>
          </form>
        )}
      </Modal>
    </>
  );
}
