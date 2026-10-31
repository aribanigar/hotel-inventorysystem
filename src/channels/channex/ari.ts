/**
 * ARI push to Channex: availability per room type, and rate + restrictions per rate
 * plan, sent as true deltas.
 *
 * Flow:
 *   1. Any ARI change calls markChannexDirty() inside the SAME transaction (from
 *      outbox.enqueueForSubscribers), so a change can never be lost.
 *   2. pushDueChannexProperties() (background loop) claims properties whose throttle
 *      window has passed, reads the dirty ranges, computes the current values per
 *      night and compares them with what Channex last accepted (channex_sent_*).
 *   3. Only nights that differ are sent, merged into date ranges: at most ONE
 *      POST /availability and ONE POST /restrictions per property per push.
 *   4. On success the "sent" snapshot is updated and the dirty rows are removed. On
 *      429/5xx/network errors the rows stay and the property backs off (1 min, doubling,
 *      max 15 min), as Channex's rate-limit guide asks.
 *
 * Full sync (go-live or recovery) clears the snapshot and marks the whole horizon
 * dirty, which yields exactly 2 calls covering 500 days.
 *
 * Mapping to Channex fields:
 *   available rooms                    -> availability
 *   price (paise, integer)             -> rate (integer in currency minor units)
 *   min LOS on arrival                 -> min_stay_arrival
 *   min stay-through                   -> min_stay_through
 *   max LOS (arrival, else through)    -> max_stay (0 = no limit)
 *   CTA / CTD                          -> closed_to_arrival / closed_to_departure
 *   rate stop-sell, room stop-sell,
 *   or no price loaded                 -> stop_sell
 * Not sent (Channex has no field): min/max days before arrival, extra adult/child
 * price. We still enforce them on our own checkout.
 */
import type { PoolClient } from 'pg';
import { config } from '../../config.js';
import { pool } from '../../db/pool.js';
import { addDays, todayIn } from '../../lib/dates.js';
import { HttpCallError } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { channex, channexConfigured, describeChannexError } from './client.js';

type Db = PoolClient | typeof pool;

interface Change {
  roomTypeId?: string | null;
  ratePlanId?: string | null;
  from: string;
  to: string;
}

/** Records changed ranges for the hotel's Channex property (no-op if not connected). */
export async function markChannexDirty(client: PoolClient, hotelId: string, changes: Change[]): Promise<number> {
  const rows = changes
    .filter((c) => c && typeof c.from === 'string' && typeof c.to === 'string')
    .map((c) => ({
      room_type_id: c.roomTypeId ?? null,
      rate_plan_id: c.ratePlanId ?? null,
      date_from: c.from <= c.to ? c.from : c.to,
      date_to: c.from <= c.to ? c.to : c.from,
    }));
  if (!rows.length) return 0;
  const r = await client.query(
    `INSERT INTO channex_dirty (hotel_id, room_type_id, rate_plan_id, date_from, date_to)
     SELECT $1, c.room_type_id, c.rate_plan_id, c.date_from, c.date_to
       FROM jsonb_to_recordset($2::jsonb) AS c(room_type_id uuid, rate_plan_id uuid, date_from date, date_to date)
      WHERE EXISTS (SELECT 1 FROM channex_properties p WHERE p.hotel_id = $1 AND p.push_enabled)`,
    [hotelId, JSON.stringify(rows)],
  );
  return r.rowCount ?? 0;
}

/** Forces the next push to resend the whole horizon (2 calls, 500 days). */
export async function queueChannexFullSync(client: PoolClient, hotelId: string): Promise<boolean> {
  const p = (await client.query('SELECT h.timezone FROM channex_properties p JOIN hotels h ON h.id = p.hotel_id WHERE p.hotel_id = $1', [hotelId])).rows[0];
  if (!p) return false;
  const today = todayIn(p.timezone);
  await client.query(
    `DELETE FROM channex_sent_availability WHERE room_type_id IN (SELECT room_type_id FROM channex_room_map WHERE hotel_id = $1)`,
    [hotelId],
  );
  await client.query(
    `DELETE FROM channex_sent_restrictions WHERE rate_plan_id IN (SELECT rate_plan_id FROM channex_rate_map WHERE hotel_id = $1)`,
    [hotelId],
  );
  await client.query(
    `INSERT INTO channex_dirty (hotel_id, room_type_id, rate_plan_id, date_from, date_to) VALUES ($1, NULL, NULL, $2, $3)`,
    [hotelId, today, addDays(today, config.CHANNEX_HORIZON_DAYS - 1)],
  );
  await client.query(`UPDATE channex_properties SET last_full_sync_at = now() WHERE hotel_id = $1`, [hotelId]);
  return true;
}

