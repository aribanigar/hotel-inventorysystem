/**
 * Hold lifecycle after the Live Ping: release, automatic expiry, payment confirmation.
 *
 * Why the 10-minute timer lives in the database (expires_at) and not in a setTimeout:
 * a setTimeout dies with the process (deploy, crash, autoscale-down) and the room would
 * stay locked forever. A DB timestamp plus a sweeper survives restarts and works with
 * any number of app instances.
 */
import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { enqueueForSubscribers, enqueueJob } from '../outbox/outbox.js';

interface HoldRow {
  id: string;
  pending_booking_token: string;
  hotel_id: string;
  room_type_id: string;
  rate_plan_id: string | null;
  source: 'EXTERNAL_B2B' | 'CHANNEL_MANAGER' | 'EXTRANET';
  check_in: string;
  check_out: string;
  rooms: number;
  quoted_total_minor: number;
  currency: string;
  customer: Record<string, unknown>;
  status: 'ACTIVE' | 'CONFIRMED' | 'RELEASED' | 'EXPIRED' | 'NEEDS_REFUND';
  expires_at: Date;
  supplier_booking_key: string | null;
  payment_order_id: string | null;
}

/** Gives the held rooms back to the pool for every night of the stay. */
async function returnHeldRooms(client: PoolClient, h: HoldRow): Promise<void> {
  if (h.source === 'EXTERNAL_B2B') return; // supplier blocks lapse on the supplier side
  // GREATEST(...) guards against a negative count if data was ever repaired by hand.
  await client.query(
    `UPDATE daily_inventory
        SET held = GREATEST(held - $4, 0), updated_at = now()
      WHERE room_type_id = $1 AND stay_date >= $2 AND stay_date < $3`,
    [h.room_type_id, h.check_in, h.check_out, h.rooms],
  );
  await enqueueForSubscribers(client, h.hotel_id, 'ARI_CHANGED', {
    changes: [{ roomTypeId: h.room_type_id, ratePlanId: h.rate_plan_id, from: h.check_in, to: h.check_out }],
    cause: 'hold_released',
  });
}

/**
 * Releases an ACTIVE hold. Safe to call repeatedly and concurrently: only the call
 * that flips status from ACTIVE does any work.
 */
export async function releaseHold(
  where: { id: string } | { token: string },
  status: 'RELEASED' | 'EXPIRED',
  reason: string,
): Promise<boolean> {
  return withTransaction(async (client) => {
    const byId = 'id' in where;
    const { rows } = await client.query<HoldRow>(
      `UPDATE inventory_holds
          SET status = $2, status_reason = $3, updated_at = now()
        WHERE ${byId ? 'id = $1' : 'pending_booking_token = $1'} AND status = 'ACTIVE'
        RETURNING *`,
      [byId ? where.id : where.token, status, reason],
    );
    const hold = rows[0];
    if (!hold) return false;
    await returnHeldRooms(client, hold);
    logger.info({ holdId: hold.id, status, reason }, 'hold released');
    return true;
  });
}

/**
 * Sweeper: expires every ACTIVE hold whose 10 minutes are up.
 * Each hold is released in its own short transaction, so one slow row never blocks
 * the others, and two sweeper instances can't deadlock each other.
 */
