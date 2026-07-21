import { PgBoss } from 'pg-boss';
import type { QueueOptions } from 'pg-boss';
import { env } from '@/lib/env';

/** Job queue names. */
export const QUEUES = {
  style: 'style',
  sweepOrphans: 'sweep-orphans',
  transcode: 'transcode',
  renderBook: 'render-book',
  thumbnail: 'thumbnail',
  designBook: 'design-book',
  photoMeta: 'photo-meta',
  photoVision: 'photo-vision',
  designPhotoBook: 'design-photo-book',
} as const;

/** Nightly, off-peak — the sweep lists every object under the upload prefixes. */
export const SWEEP_ORPHANS_CRON = '17 4 * * *';

export interface StyleJob {
  storyId: string;
}

/** Re-encode a stored voice note into a format every browser can play. */
export interface TranscodeJob {
  s3Key: string;
}

/** Typeset a book into preview + print PDFs (Chromium — memory-heavy, runs serially). */
export interface RenderBookJob {
  bookId: string;
}

/** Downscale a stored photo into a thumbnail for grids and banners. */
export interface ThumbnailJob {
  s3Key: string;
}

/** Run the AI design pass on a book, falling back to the auto-layouter on failure. */
export interface DesignBookJob {
  bookId: string;
}

/** Extract deterministic metadata (dimensions, EXIF, phash, blur) for one book photo. */
export interface PhotoMetaJob {
  assetId: string;
}

/** Score a batch of ~10 book photos with the vision model (docs/PHOTO_BOOK_PLAN.md §4) —
 *  writes `book_photos.analysis`/`analysis_status` per photo. */
export interface PhotoVisionJob {
  assetIds: string[];
}

/** Run the photo-book AI design pass on a book, falling back to the auto-layouter on
 *  failure — the photo-book counterpart of `DesignBookJob`. */
export interface DesignPhotoBookJob {
  bookId: string;
}

/** Per-queue overrides for pg-boss's `QueueOptions` (default: no retries beyond
 *  pg-boss's own default of 2). `photo-meta` gets a bounded, backed-off retry so a
 *  transient S3/network blip recovers on its own — see `handlePhotoMeta` in
 *  `worker/index.ts`, which marks a photo settled-but-failed once these are
 *  exhausted, rather than swallowing the error and leaving it pending forever. */
const QUEUE_OPTIONS: Partial<Record<keyof typeof QUEUES, QueueOptions>> = {
  photoMeta: { retryLimit: 4, retryDelay: 15, retryBackoff: true },
  // Same bounded, backed-off retry as photo-meta, for the same reason: a transient
  // OpenRouter/network blip recovers on its own, and once retries are exhausted the
  // worker (`handlePhotoVision`) marks the batch's still-unscored photos settled-but-
  // failed so the builder's analysis-progress poll can terminate.
  photoVision: { retryLimit: 4, retryDelay: 15, retryBackoff: true },
  // The photo-book design pass is the longest-running job in the system: two vision calls
  // with a Chromium proof render between them (`lib/photo-book-ai-layout.ts`), measured at
  // ~3.5-4.5 minutes for a 36-photo book and scaling with photo count up to
  // MAX_PHOTOS_PER_BOOK (300). pg-boss's default expiry is 15 minutes, which a large book
  // could plausibly cross — and the default retry would then start a SECOND full pass
  // (two more paid model calls) over a book whose first pass may still be running.
  // Generous ceiling, and no retry: if a pass really dies, `isDesignInFlight`
  // (`lib/photo-book-design-stage.ts`) releases the book after 20 minutes and the user can
  // ask for it again deliberately, rather than silently paying for it twice.
  designPhotoBook: { expireInSeconds: 1800, retryLimit: 0 },
};

const globalForBoss = globalThis as unknown as { __boss?: Promise<PgBoss> };

/** Start (once) and return the shared pg-boss instance. */
export async function getBoss(): Promise<PgBoss> {
  if (!globalForBoss.__boss) {
    globalForBoss.__boss = (async () => {
      const boss = new PgBoss({ connectionString: env.DATABASE_URL });
      boss.on('error', (err) => console.error('[pg-boss] error', err));
      await boss.start();
      // createQueue is required in pg-boss v10+. `createQueue` only applies QUEUE_OPTIONS
      // when it actually creates the queue, so an already-existing queue would keep
      // whatever options it was born with — which is how a policy change (e.g. giving
      // `design-photo-book` a longer expiry once the pass grew a second model call) would
      // silently never reach production. `updateQueue` afterwards makes the map above the
      // real source of truth on every boot, for new and existing queues alike.
      for (const [key, name] of Object.entries(QUEUES) as [keyof typeof QUEUES, string][]) {
        const options = QUEUE_OPTIONS[key];
        try {
          await boss.createQueue(name, options);
        } catch {
          /* queue already exists */
        }
        if (!options) continue;
        try {
          await boss.updateQueue(name, options);
        } catch (e) {
          // Non-fatal: the queue keeps its previous options and the worker still runs.
          console.error(`[pg-boss] could not update options for queue ${name}:`, e);
        }
      }
      return boss;
    })();
  }
  return globalForBoss.__boss;
}

export async function enqueueStyle(data: StyleJob): Promise<void> {
  const boss = await getBoss();
  await boss.send(QUEUES.style, data);
}

export async function enqueueTranscode(data: TranscodeJob): Promise<void> {
  const boss = await getBoss();
  await boss.send(QUEUES.transcode, data);
}

export async function enqueueRenderBook(data: RenderBookJob): Promise<void> {
  const boss = await getBoss();
  await boss.send(QUEUES.renderBook, data);
}

export async function enqueueThumbnail(data: ThumbnailJob): Promise<void> {
  const boss = await getBoss();
  await boss.send(QUEUES.thumbnail, data);
}

export async function enqueueDesignBook(data: DesignBookJob): Promise<void> {
  const boss = await getBoss();
  await boss.send(QUEUES.designBook, data);
}

export async function enqueuePhotoMeta(data: PhotoMetaJob): Promise<void> {
  const boss = await getBoss();
  await boss.send(QUEUES.photoMeta, data);
}

export async function enqueuePhotoVision(data: PhotoVisionJob): Promise<void> {
  const boss = await getBoss();
  await boss.send(QUEUES.photoVision, data);
}

export async function enqueueDesignPhotoBook(data: DesignPhotoBookJob): Promise<void> {
  const boss = await getBoss();
  await boss.send(QUEUES.designPhotoBook, data);
}
