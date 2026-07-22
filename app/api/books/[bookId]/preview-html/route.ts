import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { getBookForUser, type BookDetail } from '@/lib/books';
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
import { renderPhotoBookHtml, type PhotoLayoutImage } from '@/lib/photo-book-layout';
import {
  loadOrBuildPhotoPlan,
  loadPhotoBook,
  photoAssetRenditionNeeds,
  referencedPhotoAssetIds,
  storyParagraphMap,
  type PhotoBookPhotoRef,
} from '@/lib/photo-book-content';
import { screenFontFaceCss } from '@/lib/photo-book-fonts';
import { isLegacyStoryPlan } from '@/lib/book-plan-kind';

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

  // Access gate — loadBook/loadPhotoBook themselves do no membership check, so this
  // must run first.
  const book = await getBookForUser(bookId, session.user.id);
  if (!book) return new NextResponse('Not found', { status: 404 });

  // Engine fork, not a kind fork: every book previews through the photo-book renderer
  // except one still holding a stored story-book plan (see `lib/book-plan-kind.ts`).
  if (!isLegacyStoryPlan(book.layoutPlan)) return photoBookPreview(bookId, book);

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

/**
 * Photo-book counterpart of the story-book preview above (docs/PHOTO_BOOK_PLAN.md PR2):
 * build/resolve the plan (`loadOrBuildPhotoPlan`, `lib/photo-book-content.ts`), presign
 * every photo the plan places — the ~1600px "display" rendition for full-page slots, the
 * 640px thumbnail for grids (`photoAssetRenditionNeeds`) — and render it with the same
 * Paged.js screen-variant plumbing (`lib/photo-book-layout.ts`).
 *
 * Per-viewer story access (unified-book plan): a book built purely from uploads is
 * visible in full to every member with book access — uploading into a shared book IS
 * sharing it. But once a book carries story chapters, the same rule the story books
 * always had applies: a chapter the viewer may not read is dropped from the rendered
 * output, and so are the photos that came from it (`book_photos.story_id` provenance),
 * cover hero included. Filtering happens on the OUTPUT only — the stored plan is always
 * built from the full content, so a partial view can never overwrite it.
 */
async function photoBookPreview(bookId: string, book: BookDetail): Promise<NextResponse> {
  const loaded = await loadPhotoBook(bookId);
  const plan = await loadOrBuildPhotoPlan(bookId, loaded);

  // The caller already loaded this — `getBookForUser` computes the viewer's story-access
  // context, which is the expensive part of this route; re-fetching it here would double
  // that cost on the live-preview hot path.
  const chronicleName = book.chronicleName;
  const hasHidden = book.hiddenChapterCount > 0;
  const visibleStories = new Set(book.chapters.map((c) => c.storyId));

  const byId = new Map(loaded.photos.map((p) => [p.assetId, p]));
  const needed = referencedPhotoAssetIds(plan);
  // Width-aware tiers (slot geometry from the photos' real dimensions): a slot that
  // spans most of the page width presigns the ~1600px display rendition instead of the
  // 640px thumbnail, so the live preview isn't visibly soft on dominant photos.
  const dims = new Map(
    loaded.photos
      .filter((p): p is typeof p & { width: number; height: number } => !!p.width && !!p.height)
      .map((p) => [p.assetId, { width: p.width, height: p.height }]),
  );
  const renditionNeeds = photoAssetRenditionNeeds(
    plan,
    TRIM[loaded.row.format] ?? TRIM['hardcover-21x28'],
    dims,
  );

  async function resolveImage(photo: PhotoBookPhotoRef, level: 'display' | 'thumb'): Promise<PhotoLayoutImage | null> {
    if (!photo.width || !photo.height) return null;
    try {
      const key =
        (level === 'display' ? photo.displayS3Key : null) ?? photo.thumbS3Key ?? photo.s3Key;
      const mime = key === photo.s3Key ? photo.mimeType : 'image/webp';
      const src = await presignGet(key, mime);
      return { assetId: photo.assetId, src, width: photo.width, height: photo.height };
    } catch (e) {
      console.error(`[preview-html] failed to presign photo ${photo.assetId}:`, e);
      return null;
    }
  }

  const resolved = new Map<string, PhotoLayoutImage>();
  for (const id of needed) {
    const photo = byId.get(id);
    // Never presign a photo that came from a chapter this viewer can't read.
    if (photo && hasHidden && photo.storyId && !visibleStories.has(photo.storyId)) continue;
    if (!photo || photo.excluded) continue;
    const image = await resolveImage(photo, renditionNeeds.get(id) ?? 'thumb');
    if (image) resolved.set(id, image);
  }

  // Hidden chapters lose their text as well as their photos: drop their paragraphs so
  // the renderer emits nothing for those sections' text runs.
  const paragraphsByStory = storyParagraphMap(loaded);
  if (hasHidden) {
    for (const storyId of paragraphsByStory.keys()) {
      if (!visibleStories.has(storyId)) paragraphsByStory.delete(storyId);
    }
  }

  const html = renderPhotoBookHtml({
    variant: 'screen',
    chronicleName,
    trim: TRIM[loaded.row.format] ?? TRIM['hardcover-21x28'],
    plan,
    images: resolved,
    fontFaceCss: screenFontFaceCss(plan.style),
    createdLabel: new Date().toLocaleDateString('de-DE', { year: 'numeric', month: 'long' }),
    storyParagraphs: paragraphsByStory,
  });

  return new NextResponse(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
