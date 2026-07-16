import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { getBookForUser } from '@/lib/books';
import { presignGet } from '@/lib/s3';
import { renderBookHtml, type LayoutChapterContent, type LayoutImage } from '@/lib/book-layout';
import {
  TRIM,
  backfillDimensionsFromThumbnails,
  loadBook,
  loadOrBuildPlan,
  paragraphs,
  referencedAssetIds,
  type PhotoRef,
} from '@/lib/book-content';

/**
 * The live builder preview: the same layout plan the worker prints to PDF,
 * rendered straight to HTML with presigned image URLs instead of embedded
 * `data:` URIs, and Paged.js injected to paginate it client-side
 * (lib/book-layout.ts's `screen` variant). No Chromium, no job queue — this
 * runs in the request/response cycle of the web process, so builder edits
 * show up the moment the page refetches this route (book-builder.tsx keys
 * the iframe on `book.updatedAt`).
 *
 * Never cached: it must always reflect the book's current content.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params;
  const session = await getSession();
  if (!session?.user) return new NextResponse('Unauthorized', { status: 401 });

  // Access gate — loadBook itself does no membership check, so this must run first.
  const book = await getBookForUser(bookId, session.user.id);
  if (!book) return new NextResponse('Not found', { status: 404 });

  const loaded = await loadBook(bookId);
  await backfillDimensionsFromThumbnails(loaded.allPhotosById);
  // The plan is always resolved (and, when missing, built + persisted) from the FULL
  // content — per-viewer filtering happens on the rendered output only, so a partial
  // view can never overwrite the shared stored plan or the worker's PDF render.
  const plan = await loadOrBuildPlan(bookId, loaded);

  // Per-viewer story access (docs/STORY_ACCESS_PLAN.md, Books): chapters the viewer
  // can't read are dropped from the rendered HTML — `getBookForUser` already filtered
  // `book.chapters`, and Paged.js repaginates the partial content client-side.
  const hasHidden = book.hiddenChapterCount > 0;
  const visibleStories = new Set(book.chapters.map((c) => c.storyId));

  // Presign only the photos the plan actually places. Thumbnail first (same
  // resolution budget as the PDF's `preview` variant); falls back to the
  // original when a thumbnail hasn't been generated yet (the worker's
  // `thumbnail` job may not have run for a very recently uploaded photo).
  const needed = referencedAssetIds(plan);
  const resolved = new Map<string, LayoutImage>();
  async function resolveImage(photo: PhotoRef): Promise<LayoutImage | null> {
    if (!photo.width || !photo.height) return null;
    try {
      const src = photo.thumbS3Key
        ? await presignGet(photo.thumbS3Key, 'image/webp')
        : await presignGet(photo.s3Key, photo.mimeType);
      return { assetId: photo.id, src, caption: photo.caption, width: photo.width, height: photo.height };
    } catch (e) {
      console.error(`[preview-html] failed to presign photo ${photo.id}:`, e);
      return null;
    }
  }
  for (const id of needed) {
    const photo = loaded.allPhotosById.get(id);
    if (!photo) continue;
    // Never presign a photo of a hidden chapter — not even as the cover hero.
    if (hasHidden && !visibleStories.has(photo.storyId)) continue;
    const img = await resolveImage(photo);
    if (img) resolved.set(id, img);
  }

  const visibleChapters = hasHidden
    ? loaded.chapters.filter((c) => visibleStories.has(c.storyId))
    : loaded.chapters;
  const chapters: LayoutChapterContent[] = visibleChapters.map((c) => ({
    storyId: c.storyId,
    title: c.title,
    eventLabel: c.eventLabel,
    paragraphs: paragraphs(c.body),
    images: c.photoAssets.map((p) => resolved.get(p.id)).filter((i): i is LayoutImage => !!i),
  }));

  const coverImage = plan.cover.heroAssetId != null ? (resolved.get(plan.cover.heroAssetId) ?? null) : null;

  const html = renderBookHtml({
    variant: 'screen',
    title: loaded.row.title,
    subtitle: loaded.row.subtitle,
    dedication: loaded.row.dedication,
    chronicleName: loaded.chronicleName,
    trim: TRIM[loaded.row.format] ?? TRIM['hardcover-21x28'],
    plan,
    chapters,
    coverImage,
    createdLabel: new Date().toLocaleDateString('de-DE', { year: 'numeric', month: 'long' }),
  });

  return new NextResponse(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
