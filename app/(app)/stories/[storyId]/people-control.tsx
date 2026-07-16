'use client';

import { useMemo, useState, useTransition } from 'react';
import { Alert, Badge, Button, Group, MultiSelect, Stack, Text } from '@mantine/core';
import { IconCheck, IconUsers, IconX } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n/client';
import { setStoryPeople } from './actions';

type Person = { id: string; displayName: string };

/**
 * "Who is in this story" — shows the tagged people and, for editors, lets them pick
 * the tree members a story is about. Those people drive the story's family tags.
 */
export function StoryPeopleControl({
  storyId,
  candidates,
  tagged,
  canEdit,
}: {
  storyId: string;
  candidates: Person[];
  tagged: Person[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<string[]>(tagged.map((p) => p.id));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Offer every candidate, plus any already-tagged person who is no longer a
  // candidate (e.g. they left the chronicle) so a save never silently drops them.
  const data = useMemo(() => {
    const byId = new Map(candidates.map((c) => [c.id, c.displayName]));
    for (const p of tagged) if (!byId.has(p.id)) byId.set(p.id, p.displayName);
    return [...byId.entries()].map(([id, label]) => ({ value: id, label }));
  }, [candidates, tagged]);

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await setStoryPeople({ storyId, personIds: value });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  function cancel() {
    setValue(tagged.map((p) => p.id));
    setError(null);
    setEditing(false);
  }

  if (editing) {
    return (
      <Stack gap="xs">
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <MultiSelect
          label={t.story.peopleLabel}
          description={t.story.peopleDescription}
          placeholder={t.story.peoplePlaceholder}
          data={data}
          value={value}
          onChange={setValue}
          searchable
          clearable
          nothingFoundMessage={t.story.peopleNoneFound}
          maxDropdownHeight={260}
          disabled={pending}
        />
        <Group gap="xs">
          <Button
            size="xs"
            leftSection={<IconCheck size={14} />}
            onClick={save}
            loading={pending}
          >
            {t.common.saveChanges}
          </Button>
          <Button
            size="xs"
            variant="default"
            leftSection={<IconX size={14} />}
            onClick={cancel}
            disabled={pending}
          >
            {t.common.cancel}
          </Button>
        </Group>
      </Stack>
    );
  }

  return (
    <Group gap="xs" align="center">
      <Text size="sm" c="dimmed">
        {t.story.people}
      </Text>
      {tagged.length > 0 ? (
        tagged.map((p) => (
          <Badge key={p.id} variant="light" color="gray" radius="sm">
            {p.displayName}
          </Badge>
        ))
      ) : (
        <Text size="sm" c="dimmed" fs="italic">
          {t.story.noPeopleYet}
        </Text>
      )}
      {canEdit && (
        <Button
          size="compact-xs"
          variant="subtle"
          leftSection={<IconUsers size={14} />}
          onClick={() => setEditing(true)}
        >
          {tagged.length > 0 ? t.story.editPeople : t.story.identifyPeople}
        </Button>
      )}
    </Group>
  );
}
