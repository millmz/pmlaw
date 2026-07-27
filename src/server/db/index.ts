import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as schema from './schema.js';

export type Db = PgliteDatabase<typeof schema>;

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Embedded Postgres (PGlite) — real Postgres semantics with zero infra, per
 * docs/01. Production swaps this for node-postgres against managed Postgres;
 * the Drizzle schema and every query stay identical.
 *
 * @param dataDir omit for in-memory (tests); pass a path to persist.
 */
export async function openDb(dataDir?: string): Promise<{ db: Db; close: () => Promise<void> }> {
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  const db = drizzle(pg, { schema });
  await migrate(db, { migrationsFolder });
  return { db, close: () => pg.close() };
}

export { schema };
