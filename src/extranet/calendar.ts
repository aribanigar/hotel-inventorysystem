/**
 * The hotelier's calendar: for each room type and each date, what is free to sell,
 * what is sold (offline + online), what is held in someone's checkout right now, the
 * price and the restrictions. One query per concern, no N+1.
 */
import { pool } from '../db/pool.js';
import { addDays, isIsoDate } from '../lib/dates.js';
import { AppError } from '../lib/errors.js';

export const MAX_CALENDAR_DAYS = 62;

export async function getCalendar(hotelId: string, from: string, days: number) {
  if (!isIsoDate(from)) throw new AppError('VALIDATION_ERROR', 'from must be YYYY-MM-DD');
  if (!Number.isInteger(days) || days < 1 || days > MAX_CALENDAR_DAYS) {
    throw new AppError('VALIDATION_ERROR', `days must be 1-${MAX_CALENDAR_DAYS}`);
  }
  const to = addDays(from, days - 1);

  const hotel = (
    await pool.query(
      `SELECT h.id, h.name, h.inventory_source, h.timezone, h.currency, cp.name AS partner_name
         FROM hotels h LEFT JOIN channel_partners cp ON cp.id = h.channel_partner_id WHERE h.id = $1`,
      [hotelId],
    )
  ).rows[0];
  if (!hotel) throw new AppError('NOT_FOUND', 'Hotel not found');

  const rooms = (
    await pool.query(
      `SELECT rt.id, rt.name, rt.code, rt.max_occupancy, rp.id AS rate_plan_id, rp.name AS rate_plan_name, rp.meal_plan
         FROM room_types rt
         LEFT JOIN rate_plans rp ON rp.room_type_id = rt.id AND rp.is_default AND rp.is_active
        WHERE rt.hotel_id = $1 AND rt.is_active
        ORDER BY rt.name`,
      [hotelId],
    )
  ).rows;
  const roomIds = rooms.map((r) => r.id);
  const plans = (
    await pool.query(
      `SELECT rp.id, rp.room_type_id, rp.name, rp.meal_plan, rp.is_default, rp.rate_mode, rp.derive_type, rp.derive_value,
              rp.follow_parent_restrictions, p.name AS parent_name
         FROM rate_plans rp LEFT JOIN rate_plans p ON p.id = rp.parent_rate_plan_id
        WHERE rp.room_type_id = ANY($1::uuid[]) AND rp.is_active
        ORDER BY rp.is_default DESC, rp.rate_mode, rp.name`,
      [roomIds],
    )
  ).rows;
  const rateIds = plans.map((p) => p.id);

  const [inv, rates, soldOffline, soldOnline] = await Promise.all([
    pool.query(
      `SELECT room_type_id, stay_date, allotment, held, available, stop_sell
         FROM daily_inventory WHERE room_type_id = ANY($1::uuid[]) AND stay_date BETWEEN $2 AND $3`,
      [roomIds, from, to],
    ),
    pool.query(
      `SELECT rate_plan_id, stay_date, price_minor, min_los, max_los, closed_to_arrival, closed_to_departure, stop_sell,
              min_stay_through, max_stay_through, min_advance_days, max_advance_days, extra_adult_minor, extra_child_minor
         FROM daily_rates WHERE rate_plan_id = ANY($1::uuid[]) AND stay_date BETWEEN $2 AND $3`,
      [rateIds, from, to],
    ),
    // A night counts as sold until the reservation released it (cancel/no-show/early out).
    pool.query(
      `SELECT r.room_type_id, d::date AS stay_date, sum(r.rooms)::int AS rooms
         FROM reservations r
         CROSS JOIN LATERAL generate_series(GREATEST(r.check_in, $2::date), LEAST(COALESCE(r.released_from, r.check_out), $3::date + 1) - 1, interval '1 day') d
        WHERE r.room_type_id = ANY($1::uuid[]) AND r.status IN ('CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT')
          AND r.check_out > $2 AND r.check_in <= $3
        GROUP BY 1, 2`,
      [roomIds, from, to],
    ),
    pool.query(
      `SELECT h.room_type_id, d::date AS stay_date, sum(h.rooms)::int AS rooms
         FROM inventory_holds h
         CROSS JOIN LATERAL generate_series(GREATEST(h.check_in, $2::date), LEAST(h.check_out, $3::date + 1) - 1, interval '1 day') d
        WHERE h.room_type_id = ANY($1::uuid[]) AND h.status = 'CONFIRMED' AND h.check_out > $2 AND h.check_in <= $3
        GROUP BY 1, 2`,
      [roomIds, from, to],
    ),
  ]);

  const key = (id: string, d: string) => `${id}|${d}`;
  const invMap = new Map(inv.rows.map((r) => [key(r.room_type_id, r.stay_date), r]));
  const rateMap = new Map(rates.rows.map((r) => [key(r.rate_plan_id, r.stay_date), r]));
  const offMap = new Map(soldOffline.rows.map((r) => [key(r.room_type_id, r.stay_date), r.rooms as number]));
  const onMap = new Map(soldOnline.rows.map((r) => [key(r.room_type_id, r.stay_date), r.rooms as number]));

  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  return {
    hotel: {
      id: hotel.id,
      name: hotel.name,
      source: hotel.inventory_source,
      editable: hotel.inventory_source === 'EXTRANET',
      managedBy: hotel.inventory_source === 'CHANNEL_MANAGER' ? hotel.partner_name : null,
      timezone: hotel.timezone,
      currency: hotel.currency.trim(),
    },
    from,
    to,
    dates,
    roomTypes: rooms.map((rt) => ({
      id: rt.id,
      name: rt.name,
      code: rt.code,
      maxOccupancy: rt.max_occupancy,
      ratePlan: rt.rate_plan_id ? { id: rt.rate_plan_id, name: rt.rate_plan_name, mealPlan: rt.meal_plan } : null,
      ratePlans: plans
        .filter((p) => p.room_type_id === rt.id)
        .map((p) => ({
          id: p.id,
          name: p.name,
          mealPlan: p.meal_plan,
          isDefault: p.is_default,
          rateMode: p.rate_mode,
          followParentRestrictions: p.follow_parent_restrictions,
          rule:
            p.rate_mode === 'DERIVED'
              ? `${p.parent_name} ${Number(p.derive_value) >= 0 ? '+' : ''}${p.derive_type === 'PERCENT' ? `${Number(p.derive_value) / 100}%` : (Number(p.derive_value) / 100).toFixed(0)}`
              : null,
          days: dates.map((d) => {
            const r = rateMap.get(key(p.id, d));
            return {
              date: d,
              priceMinor: r?.price_minor ?? null,
              stopSell: !!r?.stop_sell,
              minLos: r?.min_los ?? 1,
              maxLos: r?.max_los ?? null,
              minStayThrough: r?.min_stay_through ?? 1,
              maxStayThrough: r?.max_stay_through ?? null,
              minAdvanceDays: r?.min_advance_days ?? 0,
              maxAdvanceDays: r?.max_advance_days ?? null,
              closedToArrival: !!r?.closed_to_arrival,
              closedToDeparture: !!r?.closed_to_departure,
              extraAdultMinor: r?.extra_adult_minor ?? 0,
              extraChildMinor: r?.extra_child_minor ?? 0,
            };
          }),
        })),
      days: dates.map((d) => {
        const i = invMap.get(key(rt.id, d));
        const r = rt.rate_plan_id ? rateMap.get(key(rt.rate_plan_id, d)) : undefined;
        return {
          date: d,
          loaded: !!i,
          available: i?.available ?? 0,
          held: i?.held ?? 0,
          soldOffline: offMap.get(key(rt.id, d)) ?? 0,
          soldOnline: onMap.get(key(rt.id, d)) ?? 0,
          stopSell: !!(i?.stop_sell || r?.stop_sell),
          priceMinor: r?.price_minor ?? null,
          minLos: r?.min_los ?? 1,
          maxLos: r?.max_los ?? null,
          closedToArrival: !!r?.closed_to_arrival,
          closedToDeparture: !!r?.closed_to_departure,
        };
      }),
    })),
  };
}
