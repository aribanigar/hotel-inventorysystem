/**
 * Writes ARI (availability, rates, restrictions) into our daily tables.
 * Shared by the channel-manager webhook (Source 2), the extranet (Source 3) and the
 * hotelier bulk editor.
 *
 * Design rules, taken from how SiteMinder/RateGain/QloApps define ARI pushes:
 *  - Updates arrive as date RANGES, optionally limited to some WEEKDAYS (e.g. only Fri
 *    and Sat), and are expanded to one row per night.
 *  - Partial updates: a field that is absent is left unchanged (delta semantics).
 *  - Availability is per room type (shared by all rate plans); price and restrictions
 *    are per rate plan.
 *  - Out-of-order delivery is expected. Each row remembers the source timestamp of the
 *    last change, and an older message never overwrites a newer one.
 *  - Derived rate plans are recalculated in the same transaction as their parent, so
 *    checkout always reads a stored, current price.
 */
import type { PoolClient } from 'pg';
import { enqueueForSubscribers } from '../outbox/outbox.js';

export interface AriUpdate {
  roomTypeId: string;
  ratePlanId?: string | null;
  /** Inclusive range of NIGHTS (stay dates). */
  startDate: string;
  endDate: string;
  /** Only apply to these weekdays (0 = Sunday ... 6 = Saturday). Omit for every day. */
  weekdays?: number[];
  availability?: number;
  priceMinor?: number;
  currency?: string;
  stopSell?: boolean;
  /** Length-of-stay rules counted on the arrival day. */
  minLos?: number;
  maxLos?: number | null;
  /** Length-of-stay rules checked on every night of the stay. */
  minStayThrough?: number;
  maxStayThrough?: number | null;
  /** Booking window: days between booking and arrival. */
  minAdvanceDays?: number;
  maxAdvanceDays?: number | null;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
  extraAdultMinor?: number;
  extraChildMinor?: number;
}

export interface AriApplyResult {
  inventoryRowsWritten: number;
  rateRowsWritten: number;
  /** Rows skipped because we already hold newer data for that night. */
  staleRowsSkipped: number;
  /** Rows of derived plans recalculated because a parent changed. */
  derivedRowsWritten: number;
}

/** True if the update changes anything at the rate-plan level. */
export function touchesRatePlan(u: AriUpdate): boolean {
  return (
    u.priceMinor !== undefined ||
    u.minLos !== undefined ||
    u.maxLos !== undefined ||
    u.minStayThrough !== undefined ||
    u.maxStayThrough !== undefined ||
    u.minAdvanceDays !== undefined ||
    u.maxAdvanceDays !== undefined ||
    u.closedToArrival !== undefined ||
    u.closedToDeparture !== undefined ||
    u.extraAdultMinor !== undefined ||
    u.extraChildMinor !== undefined ||
    (u.stopSell !== undefined && !!u.ratePlanId)
  );
}

