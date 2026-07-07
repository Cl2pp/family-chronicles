'use client';

import { useState } from 'react';
import { ActionIcon, Button, Group, Modal, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconTrash } from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';
import { deletePersonAction } from './actions';

/** Trash button + confirm dialog that removes a person from the active chronicle's tree. */
export function DeletePersonButton({
  chronicleId,
  personId,
  name,
}: {
  chronicleId: string;
  personId: string;
  name: string;
}) {
  const { t } = useI18n();
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await deletePersonAction({ chronicleId, personId });
      notifications.show({ message: t.person.deleted(name) });
      setOpened(false);
    } catch (err) {
      notifications.show({
        color: 'red',
        message: err instanceof Error ? err.message : t.person.couldNotDelete,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ActionIcon
        variant="subtle"
        color="red"
        aria-label={t.person.deleteAria(name)}
        onClick={() => setOpened(true)}
      >
        <IconTrash size={16} />
      </ActionIcon>
      <Modal opened={opened} onClose={() => setOpened(false)} title={t.person.deleteTitle} centered>
        <Text size="sm">{t.person.deleteConfirm(name)}</Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={() => setOpened(false)} disabled={busy}>
            {t.common.cancel}
          </Button>
          <Button color="red" onClick={confirm} loading={busy}>
            {t.common.delete}
          </Button>
        </Group>
      </Modal>
    </>
  );
}
