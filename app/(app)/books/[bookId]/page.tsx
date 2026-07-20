import { notFound } from 'next/navigation';
import { and, eq, inArray } from 'drizzle-orm';
import { Box } from '@mantine/core';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { requireUser } from '@/lib/session';
import {
  getBookForUser,
  getBookLayoutSummary,
  getPhotoBookStyle,
  listBookPhotos,
  readyStoriesForChronicle,
} from '@/lib/books';
import { loadStoryAccessContext } from '@/lib/story-access';
import { presignGet } from '@/lib/s3';
import { BookBuilder, type CoverOption } from './book-builder';
import { PhotoBookBuilder, type PhotoBookPhotoView } from './photo-book-builder';

export default async function BookBuilderPage({
  params,
}: {
  params: Promise<{ bookId: string }>;
}) {
  const { bookId } = await params;
  const user = await requireUser();
  // One access-context load per request, shared by every per-viewer read below.
  const access = await loadStoryAccessContext(user.id);
  const book = await getBookForUser(bookId, user.id, access);
  if (!book) notFound();

  if (book.kind === 'photo') {
    const [photosResult, styleResult] = await Promise.all([
      listBookPhotos(bookId, user.id),
      getPhotoBookStyle(bookId, user.id),
    ]);
    const rows = photosResult.ok ? photosResult.value.photos : [];
    const photos: PhotoBookPhotoView[] = await Promise.all(
      rows.map(async (p) => ({
        assetId: p.assetId,
        url: p.thumbS3Key
          ? await presignGet(p.thumbS3Key, 'image/webp')
          : await presignGet(p.s3Key, p.mimeType),
        excluded: p.excluded,
        metaSettled: p.metaSettled,
        metaFailed: p.metaFailed,
      })),
    );
    return (
      <Box p="lg" maw={1200} mx="auto">
        <PhotoBookBuilder
          book={{
            id: book.id,
            title: book.title,
            status: book.status,
            errorMessage: book.errorMessage,
            style: styleResult.ok ? styleResult.value.style : 'classic',
            previewVersion: book.updatedAt.getTime(),
            designing: book.designRequestedAt != null,
            layoutSource: book.layoutSource,
            layoutStale: book.layoutStale,
            hasPrint: Boolean(book.printS3Key),
          }}
          photos={photos}
        />
      </Box>
    );
  }

  // Story picker: only stories the acting user can read (per-viewer, like the chapters).
  const chronicleStories = await readyStoriesForChronicle(book.chronicleId, user.id, access);

  // Cover candidates: photos of the included stories. The picker renders 72px
  // tiles, so serve the WebP thumbnail and only fall back to the original for
  // photos whose thumbnail hasn't been generated (yet).
  const includedIds = book.chapters.map((c) => c.storyId);
  const photoRows = includedIds.length
    ? await db
        .select({
          id: assets.id,
          storyId: assets.storyId,
          s3Key: assets.s3Key,
          thumbS3Key: assets.thumbS3Key,
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
      url: p.thumbS3Key
        ? await presignGet(p.thumbS3Key, 'image/webp')
        : await presignGet(p.s3Key, p.mimeType),
      caption: p.caption,
    })),
  );

  // Theme/cover style shown by the settings selects come from the current layout plan.
  const layoutResult = await getBookLayoutSummary(bookId, user.id, access);
  const layoutSummary = layoutResult.ok ? layoutResult.value : null;

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
          designing: book.designRequestedAt != null,
          layoutSource: book.layoutSource,
          theme: layoutSummary?.theme ?? 'classic',
          coverStyle: layoutSummary?.coverStyle ?? 'framed',
          chronicleName: book.chronicleName,
          hiddenChapterCount: book.hiddenChapterCount,
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
