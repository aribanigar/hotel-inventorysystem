/**
 * THE CORE ENGINE: the "Live Ping" gatekeeper.
 *
 * Runs the moment a user clicks "Proceed to Pay". Its single job is to guarantee that
 * the room the user is about to pay for exists, at the price on their screen, and is
 * reserved for them for the next 10 minutes. Nothing reaches the payment gateway
 * unless this function returns success.
 *
 *   a. Determine the hotel's inventory source.
 *   b. Re-verify live:
 *        Source 1  -> supplier pre-book call (no DB locks held while we wait on network)
 *        Source 2/3-> SELECT ... FOR UPDATE on every night inside one transaction
 *   c. Compare live price + availability with what the user saw.
 *   d. Success -> take the rooms (held += rooms), mint pending_booking_token,
 *                 set a 10-minute expires_at, create the Razorpay order.
 *   e. Failure -> throw an explicit error code; the transaction rolls back, which
 *                 releases every lock, and the frontend tells the user before they pay.
 */
import { z } from 'zod';
import { config } from '../config.js';
import { pool, withTransaction } from '../db/pool.js';
import { isUuid, loadSellableProduct } from '../inventory/catalog.js';
import { fetchExternalLiveInventory } from '../inventory/external.js';
import { fetchInternalLiveInventory } from '../inventory/internal.js';
import type { LiveInventory } from '../inventory/types.js';
import { newToken } from '../lib/crypto.js';
import { assertValidStay, isIsoDate } from '../lib/dates.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { enqueueForSubscribers } from '../outbox/outbox.js';
import { paymentProvider } from '../payments/provider.js';
import { releaseHold } from './holds.js';

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------
export const BookingDetailsSchema = z
  .object({
    hotelId: z.string().refine(isUuid, 'must be a uuid'),
    roomTypeId: z.string().refine(isUuid, 'must be a uuid'),
    ratePlanId: z.string().refine(isUuid, 'must be a uuid').optional(),
    checkIn: z.string().refine(isIsoDate, 'must be YYYY-MM-DD'),
    checkOut: z.string().refine(isIsoDate, 'must be YYYY-MM-DD'),
    rooms: z.number().int().min(1).max(9).default(1),
    adults: z.number().int().min(1).max(40).default(2),
    children: z.number().int().min(0).max(20).default(0),
    /** The exact total the user sees on screen, in paise. */
    displayedTotalMinor: z.number().int().positive(),
    currency: z.string().length(3).default('INR'),
    customer: z.object({
      name: z.string().trim().min(2).max(120),
      email: z.email().max(254),
      phone: z.string().regex(/^\+?[0-9]{8,15}$/, 'digits only, 8-15 long'),
    }),
    /** Same key on a double click returns the same hold instead of taking two rooms. */
    idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  })
  .strict();

export type BookingDetails = z.input<typeof BookingDetailsSchema>;

export interface LivePingSuccess {
  status: 'HELD';
  pendingBookingToken: string;
  expiresAt: string;
  holdSeconds: number;
  amount: { minor: number; currency: string };
  payment: { provider: string; orderId: string; checkout: Record<string, unknown> };
  source: LiveInventory['source'];
  verifiedAt: string;
}

// ---------------------------------------------------------------------------

