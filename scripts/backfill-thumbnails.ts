/**
 * One-off backfill: queue a thumbnail job for every stored photo that doesn't
 * have one yet (run with `npx tsx scripts/backfill-thumbnails.ts` against the
 * target DATABASE_URL; the worker does the actual resizing).
 *
 * Idempotent: the job itself skips assets that already carry a `thumb_s3_key`,
 * so re-running only costs queue churn.
 */
import 'dotenv/config';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { enqueueThumbnail } from '@/lib/queue';

async function main() {
  const rows = await db
    .select({ s3Key: assets.s3Key })
    .from(assets)
    .where(and(eq(assets.kind, 'photo'), isNull(assets.thumbS3Key)));
  const keys = new Set(rows.map((r) => r.s3Key));
  for (const s3Key of keys) {
    await enqueueThumbnail({ s3Key });
    console.log(`queued thumbnail: ${s3Key}`);
  }
  console.log(`done — ${keys.size} photo(s) queued`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
