/**
 * SOURCE 1: Global / corporate chains sold through an Indian B2B wholesaler
 * (TBO Tek, Tripjack, and similar).
 *
 * Wholesalers don't push inventory. At checkout we PULL a "pre-book" (TBO calls it
 * BlockRoom, Travelgate calls it Quote, ETG calls it prebook): the supplier re-prices
 * the exact room for the exact dates and returns a short-lived booking key.
 *
 * The wire format below is our adapter contract. Each real supplier gets a small
 * mapping in `toSupplierRequest` / `SupplierCheckResponse` once their signed API spec
 * is available; nothing else in the codebase knows supplier field names.
 */
import { z } from 'zod';
import { config } from '../config.js';
import { pool, type Db } from '../db/pool.js';
import { CircuitBreaker, CircuitOpenError } from '../lib/circuitBreaker.js';
import { assertValidStay } from '../lib/dates.js';
import { AppError } from '../lib/errors.js';
import { HttpCallError, requestJson, sleep } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { decimalToMinor } from '../lib/money.js';
import { loadSellableProduct } from './catalog.js';
import type { LiveInventory } from './types.js';

// ---------------------------------------------------------------------------
// Response validation. Never trust a third-party payload: every field we use is
// checked for type and range, and unknown fields are ignored.
// ---------------------------------------------------------------------------
const Amount = z.union([z.string().max(32), z.number()]);

const SupplierCheckResponse = z.object({
  status: z.enum(['AVAILABLE', 'SOLD_OUT']),
  hotelCode: z.string().max(64),
  roomCode: z.string().max(64),
  availableRooms: z.number().int().min(0).max(10_000),
  currency: z.string().length(3),
  totalPrice: Amount.nullable().optional(),
  nightlyPrices: z.array(z.object({ date: z.string(), amount: Amount })).max(60).optional(),
  bookingKey: z.string().min(1).max(512).nullable().optional(),
  bookingKeyExpiresInSeconds: z.number().int().min(0).max(86_400).nullable().optional(),
});

const SupplierBookResponse = z.object({
  status: z.enum(['CONFIRMED', 'FAILED', 'PENDING']),
  supplierReference: z.string().max(128).nullable().optional(),
  message: z.string().max(500).optional(),
});

// One breaker per supplier, shared by every request in this process.
const breakers = new Map<string, CircuitBreaker>();
const breakerFor = (supplier: string) => {
  let b = breakers.get(supplier);
  if (!b) breakers.set(supplier, (b = new CircuitBreaker(`supplier:${supplier}`, 5, 30_000)));
  return b;
};

export interface ExternalFetchOptions {
  rooms?: number;
  /** true at checkout: ask the supplier to block the room and return a booking key. */
  prebook?: boolean;
  /** Abort if our own client disconnects. */
  signal?: AbortSignal;
  db?: Db;
}

/**
 * Fetches live availability and price for one room type from the B2B supplier.
 *
 * Failure handling (none of these ever crash the process; they become AppErrors):
 *  - supplier slow       -> per-attempt timeout -> SUPPLIER_TIMEOUT (504)
 *  - supplier down       -> network error / 5xx, one retry, then SUPPLIER_UNAVAILABLE (503)
 *  - repeated failures   -> circuit opens, later calls fail in ~0 ms with SUPPLIER_UNAVAILABLE
 *  - garbage / wrong JSON-> schema validation fails -> SUPPLIER_UNAVAILABLE, logged with a snippet
 *  - wrong hotel echoed  -> mapping mismatch -> SUPPLIER_UNAVAILABLE (never sell the wrong room)
 */
