import { notFound } from 'next/navigation';
import { and, eq, inArray } from 'drizzle-orm';
import { Box } from '@mantine/core';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { requireUser } from '@/lib/session';
import { getBookForUser, readyStoriesForChronicle } from '@/lib/books';
import { presignGet } from '@/lib/s3';
import { BookBuilder, type CoverOption } from './book-builder';

export default async function BookBuilderPage({
  params,
}: {
  params: Promise<{ bookId: string }>;
}) {
  const { bookId } = await params;
  const user = await requireUser();
  const book = await getBookForUser(bookId, user.id);
  if (!book) notFound();

  const chronicleStories = await readyStoriesForChronicle(book.chronicleId);

  // Cover candidates: photos of the included stories, small presigned thumbnails.
  const includedIds = book.chapters.map((c) => c.storyId);
  const photoRows = includedIds.length
    ? await db
        .select({
          id: assets.id,
          storyId: assets.storyId,
          s3Key: assets.s3Key,
          mimeType: assets.mimeType,
          caption: assets.caption,
        })
        .from(assets)
        .where(and(inArray(assets.storyId, includedIds), eq(assets.kind, 'photo')))
        .limit(60)
    : [];
  const coverOptions: CoverOption[] = await Promise.all(
    photoRows.map(async (p) => ({
      assetId: p.id,
      url: await presignGet(p.s3Key, p.mimeType),
      caption: p.caption,
    })),
  );

  return (
    <Box p="lg" maw={1200} mx="auto">
      <BookBuilder
        book={{
          id: book.id,
          title: book.title,
          subtitle: book.subtitle,
          dedication: book.dedication,
          coverAssetId: book.coverAssetId,
          format: book.format,
          status: book.status,
          errorMessage: book.errorMessage,
          pageCount: book.pageCount,
          hasPreview: Boolean(book.previewS3Key),
          previewVersion: book.updatedAt.getTime(),
          chronicleName: book.chronicleName,
          chapters: book.chapters.map((c) => ({
            storyId: c.storyId,
            title: c.title,
            year: c.eventDate ? c.eventDate.getUTCFullYear() : null,
            photoCount: c.photoCount,
          })),
        }}
        chronicleStories={chronicleStories.map((s) => ({
          id: s.id,
          title: s.title,
          year: s.eventDate ? s.eventDate.getUTCFullYear() : null,
        }))}
        coverOptions={coverOptions}
      />
    </Box>
  );
}
