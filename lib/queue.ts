import { PgBoss } from 'pg-boss';
import { env } from '@/lib/env';

/** Job queue names. */
export const QUEUES = {
  style: 'style',
  sweepOrphans: 'sweep-orphans',
  transcode: 'transcode',
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
