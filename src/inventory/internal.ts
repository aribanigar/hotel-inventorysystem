/**
 * SOURCE 2 + 3: inventory that lives in our own Postgres tables.
 *   - Source 2 (channel-manager hotels): rows are written by the inbound CM webhook.
 *   - Source 3 (houseboats / boutique stays): rows are written by our extranet.
 *
 * Both are read the same way. At checkout the Live Ping engine calls this with
 * `lock: 'update'` inside a transaction, which takes SELECT ... FOR UPDATE row locks on
 * every night of the stay so nobody (another buyer, a CM push, the extranet) can change
 * those rows until our transaction commits or rolls back.
 */
import { pool, type Db } from '../db/pool.js';
import { addDays, assertValidStay } from '../lib/dates.js';
import { AppError } from '../lib/errors.js';
import { loadSellableProduct } from './catalog.js';
import type { LiveInventory, NightQuote, UnavailableReason } from './types.js';

export interface InternalFetchOptions {
  ratePlanId?: string | null;
  rooms?: number;
  /**
   * 'none'   : plain read (search results, availability API).
   * 'update' : FOR UPDATE on inventory rows + FOR SHARE on rate rows. MUST be used with
   *            a client inside withTransaction(); the locks are held until it ends.
   */
  lock?: 'none' | 'update';
  /** Pass the transaction client when locking. */
  db?: Db;
}

interface InvRow {
  stay_date: string;
  allotment: number;
  held: number;
  available: number;
  stop_sell: boolean;
}
interface RateRow {
  stay_date: string;
  price_minor: number | null;
  currency: string;
  min_los: number;
  max_los: number | null;
  closed_to_arrival: boolean;
  closed_to_departure: boolean;
  stop_sell: boolean;
}

export async function fetchInternalLiveInventory(
  hotelId: string,
  roomTypeId: string,
  checkIn: string,
  checkOut: string,
  opts: InternalFetchOptions = {},
): Promise<LiveInventory & { ratePlanId: string }> {
  const { rooms = 1, lock = 'none', db = pool } = opts;
  if (lock === 'update' && db === pool) {
    // Locks taken on a pooled autocommit query are released immediately: a silent bug.
    throw new Error('fetchInternalLiveInventory: lock=update requires a transaction client');
  }

  // Step 1: verify hotel/room/rate plan belong together and the source is ours.
  const product = await loadSellableProduct(db, hotelId, roomTypeId, opts.ratePlanId);
  if (product.source === 'EXTERNAL_B2B') {
    throw new AppError('VALIDATION_ERROR', 'Hotel inventory is held by an external supplier', { source: product.source });
  }
  const ratePlanId = product.ratePlanId!; // guaranteed by loadSellableProduct for internal sources
  const nights = assertValidStay(checkIn, checkOut, product.timezone);
  const lastNight = nights[nights.length - 1]!;

  // Step 2: read (and optionally lock) the inventory rows for every night.
  // ORDER BY stay_date gives every transaction the same lock order, which is what
  // prevents two overlapping stays from deadlocking each other.
  const invSql = `
    SELECT stay_date, allotment, held, available, stop_sell
      FROM daily_inventory
     WHERE room_type_id = $1 AND stay_date BETWEEN $2 AND $3
     ORDER BY stay_date
     ${lock === 'update' ? 'FOR UPDATE' : ''}`;
  const inv = await db.query<InvRow>(invSql, [roomTypeId, checkIn, lastNight]);

  // Step 3: read rates. We include the checkout date itself, because "closed to
  // departure" is a property of the departure day's row. FOR SHARE blocks a concurrent
  // price push from changing the rate mid-checkout but lets other readers through.
  const rateSql = `
    SELECT stay_date, price_minor, currency, min_los, max_los, closed_to_arrival, closed_to_departure, stop_sell
      FROM daily_rates
     WHERE rate_plan_id = $1 AND stay_date BETWEEN $2 AND $3
     ORDER BY stay_date
     ${lock === 'update' ? 'FOR SHARE' : ''}`;
  const rates = await db.query<RateRow>(rateSql, [ratePlanId, checkIn, checkOut]);

  const invByDate = new Map(inv.rows.map((r) => [r.stay_date, r]));
  const rateByDate = new Map(rates.rows.map((r) => [r.stay_date, r]));

  // Step 4: evaluate every night. The first failing rule wins and is reported.
  let reason: UnavailableReason | undefined;
  let reasonDetail: string | undefined;
  const fail = (r: UnavailableReason, detail: string) => {
    if (!reason) {
      reason = r;
      reasonDetail = detail;
    }
  };

  const quotes: NightQuote[] = [];
  let total = 0;
  let currency = product.currency;
  let minRooms = Number.POSITIVE_INFINITY;

  for (const date of nights) {
    const i = invByDate.get(date);
    const r = rateByDate.get(date);

    // Missing row = not loaded = NOT sellable. Defaulting to "available" is how
    // phantom inventory and overbookings happen.
    if (!i) fail('NOT_LOADED', `no inventory loaded for ${date}`);
    else if (i.stop_sell) fail('STOP_SELL', `stop-sell on ${date}`);
    else if (i.available < rooms) fail('SOLD_OUT', `${i.available} room(s) left on ${date}`);

    if (!r || r.price_minor === null) fail('NO_RATE', `no rate for ${date}`);
    else if (r.stop_sell) fail('STOP_SELL', `rate closed on ${date}`);

    if (r && r.currency.trim() !== currency) {
      // Mixed currencies inside one stay is a data error; refuse rather than mis-sum.
      fail('NO_RATE', `currency mismatch on ${date}`);
    }

    const avail = i?.available ?? 0;
    minRooms = Math.min(minRooms, avail);
    quotes.push({ date, availableRooms: avail, priceMinor: r?.price_minor ?? null });
    if (r?.price_minor) total += r.price_minor * rooms;
  }

  // Step 5: stay-level restrictions (the OTA standard: min/max stay apply on arrival day).
  const arrival = rateByDate.get(checkIn);
  if (arrival) {
    if (arrival.closed_to_arrival) fail('CLOSED_TO_ARRIVAL', `no arrivals on ${checkIn}`);
    if (nights.length < arrival.min_los) fail('MIN_LOS', `minimum stay is ${arrival.min_los} nights`);
    if (arrival.max_los !== null && nights.length > arrival.max_los) fail('MAX_LOS', `maximum stay is ${arrival.max_los} nights`);
  }
  const departure = rateByDate.get(checkOut);
  if (departure?.closed_to_departure) fail('CLOSED_TO_DEPARTURE', `no departures on ${checkOut}`);

  if (!Number.isSafeInteger(total)) fail('NO_RATE', 'price overflow');
  if (arrival) currency = arrival.currency.trim();

  const available = !reason;
  return {
    source: product.source,
    ratePlanId,
    available,
    availableRooms: Number.isFinite(minRooms) ? minRooms : 0,
    totalPriceMinor: available ? total : null,
    currency,
    nights: quotes,
    ...(reason ? { reason, reasonDetail } : {}),
    checkedAt: new Date(),
  };
}

/** Helper for callers that need the inclusive last night of a stay. */
export const lastNightOf = (checkOut: string) => addDays(checkOut, -1);
