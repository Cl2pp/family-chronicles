import { PgBoss } from 'pg-boss';
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

const globalForBoss = globalThis as unknown as { __boss?: Promise<PgBoss> };

/** Start (once) and return the shared pg-boss instance. */
export async function getBoss(): Promise<PgBoss> {
  if (!globalForBoss.__boss) {
    globalForBoss.__boss = (async () => {
      const boss = new PgBoss({ connectionString: env.DATABASE_URL });
      boss.on('error', (err) => console.error('[pg-boss] error', err));
      await boss.start();
      // createQueue is required in pg-boss v10+; ignore "already exists".
      for (const name of Object.values(QUEUES)) {
        try {
          await boss.createQueue(name);
        } catch {
          /* queue already exists */
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
