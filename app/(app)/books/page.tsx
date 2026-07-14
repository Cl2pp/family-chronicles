import { Box, Card, Stack, Text, Title } from '@mantine/core';
import { requireUser } from '@/lib/session';
import { listBooksForUser } from '@/lib/books';
import { getI18n } from '@/lib/i18n/server';
import { BooksView } from './books-view';
import { NewBookButton } from './new-book-button';

export default async function BooksPage() {
  const user = await requireUser();
  const { t } = await getI18n();
  const books = await listBooksForUser(user.id);

  return (
    <Box p="lg" maw={960} mx="auto">
      <Title order={1} mb={4}>
        {t.books.title}
      </Title>
      <Text c="dimmed" mb="lg">
        {t.books.intro}
      </Text>

      {books.length === 0 ? (
        <Card withBorder radius="md" p="xl">
          <Stack align="center" gap="sm" py="lg">
            <Text fw={600} size="lg">
              {t.books.noBooks}
            </Text>
            <Text c="dimmed" ta="center" maw={420}>
              {t.books.noBooksHint}
            </Text>
            <NewBookButton label={t.books.newBook} />
          </Stack>
        </Card>
      ) : (
        <BooksView books={books} />
      )}
    </Box>
  );
}
