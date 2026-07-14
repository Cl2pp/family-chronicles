import { notFound } from 'next/navigation';
import { and, eq, inArray } from 'drizzle-orm';
import { Box } from '@mantine/core';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { requireUser } from '@/lib/session';
import { getBookForUser, getBookLayoutSummary, readyStoriesForChronicle } from '@/lib/books';
import { presignGet } from '@/lib/s3';
import { BookBuilder, type CoverOption, type LayoutChapterData } from './book-builder';

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

  // Layout card: the current plan's per-chapter image blocks, with small thumbnails —
  // extends the coverOptions presign pattern above to every photo the plan actually
  // places (not just the 60-cap candidate pool, and not limited to cover candidates).
  const layoutResult = await getBookLayoutSummary(bookId, user.id);
  const layoutSummary = layoutResult.ok ? layoutResult.value : null;
  const thumbByAssetId = new Map(photoRows.map((p) => [p.id, p]));
  const layoutAssetIds = layoutSummary
    ? [...new Set(layoutSummary.chapters.flatMap((c) => c.images.map((i) => i.assetId)))]
    : [];
  const missingIds = layoutAssetIds.filter((id) => !thumbByAssetId.has(id));
  const extraPhotoRows = missingIds.length
    ? await db
        .select({
          id: assets.id,
          s3Key: assets.s3Key,
          thumbS3Key: assets.thumbS3Key,
          mimeType: assets.mimeType,
        })
        .from(assets)
        .where(inArray(assets.id, missingIds))
    : [];
  const layoutThumbUrls = new Map<string, string>();
  await Promise.all(
    [...photoRows, ...extraPhotoRows].map(async (p) => {
      if (!layoutAssetIds.includes(p.id)) return;
      const url = p.thumbS3Key
        ? await presignGet(p.thumbS3Key, 'image/webp')
        : await presignGet(p.s3Key, p.mimeType);
      layoutThumbUrls.set(p.id, url);
    }),
  );
  const layoutChapters: LayoutChapterData[] = (layoutSummary?.chapters ?? []).map((c) => ({
    storyId: c.storyId,
    images: c.images.map((i) => ({ ...i, url: layoutThumbUrls.get(i.assetId) ?? '' })),
  }));

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
          chapters: book.chapters.map((c) => ({
            storyId: c.storyId,
            title: c.title,
            year: c.eventDate ? c.eventDate.getUTCFullYear() : null,
            photoCount: c.photoCount,
          })),
        }}
        layoutChapters={layoutChapters}
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
