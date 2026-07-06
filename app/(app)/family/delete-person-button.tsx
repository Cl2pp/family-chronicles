'use client';

import { useState } from 'react';
import { ActionIcon, Button, Group, Modal, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconTrash } from '@tabler/icons-react';
import { deletePersonAction } from './actions';

/** Trash button + confirm dialog that removes a person from the active family's tree. */
export function DeletePersonButton({
  familyId,
  personId,
  name,
}: {
  familyId: string;
  personId: string;
  name: string;
}) {
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await deletePersonAction({ familyId, personId });
      notifications.show({ message: `Removed ${name} from the tree.` });
      setOpened(false);
    } catch (err) {
      notifications.show({
        color: 'red',
        message: err instanceof Error ? err.message : 'Could not delete that person.',
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
        aria-label={`Delete ${name}`}
        onClick={() => setOpened(true)}
      >
        <IconTrash size={16} />
      </ActionIcon>
      <Modal opened={opened} onClose={() => setOpened(false)} title="Delete person" centered>
        <Text size="sm">
          Remove <strong>{name}</strong> from the tree? This also deletes their relationships and
          cannot be undone.
        </Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={() => setOpened(false)} disabled={busy}>
            Cancel
          </Button>
          <Button color="red" onClick={confirm} loading={busy}>
            Delete
          </Button>
        </Group>
      </Modal>
    </>
  );
}