export async function executeLivePingCheck(
  bookingDetails: BookingDetails,
  opts: { signal?: AbortSignal } = {},
): Promise<LivePingSuccess> {
  // ---- 0. Validate input. Garbage never reaches SQL or the supplier. -----------
  const parsed = BookingDetailsSchema.safeParse(bookingDetails);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Invalid booking details', { issues: z.flattenError(parsed.error) });
  const b = parsed.data;
  const currency = b.currency.toUpperCase();

  // ---- 0b. Idempotency: a double-clicked "Proceed to Pay" must not hold two rooms.
  if (b.idempotencyKey) {
    const existing = await findHoldByIdempotencyKey(b.idempotencyKey, b);
    if (existing) return existing;
  }

  // ---- a. Determine the inventory source --------------------------------------
  const product = await loadSellableProduct(pool, b.hotelId, b.roomTypeId, b.ratePlanId);
  assertValidStay(b.checkIn, b.checkOut, product.timezone);
  if (b.adults + b.children > product.maxOccupancy * b.rooms) {
    throw new AppError('VALIDATION_ERROR', `Maximum ${product.maxOccupancy} guests per room`, { maxOccupancy: product.maxOccupancy });
  }

  const holdTtlMs = config.HOLD_TTL_SECONDS * 1000;
  const token = newToken('pbt');

  // ---- b/c/d. Source-specific live check + hold -------------------------------
  let hold: { id: string; expiresAt: Date; amountMinor: number; live: LiveInventory };

  if (product.source === 'EXTERNAL_B2B') {
    // SOURCE 1. Network call FIRST, with no DB transaction open. Holding row locks
    // while waiting up to 8 s on a third party would stall every other checkout.
    const live = await fetchExternalLiveInventory(b.hotelId, b.roomTypeId, b.checkIn, b.checkOut, {
      rooms: b.rooms,
      prebook: true,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    assertSellable(live, b.rooms);
    assertPriceMatches(live, b.displayedTotalMinor, currency);
    if (!live.supplierBookingKey) throw new AppError('SUPPLIER_UNAVAILABLE', 'Supplier did not return a booking key');

    // Our hold may never outlive the supplier's block (minus a 30 s safety margin),
    // otherwise we'd take money for a room the supplier already released.
    let expiresAt = new Date(Date.now() + holdTtlMs);
    if (live.supplierExpiresAt) {
      const supplierLimit = new Date(live.supplierExpiresAt.getTime() - 30_000);
      if (supplierLimit < expiresAt) expiresAt = supplierLimit;
    }
    if (expiresAt.getTime() - Date.now() < 120_000) {
      throw new AppError('SUPPLIER_UNAVAILABLE', 'Supplier hold window too short to complete payment');
    }

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO inventory_holds
         (pending_booking_token, idempotency_key, hotel_id, room_type_id, rate_plan_id, source,
          check_in, check_out, rooms, quoted_total_minor, currency, customer, expires_at, supplier_booking_key)
       VALUES ($1, $2, $3, $4, $5, 'EXTERNAL_B2B', $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
       RETURNING id`,
      [token, b.idempotencyKey ?? null, b.hotelId, b.roomTypeId, b.ratePlanId ?? null, b.checkIn, b.checkOut, b.rooms,
        live.totalPriceMinor, currency, JSON.stringify(b.customer), expiresAt, live.supplierBookingKey],
    ).catch(handleIdempotencyRace);
    hold = { id: rows[0]!.id, expiresAt, amountMinor: live.totalPriceMinor!, live };
  } else {
    // SOURCES 2 + 3. Everything inside ONE transaction:
    //   lock rows -> verify -> decrement -> insert hold -> commit.
    // Any throw rolls back and releases the locks, so a failed check leaves no trace.
    hold = await withTransaction(
      async (client) => {
        // FOR UPDATE on every night (in date order). From here until COMMIT, no other
        // checkout, CM webhook or extranet edit can change these rows.
        const live = await fetchInternalLiveInventory(b.hotelId, b.roomTypeId, b.checkIn, b.checkOut, {
          db: client,
          lock: 'update',
          rooms: b.rooms,
          ratePlanId: product.ratePlanId,
        });
        assertSellable(live, b.rooms);
        assertPriceMatches(live, b.displayedTotalMinor, currency);

        // Atomic decrement. The WHERE re-checks capacity in the same statement, so even
        // if this code were ever called without the lock it still couldn't oversell.
        const nights = live.nights.length;
        const upd = await client.query(
          `UPDATE daily_inventory
              SET held = held + $4, updated_at = now()
            WHERE room_type_id = $1 AND stay_date >= $2 AND stay_date < $3
              AND NOT stop_sell AND allotment - held >= $4`,
          [b.roomTypeId, b.checkIn, b.checkOut, b.rooms],
        );
        if (upd.rowCount !== nights) {
          // Should be impossible under the lock; treat as sold out and roll back.
          logger.error({ expected: nights, updated: upd.rowCount, roomTypeId: b.roomTypeId }, 'hold decrement mismatch');
          throw new AppError('SOLD_OUT', 'Room just sold out', { reason: 'SOLD_OUT' });
        }

        const expiresAt = new Date(Date.now() + holdTtlMs);
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO inventory_holds
             (pending_booking_token, idempotency_key, hotel_id, room_type_id, rate_plan_id, source,
              check_in, check_out, rooms, quoted_total_minor, currency, customer, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
           RETURNING id`,
          [token, b.idempotencyKey ?? null, b.hotelId, b.roomTypeId, live.ratePlanId, product.source, b.checkIn, b.checkOut,
            b.rooms, live.totalPriceMinor, currency, JSON.stringify(b.customer), expiresAt],
        ).catch(handleIdempotencyRace);

        // Availability dropped: other channels must hear about it (same transaction).
        await enqueueForSubscribers(client, b.hotelId, 'ARI_CHANGED', {
          changes: [{ roomTypeId: b.roomTypeId, ratePlanId: live.ratePlanId, from: b.checkIn, to: b.checkOut }],
          cause: 'hold_created',
        });

        return { id: rows[0]!.id, expiresAt, amountMinor: live.totalPriceMinor!, live };
      },
      // Checkout waits at most 3 s for a lock, then the user gets INVENTORY_BUSY (retryable).
      { lockTimeoutMs: 3_000, statementTimeoutMs: 8_000 },
    );
  }

  // ---- d (cont). Create the payment order AFTER commit -----------------------
  // Never call a payment gateway while holding row locks. If the gateway fails, we
  // compensate by releasing the hold right away so the room goes back on sale.
  let order;
  try {
    order = await paymentProvider().createOrder({
      amountMinor: hold.amountMinor,
      currency,
      receipt: hold.id,
      notes: { pending_booking_token: token, hotel_id: b.hotelId },
    });
    await pool.query('UPDATE inventory_holds SET payment_provider = $2, payment_order_id = $3, updated_at = now() WHERE id = $1', [
      hold.id,
      order.provider,
      order.orderId,
    ]);
  } catch (err) {
    await releaseHold({ id: hold.id }, 'RELEASED', 'payment order creation failed').catch((releaseErr) =>
      // Worst case the sweeper frees it in <= 10 minutes.
      logger.error({ err: releaseErr, holdId: hold.id }, 'compensating release failed; sweeper will expire it'),
    );
    throw err instanceof AppError ? err : new AppError('PAYMENT_ERROR', 'Could not start payment', undefined, { cause: err });
  }

  logger.info({ holdId: hold.id, source: product.source, amountMinor: hold.amountMinor, expiresAt: hold.expiresAt }, 'live ping: room held');
  return {
    status: 'HELD',
    pendingBookingToken: token,
    expiresAt: hold.expiresAt.toISOString(),
    holdSeconds: Math.floor((hold.expiresAt.getTime() - Date.now()) / 1000),
    amount: { minor: hold.amountMinor, currency },
    payment: { provider: order.provider, orderId: order.orderId, checkout: order.checkout },
    source: product.source,
    verifiedAt: hold.live.checkedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** e. Explicit, machine-readable reasons for "you can't buy this". */
function assertSellable(live: LiveInventory, rooms: number): void {
  if (live.available && live.availableRooms >= rooms) return;
  const restricted = ['STOP_SELL', 'MIN_LOS', 'MAX_LOS', 'CLOSED_TO_ARRIVAL', 'CLOSED_TO_DEPARTURE'].includes(live.reason ?? '');
  throw new AppError(
    restricted ? 'RESTRICTED' : 'SOLD_OUT',
    restricted ? 'These dates are not bookable for this room' : 'This room is no longer available for your dates',
    { reason: live.reason ?? 'SOLD_OUT', detail: live.reasonDetail, availableRooms: live.availableRooms },
  );
}

/** c. Exact comparison in paise. Up OR down counts as changed: the user must re-confirm. */
function assertPriceMatches(live: LiveInventory, displayedMinor: number, currency: string): void {
  if (live.totalPriceMinor === null) throw new AppError('SOLD_OUT', 'No live price available', { reason: 'NO_RATE' });
  if (live.currency !== currency || live.totalPriceMinor !== displayedMinor) {
    throw new AppError('PRICE_CHANGED', 'The price for this stay has changed', {
      displayedTotalMinor: displayedMinor,
      displayedCurrency: currency,
      liveTotalMinor: live.totalPriceMinor,
      liveCurrency: live.currency,
      differenceMinor: live.totalPriceMinor - displayedMinor,
      nights: live.nights,
    });
  }
}

async function findHoldByIdempotencyKey(key: string, b: z.output<typeof BookingDetailsSchema>): Promise<LivePingSuccess | null> {
  const { rows } = await pool.query(
    `SELECT id, pending_booking_token, hotel_id, room_type_id, check_in, check_out, rooms, status, expires_at,
            quoted_total_minor, currency, source, payment_provider, payment_order_id, created_at
       FROM inventory_holds WHERE idempotency_key = $1`,
    [key],
  );
  const h = rows[0];
  if (!h) return null;
  const sameRequest = h.hotel_id === b.hotelId && h.room_type_id === b.roomTypeId && h.check_in === b.checkIn && h.check_out === b.checkOut && h.rooms === b.rooms;
  if (!sameRequest) throw new AppError('CONFLICT', 'idempotencyKey was already used for a different booking');
  if (h.status !== 'ACTIVE' || new Date(h.expires_at) <= new Date()) {
    throw new AppError('HOLD_EXPIRED', 'This booking session has ended; please start checkout again', { status: h.status });
  }
  if (!h.payment_order_id) {
    // First request is still creating its payment order (or crashed doing so).
    throw new AppError('INVENTORY_BUSY', 'Your booking is being prepared, please retry in a moment');
  }
  return {
    status: 'HELD',
    pendingBookingToken: h.pending_booking_token,
    expiresAt: new Date(h.expires_at).toISOString(),
    holdSeconds: Math.max(0, Math.floor((new Date(h.expires_at).getTime() - Date.now()) / 1000)),
    amount: { minor: h.quoted_total_minor, currency: h.currency.trim() },
    payment: {
      provider: h.payment_provider,
      orderId: h.payment_order_id,
      checkout: {
        ...(h.payment_provider === 'razorpay' ? { key: config.RAZORPAY_KEY_ID } : {}),
        order_id: h.payment_order_id,
        amount: h.quoted_total_minor,
        currency: h.currency.trim(),
      },
    },
    source: h.source,
    verifiedAt: new Date(h.created_at).toISOString(),
  };
}

/** Two identical double-clicks racing: the loser hits the unique index. */
function handleIdempotencyRace(err: unknown): never {
  if ((err as { code?: string; constraint?: string }).code === '23505' && (err as { constraint?: string }).constraint === 'inventory_holds_idempotency_key_key') {
    throw new AppError('INVENTORY_BUSY', 'Your booking is being prepared, please retry in a moment');
  }
  throw err;
}
