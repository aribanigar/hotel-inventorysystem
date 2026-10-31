/**
 * Background work: hold expiry, outbox delivery, horizon roll and Channex sync.
 *
 * Two ways to run the same jobs:
 *  - startJobs(): long-running loops, for a normal server or `npm run start:worker`.
 *  - runTick() / runJobsOnce(): bounded runs for serverless (Vercel Cron calls
 *    /api/cron/*). Every job is safe to run twice at once (row leases, SKIP LOCKED,
 *    idempotent writes), so an overlapping cron call does no harm.
 * A job never lets an exception escape.
 */
import { pruneChannexSnapshots, pushDueChannexProperties } from './channels/channex/ari.js';
import { pullChannexBookings } from './channels/channex/bookings.js';
import { expireDueHolds } from './engine/holds.js';
import { logger } from './lib/logger.js';
import { rollHorizon } from './extranet/setup.js';
import { processOutboxBatch } from './outbox/worker.js';

export type JobName = 'hold-sweeper' | 'outbox' | 'horizon-roll' | 'channex-push' | 'channex-bookings' | 'channex-prune';

interface Job {
  name: JobName;
  everyMs: number;
  run: () => Promise<number>;
}

export const JOBS: Job[] = [
  // Sweeper every 15 s: a hold lives at most ~15 s past its 10-minute expiry.
  { name: 'hold-sweeper', everyMs: 15_000, run: () => expireDueHolds() },
  { name: 'outbox', everyMs: 2_000, run: () => processOutboxBatch() },
  // Keep extranet hotels open for sale N days ahead (inserts only missing nights).
  { name: 'horizon-roll', everyMs: 3_600_000, run: () => rollHorizon() },
  // Channex: batched delta pushes (each property throttled to one push per ~6 s),
  // the booking feed as a safety net behind the webhook, and snapshot clean-up.
  { name: 'channex-push', everyMs: 2_000, run: () => pushDueChannexProperties() },
  { name: 'channex-bookings', everyMs: 120_000, run: () => pullChannexBookings() },
  { name: 'channex-prune', everyMs: 21_600_000, run: () => pruneChannexSnapshots() },
];

const byName = new Map(JOBS.map((j) => [j.name, j]));

async function safeRun(job: Job): Promise<number> {
  try {
    const n = await job.run();
    if (n > 0) logger.debug({ job: job.name, processed: n }, 'job tick');
    return n;
  } catch (err) {
    logger.error({ err, job: job.name }, 'job failed');
    return 0;
  }
}

/** Runs the named jobs once each, one after another. Returns items processed per job. */
export async function runJobsOnce(names: JobName[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of names) out[name] = await safeRun(byName.get(name)!);
  return out;
}

/** Jobs a cron tick repeats on their own interval; the slow ones get their own cron entries. */
const TICK_JOBS: JobName[] = ['outbox', 'channex-push', 'hold-sweeper', 'channex-bookings'];

/**
 * Serverless stand-in for the loops: runs the fast jobs on their normal intervals
 * until `budgetMs` has passed, then returns. Called once a minute by cron with a
 * ~50 s budget, it covers the minute almost continuously, so changes still reach
 * channels within a few seconds.
 */
export async function runTick(budgetMs: number, now: () => number = Date.now): Promise<Record<string, number>> {
  const start = now();
  const nextAt = new Map<JobName, number>(TICK_JOBS.map((n) => [n, start]));
  const totals: Record<string, number> = Object.fromEntries(TICK_JOBS.map((n) => [n, 0]));
  for (;;) {
    for (const name of TICK_JOBS) {
      if (now() < nextAt.get(name)!) continue;
      const job = byName.get(name)!;
      totals[name] = (totals[name] ?? 0) + (await safeRun(job));
      nextAt.set(name, now() + job.everyMs);
    }
    const soonest = Math.min(...nextAt.values());
    const end = start + budgetMs;
    if (soonest >= end) return totals;
    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(soonest, end) - now())));
  }
}

type Stop = () => Promise<void>;

function loop(job: Job): Stop {
  let running: Promise<number> | null = null;
  let stopped = false;
  const tick = () => {
    if (running || stopped) return; // previous run still going: skip this tick
    running = safeRun(job).finally(() => {
      running = null;
    });
  };
  const timer = setInterval(tick, job.everyMs);
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}

export function startJobs(): Stop {
  const stops = JOBS.map(loop);
  logger.info('background jobs started');
  return async () => {
    await Promise.all(stops.map((s) => s()));
  };
}