export async function applyAriUpdates(
  client: PoolClient,
  hotelId: string,
  updates: AriUpdate[],
  sourceTimestamp: Date,
): Promise<AriApplyResult> {
  const result: AriApplyResult = { inventoryRowsWritten: 0, rateRowsWritten: 0, staleRowsSkipped: 0, derivedRowsWritten: 0 };

  // Sort so every writer touches rows in the same order (room, then date): this keeps
  // concurrent webhook batches and checkouts from deadlocking on each other.
  const sorted = [...updates].sort(
    (a, b) => a.roomTypeId.localeCompare(b.roomTypeId) || a.startDate.localeCompare(b.startDate),
  );
  const parentsTouched = new Map<string, { from: string; to: string }>();

  for (const u of sorted) {
    const nights = countNights(u.startDate, u.endDate, u.weekdays);
    if (nights === 0) continue;
    const weekdays = u.weekdays && u.weekdays.length < 7 ? u.weekdays : null;

    // --- Room-level inventory -------------------------------------------------
    if (u.availability !== undefined || (u.stopSell !== undefined && !u.ratePlanId)) {
      // UPSERT: INSERT ... ON CONFLICT DO UPDATE is a single atomic statement.
      // A "SELECT, then INSERT or UPDATE" in app code would race: two pushes for a
      // new date would both see "no row" and one INSERT would fail.
      //
      // COALESCE($n, current) implements delta semantics: NULL param = keep value.
      // The WHERE clause on DO UPDATE is the stale-message guard.
      // `held` is never touched here: holds belong to our checkout flow, not the CM.
      const r = await client.query(
        `INSERT INTO daily_inventory AS di (room_type_id, stay_date, allotment, stop_sell, source_updated_at)
         SELECT $1, d::date, COALESCE($4::int, 0), COALESCE($5::boolean, false), $6
           FROM generate_series($2::date, $3::date, interval '1 day') AS d
          WHERE $7::int[] IS NULL OR extract(dow FROM d)::int = ANY($7::int[])
         ON CONFLICT (room_type_id, stay_date) DO UPDATE SET
              allotment         = COALESCE($4::int, di.allotment),
              stop_sell         = COALESCE($5::boolean, di.stop_sell),
              source_updated_at = EXCLUDED.source_updated_at,
              updated_at        = now()
          WHERE di.source_updated_at <= EXCLUDED.source_updated_at`,
        [u.roomTypeId, u.startDate, u.endDate, u.availability ?? null, u.ratePlanId ? null : (u.stopSell ?? null), sourceTimestamp, weekdays],
      );
      result.inventoryRowsWritten += r.rowCount ?? 0;
      result.staleRowsSkipped += nights - (r.rowCount ?? 0);
    }

    // --- Rate-plan-level price + restrictions ----------------------------------
    if (u.ratePlanId && touchesRatePlan(u)) {
      // Nullable limits (max_los, max_stay_through, max_advance_days) use a "set" flag,
      // because NULL is a real value there ("no maximum"):
      //   flag = true  -> set the column to the given value (which may be NULL)
      //   flag = false -> keep the current value
      const r = await client.query(
        `INSERT INTO daily_rates AS dr
                (rate_plan_id, stay_date, price_minor, currency, min_los, max_los,
                 closed_to_arrival, closed_to_departure, stop_sell,
                 min_stay_through, max_stay_through, min_advance_days, max_advance_days,
                 extra_adult_minor, extra_child_minor, source_updated_at)
         SELECT $1, d::date, $4::bigint, COALESCE($5::char(3), 'INR'), COALESCE($6::smallint, 1),
                CASE WHEN $9::boolean THEN $8::smallint END,
                COALESCE($10::boolean, false), COALESCE($11::boolean, false), COALESCE($7::boolean, false),
                COALESCE($14::smallint, 1), CASE WHEN $16::boolean THEN $15::smallint END,
                COALESCE($17::smallint, 0), CASE WHEN $19::boolean THEN $18::smallint END,
                COALESCE($20::bigint, 0), COALESCE($21::bigint, 0), $12
           FROM generate_series($2::date, $3::date, interval '1 day') AS d
          WHERE $13::int[] IS NULL OR extract(dow FROM d)::int = ANY($13::int[])
         ON CONFLICT (rate_plan_id, stay_date) DO UPDATE SET
              price_minor         = COALESCE($4::bigint, dr.price_minor),
              currency            = COALESCE($5::char(3), dr.currency),
              min_los             = COALESCE($6::smallint, dr.min_los),
              max_los             = CASE WHEN $9::boolean THEN $8::smallint ELSE dr.max_los END,
              closed_to_arrival   = COALESCE($10::boolean, dr.closed_to_arrival),
              closed_to_departure = COALESCE($11::boolean, dr.closed_to_departure),
              stop_sell           = COALESCE($7::boolean, dr.stop_sell),
              min_stay_through    = COALESCE($14::smallint, dr.min_stay_through),
              max_stay_through    = CASE WHEN $16::boolean THEN $15::smallint ELSE dr.max_stay_through END,
              min_advance_days    = COALESCE($17::smallint, dr.min_advance_days),
              max_advance_days    = CASE WHEN $19::boolean THEN $18::smallint ELSE dr.max_advance_days END,
              extra_adult_minor   = COALESCE($20::bigint, dr.extra_adult_minor),
              extra_child_minor   = COALESCE($21::bigint, dr.extra_child_minor),
              source_updated_at   = EXCLUDED.source_updated_at,
              updated_at          = now()
          WHERE dr.source_updated_at <= EXCLUDED.source_updated_at`,
        [
          u.ratePlanId, //                         $1
          u.startDate, //                          $2
          u.endDate, //                            $3
          u.priceMinor ?? null, //                 $4
          u.currency ?? null, //                   $5
          u.minLos ?? null, //                     $6
          u.stopSell ?? null, //                   $7
          u.maxLos ?? null, //                     $8
          u.maxLos !== undefined, //               $9
          u.closedToArrival ?? null, //            $10
          u.closedToDeparture ?? null, //          $11
          sourceTimestamp, //                      $12
          weekdays, //                             $13
          u.minStayThrough ?? null, //             $14
          u.maxStayThrough ?? null, //             $15
          u.maxStayThrough !== undefined, //       $16
          u.minAdvanceDays ?? null, //             $17
          u.maxAdvanceDays ?? null, //             $18
          u.maxAdvanceDays !== undefined, //       $19
          u.extraAdultMinor ?? null, //            $20
          u.extraChildMinor ?? null, //            $21
        ],
      );
      result.rateRowsWritten += r.rowCount ?? 0;
      result.staleRowsSkipped += nights - (r.rowCount ?? 0);

      const prev = parentsTouched.get(u.ratePlanId);
      parentsTouched.set(u.ratePlanId, {
        from: prev && prev.from < u.startDate ? prev.from : u.startDate,
        to: prev && prev.to > u.endDate ? prev.to : u.endDate,
      });
    }
  }

  // Recalculate every derived plan whose parent just changed (same transaction).
  for (const [parentId, range] of parentsTouched) {
    result.derivedRowsWritten += await rederiveChildren(client, parentId, range.from, range.to);
  }

  // Tell downstream channels which ranges changed (same transaction = can't be lost).
  if (result.inventoryRowsWritten + result.rateRowsWritten + result.derivedRowsWritten > 0) {
    const changes = sorted.map((u) => ({ roomTypeId: u.roomTypeId, ratePlanId: u.ratePlanId ?? null, from: u.startDate, to: u.endDate }));
    if (result.derivedRowsWritten > 0) {
      const { rows } = await client.query<{ id: string; room_type_id: string; parent_rate_plan_id: string }>(
        `SELECT id, room_type_id, parent_rate_plan_id FROM rate_plans WHERE parent_rate_plan_id = ANY($1::uuid[]) AND rate_mode = 'DERIVED'`,
        [[...parentsTouched.keys()]],
      );
      for (const c of rows) {
        const r = parentsTouched.get(c.parent_rate_plan_id)!;
        changes.push({ roomTypeId: c.room_type_id, ratePlanId: c.id, from: r.from, to: r.to });
      }
    }
    await enqueueForSubscribers(client, hotelId, 'ARI_CHANGED', { changes, sourceTimestamp: sourceTimestamp.toISOString() });
  }
  return result;
}