export async function expireDueHolds(batchSize = 200): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM inventory_holds
      WHERE status = 'ACTIVE' AND expires_at <= now()
      ORDER BY expires_at
      LIMIT $1`,
    [batchSize],
  );
  let expired = 0;
  for (const { id } of rows) {
    try {
      if (await releaseHold({ id }, 'EXPIRED', 'payment window elapsed')) expired++;
    } catch (err) {
      // Keep going; the next sweep retries this one.
      logger.error({ err, holdId: id }, 'failed to expire hold');
    }
  }
  return expired;
}

export type ConfirmOutcome =
  | { status: 'CONFIRMED'; holdId: string; token: string; alreadyConfirmed: boolean; note?: string }
  | { status: 'NEEDS_REFUND'; holdId: string; token: string; reason: string };

/**
 * Called when the gateway says the money is in (webhook or verified client callback).
 * Idempotent: the same payment confirmed twice returns the first result.
 */
export async function confirmPayment(input: {
  orderId: string;
  paymentId: string;
  amountMinor?: number;
  currency?: string;
}): Promise<ConfirmOutcome> {
  const outcome = await withTransaction(async (client): Promise<ConfirmOutcome> => {
    // Lock the hold row first. Every path that changes a hold (release, expiry,
    // confirm) locks hold -> inventory in that order, so they can't deadlock.
    const { rows } = await client.query<HoldRow>(
      'SELECT * FROM inventory_holds WHERE payment_order_id = $1 FOR UPDATE',
      [input.orderId],
    );
    const h = rows[0];
    if (!h) throw new AppError('HOLD_NOT_FOUND', 'No booking found for this payment order');
    const base = { holdId: h.id, token: h.pending_booking_token };

    if (h.status === 'CONFIRMED') return { status: 'CONFIRMED', ...base, alreadyConfirmed: true };
    if (h.status === 'NEEDS_REFUND') return { status: 'NEEDS_REFUND', ...base, reason: 'already flagged for refund' };

    const markRefund = async (reason: string): Promise<ConfirmOutcome> => {
      if (h.status === 'ACTIVE') await returnHeldRooms(client, h);
      await client.query(
        `UPDATE inventory_holds SET status = 'NEEDS_REFUND', status_reason = $2, payment_id = $3, updated_at = now() WHERE id = $1`,
        [h.id, reason, input.paymentId],
      );
      logger.error({ holdId: h.id, orderId: input.orderId, reason }, 'ALERT: payment received but booking not secured; refund required');
      return { status: 'NEEDS_REFUND', ...base, reason };
    };

    // The gateway's amount must match what we verified. Anything else is tampering
    // or a bug; never confirm a booking for the wrong money.
    if (input.amountMinor !== undefined && (input.amountMinor !== h.quoted_total_minor || (input.currency && input.currency !== h.currency.trim()))) {
      return markRefund(`amount mismatch: paid ${input.amountMinor} ${input.currency ?? ''}, expected ${h.quoted_total_minor} ${h.currency}`);
    }

    let note: string | undefined;

    if (h.status === 'ACTIVE') {
      // Normal path. Convert the hold into a sale: the rooms leave `held` and leave
      // `allotment`, so `available` doesn't change (it already excluded them).
      if (h.source !== 'EXTERNAL_B2B') {
        await client.query(
          `UPDATE daily_inventory
              SET held = GREATEST(held - $4, 0), allotment = GREATEST(allotment - $4, 0), updated_at = now()
            WHERE room_type_id = $1 AND stay_date >= $2 AND stay_date < $3`,
          [h.room_type_id, h.check_in, h.check_out, h.rooms],
        );
      }
    } else {
      // Late payment: the hold already expired or was released, and the rooms went back
      // on sale. Try to take them again under lock; if someone else bought them, refund.
      if (h.source !== 'EXTERNAL_B2B') {
        const nights = await client.query<{ stay_date: string; available: number; stop_sell: boolean }>(
          `SELECT stay_date, available, stop_sell FROM daily_inventory
            WHERE room_type_id = $1 AND stay_date >= $2 AND stay_date < $3
            ORDER BY stay_date FOR UPDATE`,
          [h.room_type_id, h.check_in, h.check_out],
        );
        const expected = Math.round((Date.parse(h.check_out) - Date.parse(h.check_in)) / 86_400_000);
        const ok = nights.rows.length === expected && nights.rows.every((n) => !n.stop_sell && n.available >= h.rooms);
        if (!ok) return markRefund('room sold after the hold expired');
        await client.query(
          `UPDATE daily_inventory SET allotment = allotment - $4, updated_at = now()
            WHERE room_type_id = $1 AND stay_date >= $2 AND stay_date < $3`,
          [h.room_type_id, h.check_in, h.check_out, h.rooms],
        );
        await enqueueForSubscribers(client, h.hotel_id, 'ARI_CHANGED', {
          changes: [{ roomTypeId: h.room_type_id, ratePlanId: h.rate_plan_id, from: h.check_in, to: h.check_out }],
          cause: 'late_payment_reacquired',
        });
      }
      note = 'confirmed after hold expiry';
    }

    await client.query(
      `UPDATE inventory_holds
          SET status = 'CONFIRMED', payment_id = $2, confirmed_at = now(), updated_at = now(),
              status_reason = $3
        WHERE id = $1`,
      [h.id, input.paymentId, h.source === 'EXTERNAL_B2B' ? 'awaiting supplier confirmation' : (note ?? null)],
    );

    const reservation = {
      reservationId: h.id, // unique forever, never reused (SiteMinder rule)
      hotelId: h.hotel_id,
      roomTypeId: h.room_type_id,
      ratePlanId: h.rate_plan_id,
      checkIn: h.check_in,
      checkOut: h.check_out,
      rooms: h.rooms,
      totalMinor: h.quoted_total_minor,
      currency: h.currency.trim(),
      customer: h.customer,
    };
    // Same transaction: the CM / other channels will hear about this sale even if we
    // crash one millisecond after COMMIT.
    await enqueueForSubscribers(client, h.hotel_id, 'RESERVATION_CREATED', reservation);
    if (h.source === 'EXTERNAL_B2B') await enqueueJob(client, h.hotel_id, 'SUPPLIER_BOOK', { holdId: h.id });

    return { status: 'CONFIRMED', ...base, alreadyConfirmed: false, ...(note ? { note } : {}) };
  });

  logger.info({ orderId: input.orderId, outcome: outcome.status }, 'payment processed');
  return outcome;
}

/** Public view of a hold for the checkout page (countdown timer, status polling). */
export async function getHoldByToken(token: string) {
  const { rows } = await pool.query(
    `SELECT id, status, expires_at, check_in, check_out, rooms, quoted_total_minor, currency,
            payment_provider, payment_order_id, status_reason, supplier_booking_ref
       FROM inventory_holds WHERE pending_booking_token = $1`,
    [token],
  );
  const h = rows[0];
  if (!h) throw new AppError('HOLD_NOT_FOUND', 'Booking session not found');
  const secondsLeft = Math.max(0, Math.floor((new Date(h.expires_at).getTime() - Date.now()) / 1000));
  return {
    status: h.status,
    expiresAt: h.expires_at,
    secondsLeft: h.status === 'ACTIVE' ? secondsLeft : 0,
    checkIn: h.check_in,
    checkOut: h.check_out,
    rooms: h.rooms,
    amount: { minor: h.quoted_total_minor, currency: h.currency.trim() },
    payment: h.payment_order_id ? { provider: h.payment_provider, orderId: h.payment_order_id } : null,
    supplierReference: h.supplier_booking_ref,
    note: h.status_reason,
  };
}