// ---------------------------------------------------------------------------
// Building the delta
// ---------------------------------------------------------------------------

interface Window {
  from: string;
  to: string;
}
const widen = (m: Map<string, Window>, key: string, w: Window) => {
  const prev = m.get(key);
  m.set(key, { from: !prev || w.from < prev.from ? w.from : prev.from, to: !prev || w.to > prev.to ? w.to : prev.to });
};

export interface ChannexDelta {
  availability: Array<{ property_id: string; room_type_id: string; date_from: string; date_to: string; availability: number }>;
  restrictions: Array<Record<string, unknown>>;
  /** Per-night values to store as "sent" once Channex accepts the call. */
  sentAvailability: Array<{ roomTypeId: string; date: string; availability: number }>;
  sentRestrictions: Array<{ ratePlanId: string; date: string; sig: string }>;
  /** Dirty rows this delta covers. Only these are deleted after success, so a change
   *  that commits while the push is in flight is kept for the next push. */
  dirtyIds: string[];
}

/** Groups consecutive nights with identical values into ranges. */
function toRanges<T>(days: Array<{ date: string; key: string; value: T }>): Array<{ from: string; to: string; value: T }> {
  const out: Array<{ from: string; to: string; value: T; key: string }> = [];
  for (const d of days) {
    const last = out[out.length - 1];
    if (last && last.key === d.key && addDays(last.to, 1) === d.date) last.to = d.date;
    else out.push({ from: d.date, to: d.date, value: d.value, key: d.key });
  }
  return out;
}

