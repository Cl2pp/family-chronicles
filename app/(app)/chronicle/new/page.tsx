import {
  Anchor,
  Box,
  Button,
  Card,
  Group,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { requireUser } from '@/lib/session';
import { getI18n } from '@/lib/i18n/server';
import { createChronicleAction } from '../actions';

export default async function NewChroniclePage() {
  await requireUser();
  const { t } = await getI18n();

  return (
    <Box p="lg" maw={1100} mx="auto">
      <Stack gap="lg">
        <div>
          <Title order={2}>{t.chronicleNew.title}</Title>
          <Text c="dimmed" mt={4}>
            {t.chronicleNew.intro}
          </Text>
        </div>

        <Card withBorder radius="md" maw={560}>
          <form action={createChronicleAction}>
            <Stack>
              <TextInput
                name="name"
                label={t.settings.chronicleName}
                placeholder={t.chronicleNew.namePlaceholder}
                required
              />
              <Textarea
                name="description"
                label={t.settings.description}
                placeholder={t.chronicleNew.descriptionPlaceholder}
                autosize
                minRows={2}
              />
              <Group justify="space-between" mt="sm">
                <Anchor component="a" href="/chronicle" c="dimmed" size="sm">
                  {t.common.cancel}
                </Anchor>
                <Button type="submit">{t.chronicleNew.create}</Button>
              </Group>
            </Stack>
          </form>
        </Card>
      </Stack>
    </Box>
  );
}
