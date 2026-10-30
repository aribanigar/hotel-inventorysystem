/**
 * Writes ARI (availability, rates, restrictions) into our daily tables.
 * Shared by the channel-manager webhook (Source 2) and the extranet (Source 3).
 *
 * Design rules, taken from how SiteMinder/RateGain define ARI pushes:
 *  - Updates arrive as date RANGES and are expanded to one row per night.
 *  - Partial updates: a field that is absent is left unchanged (delta semantics).
 *  - Availability is per room type (shared by all rate plans); price and restrictions
 *    are per rate plan.
 *  - Out-of-order delivery is expected. Each row remembers the source timestamp of the
 *    last change, and an older message never overwrites a newer one.
 */
import type { PoolClient } from 'pg';
import { enqueueForSubscribers } from '../outbox/outbox.js';

export interface AriUpdate {
  roomTypeId: string;
  ratePlanId?: string | null;
  /** Inclusive range of NIGHTS (stay dates). */
  startDate: string;
  endDate: string;
  availability?: number;
  priceMinor?: number;
  currency?: string;
  stopSell?: boolean;
  minLos?: number;
  maxLos?: number | null;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
}

export interface AriApplyResult {
  inventoryRowsWritten: number;
  rateRowsWritten: number;
  /** Rows skipped because we already hold newer data for that night. */
  staleRowsSkipped: number;
}

export async function applyAriUpdates(
  client: PoolClient,
  hotelId: string,
  updates: AriUpdate[],
  sourceTimestamp: Date,
): Promise<AriApplyResult> {
  const result: AriApplyResult = { inventoryRowsWritten: 0, rateRowsWritten: 0, staleRowsSkipped: 0 };

  // Sort so every writer touches rows in the same order (room, then date): this keeps
  // concurrent webhook batches and checkouts from deadlocking on each other.
  const sorted = [...updates].sort(
    (a, b) => a.roomTypeId.localeCompare(b.roomTypeId) || a.startDate.localeCompare(b.startDate),
  );

  for (const u of sorted) {
    const nights = daysInclusive(u.startDate, u.endDate);

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
         ON CONFLICT (room_type_id, stay_date) DO UPDATE SET
              allotment         = COALESCE($4::int, di.allotment),
              stop_sell         = COALESCE($5::boolean, di.stop_sell),
              source_updated_at = EXCLUDED.source_updated_at,
              updated_at        = now()
          WHERE di.source_updated_at <= EXCLUDED.source_updated_at`,
        [u.roomTypeId, u.startDate, u.endDate, u.availability ?? null, u.ratePlanId ? null : (u.stopSell ?? null), sourceTimestamp],
      );
      result.inventoryRowsWritten += r.rowCount ?? 0;
      result.staleRowsSkipped += nights - (r.rowCount ?? 0);
    }

    // --- Rate-plan-level price + restrictions ----------------------------------
    const touchesRate =
      u.priceMinor !== undefined ||
      u.minLos !== undefined ||
      u.maxLos !== undefined ||
      u.closedToArrival !== undefined ||
      u.closedToDeparture !== undefined ||
      (u.stopSell !== undefined && !!u.ratePlanId);

    if (u.ratePlanId && touchesRate) {
      // max_los uses a sentinel because NULL is a meaningful value ("no maximum"):
      //   $9 = true  -> set max_los to $8 (which may be NULL)
      //   $9 = false -> keep current max_los
      const r = await client.query(
        `INSERT INTO daily_rates AS dr
                (rate_plan_id, stay_date, price_minor, currency, min_los, max_los,
                 closed_to_arrival, closed_to_departure, stop_sell, source_updated_at)
         SELECT $1, d::date, $4::bigint, COALESCE($5::char(3), 'INR'), COALESCE($6::smallint, 1),
                CASE WHEN $9::boolean THEN $8::smallint END,
                COALESCE($10::boolean, false), COALESCE($11::boolean, false), COALESCE($7::boolean, false), $12
           FROM generate_series($2::date, $3::date, interval '1 day') AS d
         ON CONFLICT (rate_plan_id, stay_date) DO UPDATE SET
              price_minor         = COALESCE($4::bigint, dr.price_minor),
              currency            = COALESCE($5::char(3), dr.currency),
              min_los             = COALESCE($6::smallint, dr.min_los),
              max_los             = CASE WHEN $9::boolean THEN $8::smallint ELSE dr.max_los END,
              closed_to_arrival   = COALESCE($10::boolean, dr.closed_to_arrival),
              closed_to_departure = COALESCE($11::boolean, dr.closed_to_departure),
              stop_sell           = COALESCE($7::boolean, dr.stop_sell),
              source_updated_at   = EXCLUDED.source_updated_at,
              updated_at          = now()
          WHERE dr.source_updated_at <= EXCLUDED.source_updated_at`,
        [
          u.ratePlanId,
          u.startDate,
          u.endDate,
          u.priceMinor ?? null,
          u.currency ?? null,
          u.minLos ?? null,
          u.stopSell ?? null,
          u.maxLos ?? null,
          u.maxLos !== undefined,
          u.closedToArrival ?? null,
          u.closedToDeparture ?? null,
          sourceTimestamp,
        ],
      );
      result.rateRowsWritten += r.rowCount ?? 0;
      result.staleRowsSkipped += nights - (r.rowCount ?? 0);
    }
  }

  // Tell downstream channels which ranges changed (same transaction = can't be lost).
  if (result.inventoryRowsWritten + result.rateRowsWritten > 0) {
    await enqueueForSubscribers(client, hotelId, 'ARI_CHANGED', {
      changes: sorted.map((u) => ({ roomTypeId: u.roomTypeId, ratePlanId: u.ratePlanId ?? null, from: u.startDate, to: u.endDate })),
      sourceTimestamp: sourceTimestamp.toISOString(),
    });
  }
  return result;
}

function daysInclusive(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}
