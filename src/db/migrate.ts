import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

/**
 * Applies db/migrations/*.sql in name order, each in its own transaction, once.
 * Uses its own direct connection: the session advisory lock below does not survive a
 * transaction-mode pooler (PgBouncer / Neon "-pooler" host), so prefer DATABASE_URL_UNPOOLED.
 */
export async function migrate(): Promise<string[]> {
  // Loaded lazily so a skipped `--vercel-build` run doesn't need a valid environment.
  const { config } = await import('../config.js');
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const client = new pg.Client({
    connectionString: config.DATABASE_URL_UNPOOLED ?? config.DATABASE_URL,
    application_name: 'hotel-inventory-migrate',
  });
  await client.connect();
  const applied: string[] = [];
  try {
    // Advisory lock: two app instances booting together won't both migrate.
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    await client.end().catch(() => {});
  }
}

/**
 * `--vercel-build`: run from Vercel's build step. Migrates on production deployments
 * only, so a preview build can never change the live schema before its code ships.
 * Set MIGRATE_ON_BUILD=true on a preview environment that has its own database.
 */
function shouldRun(): boolean {
  if (!process.argv.includes('--vercel-build')) return true;
  return process.env.VERCEL_ENV === 'production' || process.env.MIGRATE_ON_BUILD === 'true';
}

// Run directly: `npm run migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (!shouldRun()) {
    console.log(`migrations skipped (VERCEL_ENV=${process.env.VERCEL_ENV ?? 'unset'}; set MIGRATE_ON_BUILD=true to run)`);
  } else if (process.argv.includes('--vercel-build') && !process.env.DATABASE_URL) {
    // Deploy without a database for now; the next deploy after DATABASE_URL is set migrates.
    console.log('migrations skipped (DATABASE_URL not set; add it in Vercel and redeploy)');
  } else {
    migrate()
      .then((files) => console.log(files.length ? `applied: ${files.join(', ')}` : 'already up to date'))
      .catch((err) => {
        console.error(err);
        process.exit(1);
      });
  }
}