export async function fetchExternalLiveInventory(
  hotelId: string,
  roomTypeId: string,
  checkIn: string,
  checkOut: string,
  opts: ExternalFetchOptions = {},
): Promise<LiveInventory> {
  const { rooms = 1, prebook = false, signal, db = pool } = opts;

  // Step 1: resolve our ids to the supplier's codes. Wrong source = programming error upstream.
  const product = await loadSellableProduct(db, hotelId, roomTypeId);
  if (product.source !== 'EXTERNAL_B2B') {
    throw new AppError('VALIDATION_ERROR', 'Hotel is not supplied by an external B2B partner', { source: product.source });
  }
  if (!product.supplierHotelCode || !product.supplierRoomCode || !product.supplierCode) {
    throw new AppError('SUPPLIER_UNAVAILABLE', 'Room is not mapped to the supplier yet', { roomTypeId });
  }
  const nights = assertValidStay(checkIn, checkOut, product.timezone);

  if (!config.SUPPLIER_BASE_URL) {
    throw new AppError('SUPPLIER_UNAVAILABLE', 'Supplier connection is not configured');
  }

  // Step 2: call the supplier through the circuit breaker, with bounded retries.
  const body = {
    hotelCode: product.supplierHotelCode,
    roomCode: product.supplierRoomCode,
    checkIn,
    checkOut,
    rooms,
    currency: product.currency,
    block: prebook,
  };
  const url = new URL('/v1/hotels/availability-check', config.SUPPLIER_BASE_URL).toString();
  const breaker = breakerFor(product.supplierCode);

  let raw: unknown;
  try {
    raw = await breaker.exec(
      () => callWithRetry(url, body, { prebook, signal }),
      // Only infrastructure failures trip the breaker; a 4xx means the supplier is up.
      (err) => !(err instanceof HttpCallError) || err.retryable || err.kind === 'BAD_RESPONSE',
    );
  } catch (err) {
    throw toAppError(err, product.supplierCode);
  }

  // Step 3: validate the payload shape.
  const parsed = SupplierCheckResponse.safeParse(raw);
  if (!parsed.success) {
    logger.error({ supplier: product.supplierCode, issues: parsed.error.issues.slice(0, 5) }, 'supplier returned malformed availability');
    throw new AppError('SUPPLIER_UNAVAILABLE', 'Supplier returned an unexpected response');
  }
  const res = parsed.data;

  // Step 4: make sure the supplier answered about the room we asked for. A mapping
  // bug that prices the wrong room is worse than not selling at all.
  if (res.hotelCode !== product.supplierHotelCode || res.roomCode !== product.supplierRoomCode) {
    logger.error({ asked: body, got: { hotelCode: res.hotelCode, roomCode: res.roomCode } }, 'supplier echoed a different room');
    throw new AppError('SUPPLIER_UNAVAILABLE', 'Supplier response did not match the requested room');
  }

  // Step 5: normalise. Prices become integer paise; anything unparsable means "not sellable".
  const currency = res.currency.toUpperCase();
  const totalPriceMinor = res.totalPrice != null ? decimalToMinor(res.totalPrice) : null;
  const nightly = new Map((res.nightlyPrices ?? []).map((n) => [n.date, decimalToMinor(n.amount)]));
  const available = res.status === 'AVAILABLE' && res.availableRooms >= rooms && totalPriceMinor !== null;

  if (res.status === 'AVAILABLE' && totalPriceMinor === null) {
    logger.warn({ supplier: product.supplierCode, totalPrice: res.totalPrice }, 'supplier marked available but price unparsable');
  }

  return {
    source: 'EXTERNAL_B2B',
    available,
    availableRooms: res.availableRooms,
    totalPriceMinor: available ? totalPriceMinor : null,
    currency,
    nights: nights.map((date) => ({ date, availableRooms: res.availableRooms, priceMinor: nightly.get(date) ?? null })),
    ...(available ? {} : { reason: 'SOLD_OUT' as const }),
    supplierBookingKey: res.bookingKey ?? null,
    supplierExpiresAt: res.bookingKeyExpiresInSeconds != null ? new Date(Date.now() + res.bookingKeyExpiresInSeconds * 1000) : null,
    checkedAt: new Date(),
  };
}

/**
 * Turns a pre-book key into a real supplier booking. Called by the outbox worker
 * after payment, never in the request path.
 */
