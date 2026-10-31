/**
 * Background loops: hold expiry sweeper and outbox delivery.
 * Each loop never overlaps itself and never lets an exception escape.
 */
import { pruneChannexSnapshots, pushDueChannexProperties } from './channels/channex/ari.js';
import { pullChannexBookings } from './channels/channex/bookings.js';
import { expireDueHolds } from './engine/holds.js';
import { logger } from './lib/logger.js';
import { rollHorizon } from './extranet/setup.js';
import { processOutboxBatch } from './outbox/worker.js';

type Stop = () => Promise<void>;

function loop(name: string, everyMs: number, fn: () => Promise<number>): Stop {
  let running: Promise<void> | null = null;
  let stopped = false;
  const tick = () => {
    if (running || stopped) return; // previous run still going: skip this tick
    running = fn()
      .then((n) => {
        if (n > 0) logger.debug({ job: name, processed: n }, 'job tick');
      })
      .catch((err) => logger.error({ err, job: name }, 'job failed'))
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, everyMs);
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}

export function startJobs(): Stop {
  const stops = [
    // Sweeper every 15 s: a hold lives at most ~15 s past its 10-minute expiry.
    loop('hold-sweeper', 15_000, () => expireDueHolds()),
    loop('outbox', 2_000, () => processOutboxBatch()),
    // Keep extranet hotels open for sale N days ahead (inserts only missing nights).
    loop('horizon-roll', 3_600_000, () => rollHorizon()),
    // Channex: batched delta pushes (each property throttled to one push per ~6 s),
    // the booking feed as a safety net behind the webhook, and snapshot clean-up.
    loop('channex-push', 2_000, () => pushDueChannexProperties()),
    loop('channex-bookings', 120_000, () => pullChannexBookings()),
    loop('channex-prune', 21_600_000, () => pruneChannexSnapshots()),
  ];
  logger.info('background jobs started');
  return async () => {
    await Promise.all(stops.map((s) => s()));
  };
}
