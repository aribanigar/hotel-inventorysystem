import { config } from './config.js';
import { pool } from './db/pool.js';
import { createApp } from './http/app.js';
import { startJobs } from './jobs.js';
import { logger } from './lib/logger.js';

const app = createApp();
const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'inventory API listening'));
// Slightly above typical load balancer idle timeouts to avoid 502s on keep-alive reuse.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 30_000;

const stopJobs = config.RUN_JOBS_IN_PROCESS ? startJobs() : null;

// A bug in one request must not take the whole booking API down, but state may be
// corrupt after an uncaught exception, so we log and exit; the process manager restarts us.
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled promise rejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception, shutting down');
  void shutdown(1);
});

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down: draining requests');
  const force = setTimeout(() => process.exit(code || 1), 15_000);
  force.unref();
  server.close();
  await stopJobs?.();
  await pool.end().catch(() => {});
  process.exit(code);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
