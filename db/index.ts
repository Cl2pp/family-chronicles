import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '@/lib/env';
import * as schema from './schema';

/**
 * Shared Postgres pool + Drizzle instance.
 *
 * In dev, Next.js hot-reload would otherwise spawn a new pool on every reload,
 * exhausting connections — so we cache it on `globalThis`.
 */
const globalForDb = globalThis as unknown as { __pool?: Pool };

const pool =
  globalForDb.__pool ??
  new Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
  });

if (env.NODE_ENV !== 'production') globalForDb.__pool = pool;

export const db = drizzle(pool, { schema });
export { schema };
export type Database = typeof db;
