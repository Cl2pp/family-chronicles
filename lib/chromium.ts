import puppeteer, { type Browser } from 'puppeteer';
import { env } from '@/lib/env';

/**
 * The one way this process runs Chromium — and, crucially, one AT A TIME.
 *
 * Chromium plus decoded photos is the most memory-hungry thing this app does, on a box it
 * shares with the web app (INFRASTRUCTURE.md §"worker"). Each queue that needs a browser is
 * already serialized on its own (`batchSize: 1` in `worker/index.ts`), but the queues are
 * independent of each other: a `render-book` print render and a `design-photo-book` proof
 * render (`lib/photo-book-proof.ts`) would happily run two full browsers side by side, each
 * holding its own set of embedded images. This module makes them queue behind one another
 * instead, so peak memory stays at one render's worth no matter which jobs coincide.
 *
 * A fresh browser per acquisition rather than one long-lived instance: renders are minutes
 * apart, a crashed or leaked browser can't poison the next job, and launch cost (~200ms) is
 * noise next to the render itself.
 */

/** Serializes acquisitions. Each caller chains onto the previous one's completion; the
 *  chain never rejects (failures are absorbed here and rethrown to their own caller only),
 *  so one failed render can't wedge every later one. */
let queue: Promise<unknown> = Promise.resolve();

export async function withChromium<T>(label: string, fn: (browser: Browser) => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const browser = await puppeteer.launch({
      executablePath: env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    });
    try {
      return await fn(browser);
    } finally {
      // Never let a close failure mask the render's own error (or its result).
      await browser.close().catch((e) => console.error(`[chromium] closing after ${label} failed:`, e));
    }
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