export async function buildChannexDelta(db: Db, hotelId: string, channexPropertyId: string): Promise<ChannexDelta> {
  const empty: ChannexDelta = { availability: [], restrictions: [], sentAvailability: [], sentRestrictions: [], dirtyIds: [] };
  const h = (await db.query('SELECT timezone FROM hotels WHERE id = $1', [hotelId])).rows[0];
  if (!h) return empty;
  const today = todayIn(h.timezone);
  const horizonEnd = addDays(today, config.CHANNEX_HORIZON_DAYS - 1);

  const raw = (
    await db.query<{ id: string; room_type_id: string | null; rate_plan_id: string | null; date_from: string; date_to: string }>(
      `SELECT id::text, room_type_id, rate_plan_id, date_from::text, date_to::text
         FROM channex_dirty WHERE hotel_id = $1 ORDER BY id LIMIT 5000`,
      [hotelId],
    )
  ).rows;
  if (!raw.length) return empty;
  const grouped = new Map<string, { room_type_id: string | null; rate_plan_id: string | null; date_from: string; date_to: string }>();
  for (const r of raw) {
    const k = `${r.room_type_id}|${r.rate_plan_id}`;
    const g = grouped.get(k);
    if (!g) grouped.set(k, { ...r });
    else {
      if (r.date_from < g.date_from) g.date_from = r.date_from;
      if (r.date_to > g.date_to) g.date_to = r.date_to;
    }
  }
  const dirty = [...grouped.values()];

  const rooms = (
    await db.query<{ room_type_id: string; channex_room_type_id: string }>(
      'SELECT room_type_id, channex_room_type_id FROM channex_room_map WHERE hotel_id = $1',
      [hotelId],
    )
  ).rows;
  const plans = (
    await db.query<{ rate_plan_id: string; channex_rate_plan_id: string; room_type_id: string }>(
      `SELECT m.rate_plan_id, m.channex_rate_plan_id, rp.room_type_id
         FROM channex_rate_map m JOIN rate_plans rp ON rp.id = m.rate_plan_id WHERE m.hotel_id = $1`,
      [hotelId],
    )
  ).rows;

  // Which room types / rate plans need checking, over which window.
  const roomWin = new Map<string, Window>();
  const planWin = new Map<string, Window>();
  for (const d of dirty) {
    const w = { from: d.date_from < today ? today : d.date_from, to: d.date_to > horizonEnd ? horizonEnd : d.date_to };
    if (w.from > w.to) continue;
    const roomTargets = d.room_type_id ? rooms.filter((r) => r.room_type_id === d.room_type_id) : rooms;
    for (const r of roomTargets) widen(roomWin, r.room_type_id, w); // any change may move availability
    const planTargets = d.rate_plan_id
      ? plans.filter((p) => p.rate_plan_id === d.rate_plan_id)
      : plans.filter((p) => !d.room_type_id || p.room_type_id === d.room_type_id);
    for (const p of planTargets) widen(planWin, p.rate_plan_id, w);
  }

  const delta: ChannexDelta = { ...empty, dirtyIds: raw.map((r) => r.id) };

  for (const r of rooms) {
    const w = roomWin.get(r.room_type_id);
    if (!w) continue;
    const { rows } = await db.query<{ date: string; v: number; sent: number | null }>(
      `SELECT d::date::text AS date, COALESCE(i.available, 0)::int AS v, s.availability AS sent
         FROM generate_series($2::date, $3::date, interval '1 day') d
         LEFT JOIN daily_inventory i ON i.room_type_id = $1 AND i.stay_date = d::date
         LEFT JOIN channex_sent_availability s ON s.room_type_id = $1 AND s.stay_date = d::date
        ORDER BY d`,
      [r.room_type_id, w.from, w.to],
    );
    const changed = rows.filter((x) => x.sent === null || x.sent !== x.v);
    for (const x of changed) delta.sentAvailability.push({ roomTypeId: r.room_type_id, date: x.date, availability: x.v });
    for (const g of toRanges(changed.map((x) => ({ date: x.date, key: String(x.v), value: x.v })))) {
      delta.availability.push({ property_id: channexPropertyId, room_type_id: r.channex_room_type_id, date_from: g.from, date_to: g.to, availability: g.value });
    }
  }

  for (const p of plans) {
    const w = planWin.get(p.rate_plan_id);
    if (!w) continue;
    const { rows } = await db.query(
      `SELECT d::date::text AS date, r.price_minor, r.min_los, r.max_los, r.min_stay_through, r.max_stay_through,
              COALESCE(r.closed_to_arrival, false) AS cta, COALESCE(r.closed_to_departure, false) AS ctd,
              (r.rate_plan_id IS NULL OR r.price_minor IS NULL OR r.stop_sell OR COALESCE(i.stop_sell, false)) AS stop_sell,
              s.sig AS sent
         FROM generate_series($2::date, $3::date, interval '1 day') d
         LEFT JOIN daily_rates r ON r.rate_plan_id = $1 AND r.stay_date = d::date
         LEFT JOIN daily_inventory i ON i.room_type_id = $4 AND i.stay_date = d::date
         LEFT JOIN channex_sent_restrictions s ON s.rate_plan_id = $1 AND s.stay_date = d::date
        ORDER BY d`,
      [p.rate_plan_id, w.from, w.to, p.room_type_id],
    );
    const days = rows.map((x) => {
      // Fixed key order: the JSON string doubles as the comparison signature.
      const v: Record<string, unknown> = {};
      if (x.price_minor !== null && x.price_minor !== undefined) v.rate = Number(x.price_minor);
      v.min_stay_arrival = Math.max(1, Number(x.min_los ?? 1));
      v.min_stay_through = Math.max(1, Number(x.min_stay_through ?? 1));
      v.max_stay = Number(x.max_los ?? x.max_stay_through ?? 0);
      v.closed_to_arrival = Boolean(x.cta);
      v.closed_to_departure = Boolean(x.ctd);
      v.stop_sell = Boolean(x.stop_sell);
      return { date: x.date as string, sig: JSON.stringify(v), sent: x.sent as string | null, value: v };
    });
    const changed = days.filter((x) => x.sig !== x.sent);
    for (const x of changed) delta.sentRestrictions.push({ ratePlanId: p.rate_plan_id, date: x.date, sig: x.sig });
    for (const g of toRanges(changed.map((x) => ({ date: x.date, key: x.sig, value: x.value })))) {
      delta.restrictions.push({ property_id: channexPropertyId, rate_plan_id: p.channex_rate_plan_id, date_from: g.from, date_to: g.to, ...g.value });
    }
  }
  return delta;
}

// ---------------------------------------------------------------------------
// Push loop
// ---------------------------------------------------------------------------

async function recordSentAvailability(rows: ChannexDelta['sentAvailability']) {
  if (!rows.length) return;
  await pool.query(
    `INSERT INTO channex_sent_availability (room_type_id, stay_date, availability)
     SELECT * FROM unnest($1::uuid[], $2::date[], $3::int[])
     ON CONFLICT (room_type_id, stay_date) DO UPDATE SET availability = EXCLUDED.availability`,
    [rows.map((r) => r.roomTypeId), rows.map((r) => r.date), rows.map((r) => r.availability)],
  );
}
async function recordSentRestrictions(rows: ChannexDelta['sentRestrictions']) {
  if (!rows.length) return;
  await pool.query(
    `INSERT INTO channex_sent_restrictions (rate_plan_id, stay_date, sig)
     SELECT * FROM unnest($1::uuid[], $2::date[], $3::text[])
     ON CONFLICT (rate_plan_id, stay_date) DO UPDATE SET sig = EXCLUDED.sig`,
    [rows.map((r) => r.ratePlanId), rows.map((r) => r.date), rows.map((r) => r.sig)],
  );
}

