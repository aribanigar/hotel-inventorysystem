/**
 * QloApps Channel Manager connectivity: this system acts as the "PMS" for the hosted
 * QloApps Channel Manager (channels.qloapps.com), which is connected to Booking.com,
 * Expedia, MakeMyTrip/Goibibo, Agoda, Airbnb, Yatra, Trip.com and more.
 *
 * Contract read from Webkul's qlocmconnector module (see docs/QLOAPPS_CHANNEL_MANAGER.md):
 *   outbound  POST {base}/oauth/token        client_credentials -> access_token
 *             POST {base}/api/v1/push_ari    one hotel per request, Bearer token
 *   inbound   /api/cm_api/*                  served by routes/qloCmApi.ts
 *
 * Better than the stock connector:
 *  - pushed from our transactional outbox within seconds (theirs: cron every minute)
 *  - sends real stop-sell, CTA, CTD, arrival and stay-through LOS and booking window
 *    (theirs: hard-coded to 0)
 *  - OTA bookings go through the same row locks as walk-ins and website checkouts
 */
import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../db/pool.js';
import { addDays, todayIn } from '../lib/dates.js';
import { AppError } from '../lib/errors.js';
import { HttpCallError, requestJson } from '../lib/http.js';
import { decimalToMinor } from '../lib/money.js';
import { applyOtaBooking, type OtaBooking, type OtaLine } from './otaBookings.js';

export const QLO_COMPAT_VERSION = '1.7.0.0';
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const toMajor = (minor: number | null | undefined) => (minor ? Math.round(minor) / 100 : 0);

export interface CmAccount {
  id: string;
  base_url: string;
  client_id: string | null;
  client_secret: string | null;
  access_token: string | null;
  push_enabled: boolean;
}

// ---------------------------------------------------------------------------
// ARI payload (shared by push and the GET /ari pull)
// ---------------------------------------------------------------------------

interface DayAri {
  date: string;
  availability: number;
  closed: number;
  rate: Record<string, number | string>;
}

/**
 * Builds the CM's ARI payload for one hotel: per room type, consecutive identical
 * days merged into ranges. The default rate plan is sent as rate plan "0", matching
 * what the CM expects from a QloApps PMS.
 */
