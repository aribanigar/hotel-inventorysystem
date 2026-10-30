/** Standalone background worker (hold sweeper + outbox). Run when RUN_JOBS_IN_PROCESS=false. */
import { pool } from './db/pool.js';
import { startJobs } from './jobs.js';
import { logger } from './lib/logger.js';

const stop = startJobs();
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled promise rejection'));

async function shutdown() {
  logger.info('worker shutting down');
  await stop();
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
