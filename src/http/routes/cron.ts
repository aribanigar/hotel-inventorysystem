/**
 * Scheduled work for serverless hosting (Vercel Cron, see vercel.json).
 *
 *   GET /api/cron/tick     every minute: outbox, Channex push, hold sweeper, booking feed
 *   GET /api/cron/hourly   horizon roll
 *   GET /api/cron/daily    Channex snapshot clean-up
 *
 * Vercel sends "Authorization: Bearer $CRON_SECRET". Any other scheduler can call the
 * same URLs with that header. Refused until CRON_SECRET is set.
 */
import { timingSafeEqual } from 'node:crypto';
import { Router, type Request } from 'express';
import { config } from '../../config.js';
import { runJobsOnce, runTick } from '../../jobs.js';
import { AppError } from '../../lib/errors.js';

export const cronRouter = Router();

function authorised(req: Request): boolean {
  const secret = config.CRON_SECRET;
  if (!secret) return false;
  const got = Buffer.from(req.get('authorization') ?? '');
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

cronRouter.use((req, _res, next) => {
  if (!authorised(req)) return next(new AppError('UNAUTHORIZED', 'Invalid cron credentials'));
  next();
});

cronRouter.get('/tick', async (_req, res) => {
  res.json({ ok: true, processed: await runTick(config.CRON_TICK_BUDGET_MS) });
});

cronRouter.get('/hourly', async (_req, res) => {
  res.json({ ok: true, processed: await runJobsOnce(['horizon-roll']) });
});

cronRouter.get('/daily', async (_req, res) => {
  res.json({ ok: true, processed: await runJobsOnce(['channex-prune']) });
});