export async function buildQloAri(db: PoolClient | typeof pool, hotelId: string, ranges: Array<{ roomTypeId?: string | null; from: string; to: string }>) {
  const hotel = (await db.query('SELECT pms_id FROM hotels WHERE id = $1', [hotelId])).rows[0];
  if (!hotel) return null;

  // Normalise to one [from, to] window per room type (or all room types).
  const rooms = (
    await db.query<{ id: string; pms_id: number; rate_plan_id: string | null }>(
      `SELECT rt.id, rt.pms_id,
              (SELECT id FROM rate_plans WHERE room_type_id = rt.id AND is_active AND is_default LIMIT 1) AS rate_plan_id
         FROM room_types rt WHERE rt.hotel_id = $1 AND rt.is_active`,
      [hotelId],
    )
  ).rows;
  const windows = new Map<string, { from: string; to: string }>();
  for (const r of ranges) {
    const targets = r.roomTypeId ? rooms.filter((x) => x.id === r.roomTypeId) : rooms;
    for (const t of targets) {
      const w = windows.get(t.id);
      windows.set(t.id, { from: !w || r.from < w.from ? r.from : w.from, to: !w || r.to > w.to ? r.to : w.to });
    }
  }

  const ariInfo: unknown[] = [];
  for (const room of rooms) {
    const w = windows.get(room.id);
    if (!w) continue;
    const { rows } = await db.query(
      `SELECT d::date::text AS date,
              COALESCE(i.available, 0) AS available, COALESCE(i.stop_sell, false) AS room_closed,
              r.price_minor, r.min_los, r.max_los, r.min_stay_through, r.max_stay_through,
              r.min_advance_days, r.max_advance_days, r.closed_to_arrival, r.closed_to_departure, r.stop_sell
         FROM generate_series($2::date, $3::date, interval '1 day') d
         LEFT JOIN daily_inventory i ON i.room_type_id = $1 AND i.stay_date = d::date
         LEFT JOIN daily_rates r ON r.rate_plan_id = $4 AND r.stay_date = d::date
        ORDER BY d`,
      [room.id, w.from, w.to, room.rate_plan_id],
    );
    const days: DayAri[] = rows.map((x) => ({
      date: x.date,
      availability: Number(x.available),
      closed: x.room_closed ? 1 : 0,
      rate: {
        id_rate_plan: '0',
        id_pms_rate_plan: '0',
        price_with_tax: toMajor(x.price_minor),
        price_without_tax: toMajor(x.price_minor),
        tax: 0,
        occupancy_based_price: JSON.stringify([]),
        min_los_arrival: x.min_los ?? 1,
        max_los_arrival: x.max_los ?? 0,
        min_los_stay: x.min_stay_through ?? 1,
        max_los_stay: x.max_stay_through ?? 0,
        stop_sell: x.stop_sell ? 1 : 0,
        close_to_arrival: x.closed_to_arrival ? 1 : 0,
        close_to_departure: x.closed_to_departure ? 1 : 0,
        min_advanced_booking_offset: x.min_advance_days ?? 0,
        max_advanced_booking_offset: x.max_advance_days ?? 0,
      },
    }));

    // Merge runs of identical days into ranges (far fewer rows on the wire).
    let run: { from: string; to: string; day: DayAri } | null = null;
    const flush = () => {
      if (!run) return;
      ariInfo.push({
        id_room_type: '',
        id_pms_room_type: String(room.pms_id),
        date_from: run.from,
        date_to: run.to,
        weekdays: WEEKDAYS,
        closed: run.day.closed,
        availability: run.day.availability,
        rates: [JSON.stringify(run.day.rate)],
      });
    };
    for (const day of days) {
      const same =
        run && addDays(run.to, 1) === day.date && run.day.availability === day.availability && run.day.closed === day.closed &&
        JSON.stringify(run.day.rate) === JSON.stringify(day.rate);
      if (same) run!.to = day.date;
      else {
        flush();
        run = { from: day.date, to: day.date, day };
      }
    }
    flush();
  }
  return { id_property: '', id_pms_property: String(hotel.pms_id), ari_info: ariInfo };
}

// ---------------------------------------------------------------------------
// Outbound push
// ---------------------------------------------------------------------------

async function fetchToken(account: CmAccount): Promise<string> {
  if (!account.client_id || !account.client_secret) throw new AppError('VALIDATION_ERROR', 'Channel manager API credentials are not set');
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: account.client_id, client_secret: account.client_secret });
  let res: Response;
  try {
    res = await fetch(new URL('/oauth/token', account.base_url), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new HttpCallError('NETWORK', `token request failed: ${(err as Error).message}`);
  }
  const json = (await res.json().catch(() => ({}))) as { access_token?: string };
  if (!res.ok || !json.access_token) throw new HttpCallError('HTTP', `token request rejected (HTTP ${res.status})`, res.status);
  await pool.query('UPDATE cm_accounts SET access_token = $2 WHERE id = $1', [account.id, json.access_token]);
  return json.access_token;
}