export async function bookExternal(
  supplierCode: string,
  bookingKey: string,
  clientReference: string,
  guest: { name?: string; email?: string; phone?: string },
): Promise<{ confirmed: boolean; pending: boolean; supplierReference: string | null; message?: string }> {
  if (!config.SUPPLIER_BASE_URL) throw new AppError('SUPPLIER_UNAVAILABLE', 'Supplier connection is not configured');
  const url = new URL('/v1/bookings', config.SUPPLIER_BASE_URL).toString();
  try {
    const { json } = await breakerFor(supplierCode).exec(() =>
      requestJson(url, {
        method: 'POST',
        headers: supplierHeaders(clientReference),
        // clientReference doubles as the supplier-side idempotency key, so a retried
        // booking after a timeout can't create two reservations.
        body: { bookingKey, clientReference, guest },
        timeoutMs: Math.max(config.SUPPLIER_TIMEOUT_MS, 15_000), // bookings are allowed to be slower
      }),
    );
    const res = SupplierBookResponse.parse(json);
    return {
      confirmed: res.status === 'CONFIRMED',
      pending: res.status === 'PENDING',
      supplierReference: res.supplierReference ?? null,
      ...(res.message ? { message: res.message } : {}),
    };
  } catch (err) {
    throw toAppError(err, supplierCode);
  }
}

// ---------------------------------------------------------------------------

function supplierHeaders(requestId: string): Record<string, string> {
  return {
    ...(config.SUPPLIER_API_KEY ? { 'x-api-key': config.SUPPLIER_API_KEY } : {}),
    'x-request-id': requestId,
  };
}

async function callWithRetry(
  url: string,
  body: Record<string, unknown>,
  { prebook, signal }: { prebook: boolean; signal?: AbortSignal | undefined },
): Promise<unknown> {
  const maxAttempts = 2;
  for (let attempt = 1; ; attempt++) {
    try {
      const { json } = await requestJson(url, {
        method: 'POST',
        headers: supplierHeaders(crypto.randomUUID()),
        body,
        timeoutMs: config.SUPPLIER_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
      return json;
    } catch (err) {
      if (!(err instanceof HttpCallError) || !err.retryable || attempt >= maxAttempts || signal?.aborted) throw err;
      // A pre-book that TIMED OUT may already have blocked a room at the supplier.
      // Re-sending could block a second one, so for pre-book we only retry errors where
      // the request provably never reached them (connection refused / reset before send).
      if (prebook && err.kind !== 'NETWORK') throw err;
      // A timeout already consumed a full budget; don't double the customer's wait.
      if (err.kind === 'TIMEOUT') throw err;
      const delay = 150 + Math.floor(Math.random() * 200);
      logger.warn({ url, attempt, kind: err.kind, status: err.status, delay }, 'supplier call failed, retrying');
      await sleep(delay);
    }
  }
}

function toAppError(err: unknown, supplier: string): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof CircuitOpenError) {
    return new AppError('SUPPLIER_UNAVAILABLE', 'Supplier is temporarily unavailable', { supplier, retryAfterMs: err.retryAfterMs });
  }
  if (err instanceof HttpCallError) {
    logger.warn({ supplier, kind: err.kind, status: err.status, body: err.bodySnippet }, 'supplier call failed');
    if (err.kind === 'TIMEOUT') return new AppError('SUPPLIER_TIMEOUT', 'Supplier did not respond in time', { supplier }, { cause: err });
    return new AppError('SUPPLIER_UNAVAILABLE', 'Supplier is unavailable', { supplier, status: err.status }, { cause: err });
  }
  if (err instanceof z.ZodError) {
    return new AppError('SUPPLIER_UNAVAILABLE', 'Supplier returned an unexpected response', { supplier }, { cause: err });
  }
  logger.error({ err, supplier }, 'unexpected supplier error');
  return new AppError('SUPPLIER_UNAVAILABLE', 'Supplier is unavailable', { supplier }, { cause: err });
}