/**
 * Recomputes derived rate plans from their parent for a date range.
 * Price: parent price adjusted by % (rounded to the whole rupee) or by an amount, never
 * below Rs 1. Extra-guest prices are copied. Restrictions are copied when the child
 * follows its parent; otherwise the child's own restrictions are kept.
 */
export async function rederiveChildren(client: PoolClient, parentRatePlanId: string, from: string, to: string, onlyChildId?: string): Promise<number> {
  const r = await client.query(
    `INSERT INTO daily_rates AS dr
            (rate_plan_id, stay_date, price_minor, currency, min_los, max_los, closed_to_arrival, closed_to_departure,
             stop_sell, min_stay_through, max_stay_through, min_advance_days, max_advance_days,
             extra_adult_minor, extra_child_minor, source_updated_at)
     SELECT c.id, p.stay_date,
            CASE
              WHEN p.price_minor IS NULL THEN NULL
              WHEN c.derive_type = 'AMOUNT' THEN GREATEST(p.price_minor + c.derive_value, 100)
              ELSE GREATEST(round(p.price_minor * (10000 + c.derive_value) / 1000000.0) * 100, 100)::bigint
            END,
            p.currency,
            CASE WHEN c.follow_parent_restrictions THEN p.min_los ELSE COALESCE(own.min_los, 1) END,
            CASE WHEN c.follow_parent_restrictions THEN p.max_los ELSE own.max_los END,
            CASE WHEN c.follow_parent_restrictions THEN p.closed_to_arrival ELSE COALESCE(own.closed_to_arrival, false) END,
            CASE WHEN c.follow_parent_restrictions THEN p.closed_to_departure ELSE COALESCE(own.closed_to_departure, false) END,
            CASE WHEN c.follow_parent_restrictions THEN p.stop_sell ELSE COALESCE(own.stop_sell, false) END,
            CASE WHEN c.follow_parent_restrictions THEN p.min_stay_through ELSE COALESCE(own.min_stay_through, 1) END,
            CASE WHEN c.follow_parent_restrictions THEN p.max_stay_through ELSE own.max_stay_through END,
            CASE WHEN c.follow_parent_restrictions THEN p.min_advance_days ELSE COALESCE(own.min_advance_days, 0) END,
            CASE WHEN c.follow_parent_restrictions THEN p.max_advance_days ELSE own.max_advance_days END,
            p.extra_adult_minor, p.extra_child_minor, now()
       FROM rate_plans c
       JOIN daily_rates p ON p.rate_plan_id = c.parent_rate_plan_id AND p.stay_date BETWEEN $2 AND $3
       LEFT JOIN daily_rates own ON own.rate_plan_id = c.id AND own.stay_date = p.stay_date
      WHERE c.parent_rate_plan_id = $1 AND c.rate_mode = 'DERIVED' AND ($4::uuid IS NULL OR c.id = $4::uuid)
     ON CONFLICT (rate_plan_id, stay_date) DO UPDATE SET
          price_minor = EXCLUDED.price_minor, currency = EXCLUDED.currency,
          min_los = EXCLUDED.min_los, max_los = EXCLUDED.max_los,
          closed_to_arrival = EXCLUDED.closed_to_arrival, closed_to_departure = EXCLUDED.closed_to_departure,
          stop_sell = EXCLUDED.stop_sell, min_stay_through = EXCLUDED.min_stay_through,
          max_stay_through = EXCLUDED.max_stay_through, min_advance_days = EXCLUDED.min_advance_days,
          max_advance_days = EXCLUDED.max_advance_days, extra_adult_minor = EXCLUDED.extra_adult_minor,
          extra_child_minor = EXCLUDED.extra_child_minor, source_updated_at = now(), updated_at = now()`,
    [parentRatePlanId, from, to, onlyChildId ?? null],
  );
  return r.rowCount ?? 0;
}

/** Nights in [start, end] (inclusive) that fall on the given weekdays. */
export function countNights(start: string, end: string, weekdays?: number[]): number {
  const total = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
  if (!weekdays || weekdays.length >= 7) return Math.max(total, 0);
  const set = new Set(weekdays);
  const startDow = new Date(`${start}T00:00:00Z`).getUTCDay();
  let n = 0;
  for (let i = 0; i < total; i++) if (set.has((startDow + i) % 7)) n++;
  return n;
}
