/**
 * Outbox delivery worker: pushes inventory changes and reservations to subscribed
 * channels (the hotel's channel manager, partner OTAs and websites) and finalises
 * supplier bookings.
 *
 * Delivery guarantees:
 *  - At-least-once. Receivers de-duplicate on the X-Event-Id header.
 *  - ARI_CHANGED sends the CURRENT state of the changed range, not a delta, so a
 *    receiver that gets events out of order still converges to the truth.
 *  - Retry schedule after a failure: 5 s, 15 s, 30 s, 60 s (SiteMinder's published
 *    schedule), then DEAD + an ALERT log line for a human.
 *  - Rows are claimed with SKIP LOCKED and a lease, so several workers can run and a
 *    crashed worker's rows are picked up again after the lease expires.
 */
import { pool } from '../db/pool.js';
import { bookExternal } from '../inventory/external.js';
import { hmacSha256Hex } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { HttpCallError, requestJson } from '../lib/http.js';
import { logger } from '../lib/logger.js';

const RETRY_DELAYS_S = [5, 15, 30, 60];
const MAX_ATTEMPTS = RETRY_DELAYS_S.length + 1;
const LEASE_SECONDS = 60;

interface OutboxRow {
  id: string;
  event_type: 'ARI_CHANGED' | 'RESERVATION_CREATED' | 'SUPPLIER_BOOK';
  hotel_id: string;
  subscription_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
}

/** Thrown for failures that retrying cannot fix (e.g. receiver says 400). */
class PermanentFailure extends Error {}

export async function processOutboxBatch(limit = 20): Promise<number> {
  // Claim: flip due rows to IN_FLIGHT with a lease, in one statement.
  const { rows } = await pool.query<OutboxRow>(
    `UPDATE ari_outbox o
        SET status = 'IN_FLIGHT', attempts = attempts + 1,
            locked_until = now() + make_interval(secs => $2)
      WHERE o.id IN (
              SELECT id FROM ari_outbox
               WHERE (status = 'PENDING' AND next_attempt_at <= now())
                  OR (status = 'IN_FLIGHT' AND locked_until < now())
               ORDER BY id
               LIMIT $1
               FOR UPDATE SKIP LOCKED)
      RETURNING o.id, o.event_type, o.hotel_id, o.subscription_id, o.payload, o.attempts`,
    [limit, LEASE_SECONDS],
  );

  // Deliver in parallel; one slow receiver doesn't hold up the rest of the batch.
  await Promise.allSettled(rows.map((row) => deliverOne(row)));
  return rows.length;
}

async function deliverOne(row: OutboxRow): Promise<void> {
  try {
    if (row.event_type === 'SUPPLIER_BOOK') await finaliseSupplierBooking(row);
    else await deliverToSubscriber(row);
    await pool.query(`UPDATE ari_outbox SET status = 'DONE', processed_at = now(), last_error = NULL, locked_until = NULL WHERE id = $1`, [row.id]);
  } catch (err) {
    const message = (err as Error).message?.slice(0, 500) ?? 'unknown error';
    const permanent = err instanceof PermanentFailure;
    if (permanent || row.attempts >= MAX_ATTEMPTS) {
      await pool.query(`UPDATE ari_outbox SET status = 'DEAD', last_error = $2, locked_until = NULL WHERE id = $1`, [row.id, message]);
      logger.error({ outboxId: row.id, event: row.event_type, hotelId: row.hotel_id, attempts: row.attempts, message }, 'ALERT: outbox event dead-lettered');
      if (row.event_type === 'SUPPLIER_BOOK') await flagRefund(row, `supplier booking failed: ${message}`);
      return;
    }
    const delay = RETRY_DELAYS_S[row.attempts - 1] ?? 60;
    await pool.query(
      `UPDATE ari_outbox SET status = 'PENDING', last_error = $2, locked_until = NULL,
              next_attempt_at = now() + make_interval(secs => $3) WHERE id = $1`,
      [row.id, message, delay],
    );
    logger.warn({ outboxId: row.id, event: row.event_type, attempts: row.attempts, retryInS: delay, message }, 'outbox delivery failed, will retry');
  }
}

