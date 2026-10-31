import { attachDatabasePool } from '@vercel/functions';
import pg from 'pg';
import { config, onVercel } from '../config.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

// DATE columns come back as 'YYYY-MM-DD' strings, never JS Dates. A JS Date would
// shift the night by a day for any server not running in IST.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
// BIGINT (prices in paise) as number, but refuse values that would lose precision.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 value out of safe range: ${v}`);
  return n;
});

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
  connectionTimeoutMillis: 5_000, // fail fast if the pool is exhausted instead of hanging checkout
  idleTimeoutMillis: 30_000,
  application_name: 'hotel-inventory',
});

// An idle client losing its connection emits 'error' on the pool. Without this
// listener Node treats it as an unhandled error event and the process crashes.
pool.on('error', (err) => logger.error({ err }, 'idle postgres client error'));
// On Vercel, keep a suspended instance alive just long enough to close idle
// connections, so they don't pile up on the database between invocations.
if (onVercel) attachDatabasePool(pool);

export type Db = pg.PoolClient | pg.Pool;

// Postgres SQLSTATEs we treat specially.
const DEADLOCK = '40P01';
const SERIALIZATION_FAILURE = '40001';
const LOCK_NOT_AVAILABLE = '55P03'; // raised when lock_timeout expires
const QUERY_CANCELED = '57014'; //     raised when statement_timeout expires

export interface TxOptions {
  /** Max time to wait for a row lock before giving up with INVENTORY_BUSY. */
  lockTimeoutMs?: number;
  /** Max time any single statement may run. */
  statementTimeoutMs?: number;
  /** Retries on deadlock / serialization failure (both are safe to replay). */
  retries?: number;
}

/**
 * Runs `fn` inside BEGIN/COMMIT on a dedicated connection.
 * - Any thrown error rolls back, which also releases every row lock taken inside.
 * - Deadlocks are retried with jittered backoff: Postgres already aborted one side,
 *   so replaying the whole transaction is the correct recovery.
 * - Lock waits are bounded, so a stuck transaction elsewhere can never freeze checkout.
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  const { lockTimeoutMs = 3_000, statementTimeoutMs = 10_000, retries = 2 } = opts;

  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect().catch((err: unknown) => {
      throw new AppError('INVENTORY_BUSY', 'Database is busy, please retry', undefined, { cause: err });
    });
    let broken = false;
    try {
      await client.query('BEGIN');
      // set_config(..., true) == SET LOCAL: applies to this transaction only.
      await client.query("SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)", [
        `${lockTimeoutMs}ms`,
        `${statementTimeoutMs}ms`,
      ]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        // Connection is unusable: destroy it instead of returning it to the pool.
        broken = true;
        logger.error({ err: rollbackErr }, 'rollback failed; discarding connection');
      }

      const code = (err as { code?: string }).code;
      if ((code === DEADLOCK || code === SERIALIZATION_FAILURE) && attempt < retries) {
        const delay = 20 * 2 ** attempt + Math.floor(Math.random() * 30);
        logger.warn({ code, attempt, delay }, 'transaction conflict, retrying');
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (code === LOCK_NOT_AVAILABLE || code === QUERY_CANCELED || code === DEADLOCK) {
        throw new AppError('INVENTORY_BUSY', 'Inventory is being updated, please retry in a moment', undefined, { cause: err });
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }
}