const taskIds = (res: { data?: unknown }) =>
  (Array.isArray(res.data) ? res.data : []).map((t: { id?: string }) => t?.id).filter((x): x is string => typeof x === 'string');

/** Pushes one claimed property. Returns the number of Channex calls made. */
async function pushProperty(p: { hotel_id: string; channex_property_id: string; consecutive_failures: number }): Promise<number> {
  const delta = await buildChannexDelta(pool, p.hotel_id, p.channex_property_id);
  let calls = 0;
  const tasks: string[] = [];
  const warnings: unknown[] = [];
  try {
    if (delta.availability.length) {
      const res = await channex('POST', '/api/v1/availability', { values: delta.availability });
      calls++;
      tasks.push(...taskIds(res));
      warnings.push(...(res.meta?.warnings ?? []));
      await recordSentAvailability(delta.sentAvailability);
    }
    if (delta.restrictions.length) {
      const res = await channex('POST', '/api/v1/restrictions', { values: delta.restrictions });
      calls++;
      tasks.push(...taskIds(res));
      warnings.push(...(res.meta?.warnings ?? []));
      await recordSentRestrictions(delta.sentRestrictions);
    }
    // The ranges we read are now reflected in Channex (or were unchanged).
    if (delta.dirtyIds.length) await pool.query('DELETE FROM channex_dirty WHERE id = ANY($1::bigint[])', [delta.dirtyIds]);
    if (warnings.length) logger.warn({ hotelId: p.hotel_id, warnings: warnings.slice(0, 5) }, 'Channex accepted the push with warnings (some values rejected)');
    await pool.query(
      `UPDATE channex_properties
          SET locked_until = NULL, consecutive_failures = 0, last_push_error = NULL,
              last_push_at = CASE WHEN $2 > 0 THEN now() ELSE last_push_at END,
              last_task_ids = CASE WHEN $2 > 0 THEN $3::text[] ELSE last_task_ids END,
              last_warnings = CASE WHEN $2 > 0 THEN $4::jsonb ELSE last_warnings END,
              next_push_at = now() + make_interval(secs => $5::float8 / 1000)
        WHERE hotel_id = $1`,
      [p.hotel_id, calls, tasks, warnings.length ? JSON.stringify(warnings.slice(0, 20)) : null, config.CHANNEX_MIN_PUSH_INTERVAL_MS],
    );
    return calls;
  } catch (err) {
    const failures = p.consecutive_failures + 1;
    // Channex: "if you hit any error you should pause updates for the property for 1 minute".
    const backoffS = Math.min(60 * 2 ** (failures - 1), 900);
    const message = describeChannexError(err);
    await pool.query(
      `UPDATE channex_properties SET locked_until = NULL, consecutive_failures = $2, last_push_error = $3,
              next_push_at = now() + make_interval(secs => $4) WHERE hotel_id = $1`,
      [p.hotel_id, failures, message, backoffS],
    );
    const level = failures >= 3 || (err instanceof HttpCallError && err.status === 401) ? 'error' : 'warn';
    logger[level]({ hotelId: p.hotel_id, failures, retryInS: backoffS, message }, level === 'error' ? 'ALERT: Channex push keeps failing' : 'Channex push failed, backing off');
    return calls;
  }
}

/** Background loop body: push every property that has changes and is out of its throttle window. */
export async function pushDueChannexProperties(limit = 10): Promise<number> {
  if (!channexConfigured()) return 0;
  const { rows } = await pool.query(
    `UPDATE channex_properties p SET locked_until = now() + interval '90 seconds'
      WHERE p.hotel_id IN (
              SELECT q.hotel_id FROM channex_properties q
               WHERE q.push_enabled AND q.next_push_at <= now()
                 AND (q.locked_until IS NULL OR q.locked_until < now())
                 AND EXISTS (SELECT 1 FROM channex_dirty d WHERE d.hotel_id = q.hotel_id)
               ORDER BY q.next_push_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING p.hotel_id, p.channex_property_id, p.consecutive_failures`,
    [limit],
  );
  const results = await Promise.allSettled(rows.map((r) => pushProperty(r)));
  return results.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value : 0), 0);
}

/** Housekeeping: forget "sent" snapshots for nights that are in the past. */
export async function pruneChannexSnapshots(): Promise<number> {
  const a = await pool.query(`DELETE FROM channex_sent_availability WHERE stay_date < current_date - 2`);
  const b = await pool.query(`DELETE FROM channex_sent_restrictions WHERE stay_date < current_date - 2`);
  return (a.rowCount ?? 0) + (b.rowCount ?? 0);
}