async function deliverToSubscriber(row: OutboxRow): Promise<void> {
  const { rows } = await pool.query(
    'SELECT channel_code, endpoint_url, signing_secret, is_active FROM channel_subscriptions WHERE id = $1',
    [row.subscription_id],
  );
  const sub = rows[0];
  if (!sub || !sub.is_active) return; // unsubscribed since: nothing to do

  const data = row.event_type === 'ARI_CHANGED' ? await buildAriSnapshot(row.payload) : row.payload;
  const body = JSON.stringify({ eventId: row.id, type: row.event_type, hotelId: row.hotel_id, data, sentAt: new Date().toISOString() });
  const ts = Math.floor(Date.now() / 1000).toString();

  try {
    // Signed exactly like the inbound webhook, so partners can reuse their verifier.
    await requestJson(sub.endpoint_url, {
      method: 'POST',
      headers: {
        'x-event-id': row.id,
        'x-event-type': row.event_type,
        'x-timestamp': ts,
        'x-signature': hmacSha256Hex(sub.signing_secret, `${ts}.${body}`),
      },
      body: JSON.parse(body),
      timeoutMs: 10_000,
      maxBytes: 64_000,
    });
  } catch (err) {
    if (err instanceof HttpCallError && err.kind === 'HTTP' && !err.retryable) {
      throw new PermanentFailure(`${sub.channel_code} rejected event: HTTP ${err.status} ${err.bodySnippet ?? ''}`);
    }
    throw err;
  }
}

/** Current availability + rates for every range in an ARI_CHANGED event. */
async function buildAriSnapshot(payload: Record<string, unknown>) {
  const changes = (payload.changes as Array<{ roomTypeId: string; ratePlanId: string | null; from: string; to: string }>) ?? [];
  const out = [];
  for (const c of changes) {
    const inv = await pool.query(
      `SELECT stay_date, available, stop_sell FROM daily_inventory
        WHERE room_type_id = $1 AND stay_date BETWEEN $2 AND $3 ORDER BY stay_date`,
      [c.roomTypeId, c.from, c.to],
    );
    const rates = c.ratePlanId
      ? (
          await pool.query(
            `SELECT stay_date, price_minor, currency, min_los, max_los, closed_to_arrival, closed_to_departure, stop_sell
               FROM daily_rates WHERE rate_plan_id = $1 AND stay_date BETWEEN $2 AND $3 ORDER BY stay_date`,
            [c.ratePlanId, c.from, c.to],
          )
        ).rows
      : [];
    out.push({ ...c, availability: inv.rows, rates });
  }
  return { changes: out, cause: payload.cause ?? null };
}

async function finaliseSupplierBooking(row: OutboxRow): Promise<void> {
  const holdId = row.payload.holdId as string;
  const { rows } = await pool.query(
    `SELECT h.id, h.status, h.supplier_booking_key, h.supplier_booking_ref, h.customer, ho.supplier_code
       FROM inventory_holds h JOIN hotels ho ON ho.id = h.hotel_id WHERE h.id = $1`,
    [holdId],
  );
  const h = rows[0];
  if (!h) throw new PermanentFailure(`hold ${holdId} not found`);
  if (h.supplier_booking_ref || h.status !== 'CONFIRMED') return; // already done or no longer relevant
  if (!h.supplier_booking_key) throw new PermanentFailure('hold has no supplier booking key');

  let result;
  try {
    result = await bookExternal(h.supplier_code, h.supplier_booking_key, h.id, h.customer ?? {});
  } catch (err) {
    // Timeouts/outages retry. The hold id is sent as clientReference, so a retry after a
    // timeout that actually succeeded upstream can't create a second booking.
    if (err instanceof AppError && (err.code === 'SUPPLIER_TIMEOUT' || err.code === 'SUPPLIER_UNAVAILABLE')) throw err;
    throw new PermanentFailure((err as Error).message);
  }
  if (result.pending) throw new Error('supplier booking still pending'); // poll again on the retry schedule
  if (!result.confirmed) throw new PermanentFailure(result.message ?? 'supplier declined the booking');

  await pool.query(`UPDATE inventory_holds SET supplier_booking_ref = $2, status_reason = NULL, updated_at = now() WHERE id = $1`, [
    holdId,
    result.supplierReference,
  ]);
  logger.info({ holdId, supplierReference: result.supplierReference }, 'supplier booking confirmed');
}

async function flagRefund(row: OutboxRow, reason: string) {
  await pool
    .query(`UPDATE inventory_holds SET status = 'NEEDS_REFUND', status_reason = $2, updated_at = now() WHERE id = $1 AND status = 'CONFIRMED'`, [
      row.payload.holdId,
      reason,
    ])
    .catch((err) => logger.error({ err, holdId: row.payload.holdId }, 'failed to flag refund'));
  logger.error({ holdId: row.payload.holdId, reason }, 'ALERT: paid booking could not be confirmed with supplier; refund required');
}