/** Pushes ARI for one hotel. Refreshes the OAuth token once on 401. */
export async function pushQloAri(hotelId: string, ranges: Array<{ roomTypeId?: string | null; from: string; to: string }>) {
  const account = (
    await pool.query<CmAccount>(
      `SELECT a.id, a.base_url, a.client_id, a.client_secret, a.access_token, a.push_enabled
         FROM hotels h JOIN cm_accounts a ON a.id = h.cm_account_id WHERE h.id = $1`,
      [hotelId],
    )
  ).rows[0];
  if (!account || !account.push_enabled) return { skipped: true };

  const payload = await buildQloAri(pool, hotelId, ranges);
  if (!payload || !payload.ari_info.length) return { skipped: true };

  const send = (token: string) =>
    requestJson(new URL('/api/v1/push_ari', account.base_url).toString(), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-requested-with': 'XMLHttpRequest', 'x-pms-request': 'true' },
      body: payload,
      timeoutMs: 30_000,
      maxBytes: 256_000,
    });

  try {
    let token = account.access_token ?? (await fetchToken(account));
    let res;
    try {
      res = await send(token);
    } catch (err) {
      if (!(err instanceof HttpCallError && err.status === 401)) throw err;
      token = await fetchToken(account);
      res = await send(token);
    }
    const ok = (res.json as { success?: boolean } | null)?.success;
    if (ok === false) throw new HttpCallError('HTTP', `push_ari rejected: ${JSON.stringify(res.json).slice(0, 300)}`, 422);
    await pool.query('UPDATE cm_accounts SET last_push_at = now(), last_push_error = NULL WHERE id = $1', [account.id]);
    return { pushed: payload.ari_info.length };
  } catch (err) {
    await pool.query('UPDATE cm_accounts SET last_push_error = $2 WHERE id = $1', [account.id, (err as Error).message.slice(0, 500)]);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Inbound bookings (booking_notification)
// ---------------------------------------------------------------------------

export interface CmBookingInput {
  id_property?: number | string;
  id_booking?: number | string;
  id_channel_manager_booking?: string;
  booking_status?: string;
  payment_status?: string;
  currency?: string;
  source?: string;
  business_source?: string;
  booking_date?: string;
  remark?: string;
  guest_detail?: { firstname?: string; lastname?: string; email?: string; phone?: string };
  price_details?: { total_price_with_tax?: string | number };
  room_bookings?: Array<{
    id_room_type?: number | string;
    check_in_date?: string;
    check_out_date?: string;
    number_of_rooms?: number | string;
    rooms?: unknown;
  }>;
}

const DATE = /^\d{4}-\d{2}-\d{2}/;

/** Flattens the CM's rooms list (it may arrive as [], {room: {...}} or {room: [...]}) */
function roomOccupancy(rooms: unknown): { adults: number; children: number } {
  let list: Array<{ occupancy?: { adults?: number | string; children?: number | string } }> = [];
  if (Array.isArray(rooms)) list = rooms;
  else if (rooms && typeof rooms === 'object' && 'room' in rooms) {
    const r = (rooms as { room: unknown }).room;
    list = Array.isArray(r) ? r : r ? [r as never] : [];
  }
  let adults = 0;
  let children = 0;
  for (const r of list) {
    adults += Number(r.occupancy?.adults ?? 0) || 0;
    children += Number(r.occupancy?.children ?? 0) || 0;
  }
  return { adults, children };
}

/**
 * Applies a CM booking notification: new, modified, completed, cancelled, refunded.
 * De-duplicated by the CM's booking id (the CM sends one request per room type with the
 * same id, and retries). Returns the booking in the CM's response shape.
 */
export async function processCmBooking(accountId: string, input: CmBookingInput) {
  const status = String(input.booking_status ?? 'new').toLowerCase();
  const cmId = String(input.id_channel_manager_booking ?? '').trim();
  if (!cmId || cmId.length > 128) throw new AppError('VALIDATION_ERROR', 'id_channel_manager_booking is required');
  if (!['new', 'modified', 'completed', 'cancelled', 'refunded'].includes(status)) throw new AppError('VALIDATION_ERROR', 'Invalid booking status.');

  return withTransaction(async (client) => {
    const hotel = (
      await client.query(
        `SELECT id, pms_id, timezone, currency, inventory_source FROM hotels WHERE pms_id = $1 AND cm_account_id = $2 AND is_active`,
        [Number(input.id_property), accountId],
      )
    ).rows[0];
    if (!hotel) throw new AppError('VALIDATION_ERROR', 'Please provide a valid id_property.');
    if (hotel.inventory_source !== 'EXTRANET') throw new AppError('CONFLICT', 'This property is not managed by this PMS');

    // Resolve the CM's room lines to our room types before touching inventory.
    const lines: OtaLine[] = [];
    if (status === 'new' || status === 'modified' || status === 'completed') {
      for (const line of input.room_bookings ?? []) {
        const checkIn = String(line.check_in_date ?? '').slice(0, 10);
        const checkOut = String(line.check_out_date ?? '').slice(0, 10);
        const rooms = Math.max(1, Math.min(20, Number(line.number_of_rooms ?? 1) || 1));
        if (!DATE.test(checkIn) || !DATE.test(checkOut) || checkOut <= checkIn) throw new AppError('VALIDATION_ERROR', 'Invalid check-in/check-out dates');
        const rt = (await client.query('SELECT id FROM room_types WHERE pms_id = $1 AND hotel_id = $2', [Number(line.id_room_type), hotel.id])).rows[0];
        if (!rt) throw new AppError('VALIDATION_ERROR', 'Requested room(s) not available.');
        const ratePlan = (await client.query('SELECT id FROM rate_plans WHERE room_type_id = $1 AND is_default LIMIT 1', [rt.id])).rows[0];
        const occ = roomOccupancy(line.rooms);
        lines.push({ roomTypeId: rt.id, ratePlanId: ratePlan?.id ?? null, checkIn, checkOut, rooms, adults: occ.adults, children: occ.children });
      }
    }
    const g = input.guest_detail ?? {};
    const { result } = await applyOtaBooking(
      client,
      hotel,
      { kind: 'QLO_CM', accountId, bookingId: cmId },
      {
        status: status === 'refunded' ? 'cancelled' : (status as OtaBooking['status']),
        remark: `Channel manager: ${status}`,
        lines,
        guestName: `${g.firstname ?? ''} ${g.lastname ?? ''}`.trim() || 'OTA guest',
        guestPhone: g.phone ?? null,
        guestEmail: g.email ?? null,
        totalMinor: input.price_details?.total_price_with_tax !== undefined ? decimalToMinor(input.price_details.total_price_with_tax) : null,
        currency: String(input.currency ?? hotel.currency),
        otaName: String(input.source || input.business_source || 'Channel manager'),
        notes: input.remark ?? null,
        referenceCode: cmId,
        via: 'via channel manager',
        payload: input,
      },
    );
    if (result === 'not_found') throw new AppError('NOT_FOUND', 'Referenced booking not found.');
    return bookingResponse(client, accountId, cmId, hotel);
  });
}

async function bookingResponse(client: PoolClient, accountId: string, cmId: string, hotel: { id: string; pms_id: number }) {
  const { rows } = await client.query(
    `SELECT r.*, rt.pms_id AS room_pms_id FROM reservations r JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.cm_account_id = $1 AND r.cm_booking_id = $2 AND r.hotel_id = $3
      ORDER BY (r.status IN ('CONFIRMED','CHECKED_IN')) DESC, r.created_at DESC`,
    [accountId, cmId, hotel.id],
  );
  return formatBooking(rows, hotel.pms_id);
}

/** The CM's booking shape (from qlocmconnector getBookingDetails). */
export function formatBooking(rows: Array<Record<string, any>>, propertyPmsId: number) {
  const live = rows.filter((r) => r.status === 'CONFIRMED' || r.status === 'CHECKED_IN' || r.status === 'CHECKED_OUT');
  const shown = live.length ? live : rows.slice(0, 1);
  const head = shown[0] ?? {};
  const [firstname, ...rest] = String(head.guest_name ?? '').split(' ');
  const total = shown.reduce((s, r) => s + Number(r.amount_minor ?? 0), 0);
  return {
    id: head.pms_id,
    id_pms_booking: head.pms_id,
    id_property: propertyPmsId,
    id_channel_manager_booking: head.cm_booking_id,
    currency: String(head.currency ?? 'INR').trim(),
    source: head.source_detail,
    booking_date: head.created_at,
    current_status: live.length ? 'confirmed' : 'cancelled',
    overbooked: shown.some((r) => r.overbooked),
    associations: {
      guest_detail: { firstname, lastname: rest.join(' '), email: head.guest_email ?? '', phone: head.guest_phone ?? '' },
      price_details: { total_paid: total / 100, total_price_without_tax: total / 100, total_tax: 0 },
      room_types: shown.map((r) => ({
        id_room_type: r.room_pms_id,
        check_in_date: r.check_in,
        check_out_date: r.check_out,
        number_of_rooms: r.rooms,
        rooms: [{ adults: r.adults, child: r.children }],
      })),
    },
  };
}

/** Default pull window for GET /ari when the CM doesn't send one. */
export const defaultAriWindow = (tz: string) => {
  const from = todayIn(tz);
  return { from, to: addDays(from, 364) };
};
