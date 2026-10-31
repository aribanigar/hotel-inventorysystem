/**
 * Property setup and operations for the hotelier extranet:
 * room types, rate plans (manual + derived), settings, the rolling inventory horizon,
 * availability reset, full channel sync, channel health and CSV export.
 */
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, withTransaction } from '../db/pool.js';
import { rederiveChildren } from '../inventory/ariUpdates.js';
import { sha256Hex } from '../lib/crypto.js';
import { addDays, todayIn } from '../lib/dates.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { queueChannexFullSync } from '../channels/channex/ari.js';
import { enqueueForSubscribers } from '../outbox/outbox.js';
import { audit } from './audit.js';

const MEAL = z.enum(['EP', 'CP', 'MAP', 'AP']);

async function extranetHotel(client: PoolClient, hotelId: string) {
  const { rows } = await client.query(
    'SELECT id, timezone, currency, inventory_source, open_horizon_days FROM hotels WHERE id = $1 AND is_active FOR UPDATE',
    [hotelId],
  );
  const h = rows[0];
  if (!h) throw new AppError('NOT_FOUND', 'Hotel not found');
  if (h.inventory_source !== 'EXTRANET') {
    throw new AppError('CONFLICT', "This hotel's rooms and rates are managed by its channel manager or supplier");
  }
  return { ...h, currency: (h.currency as string).trim(), today: todayIn(h.timezone) } as {
    id: string; timezone: string; currency: string; open_horizon_days: number; today: string;
  };
}

// ---------------------------------------------------------------------------
// Read model for the Setup screen
// ---------------------------------------------------------------------------
export async function getSetup(hotelId: string) {
  const hotel = (
    await pool.query(
      `SELECT h.id, h.name, h.inventory_source, h.timezone, h.currency, h.open_horizon_days, h.pms_id, h.cm_account_id,
              a.name AS cm_name, a.last_push_at, a.last_push_error, a.push_enabled, a.client_id IS NOT NULL AS cm_has_credentials
         FROM hotels h LEFT JOIN cm_accounts a ON a.id = h.cm_account_id WHERE h.id = $1`,
      [hotelId],
    )
  ).rows[0];
  if (!hotel) throw new AppError('NOT_FOUND', 'Hotel not found');
  const rooms = (
    await pool.query(
      `SELECT id, pms_id, code, name, total_rooms, base_occupancy, max_adults, max_children, max_infants, max_occupancy, is_active
         FROM room_types WHERE hotel_id = $1 ORDER BY is_active DESC, name`,
      [hotelId],
    )
  ).rows;
  const plans = (
    await pool.query(
      `SELECT rp.id, rp.pms_id, rp.room_type_id, rp.code, rp.name, rp.meal_plan, rp.is_default, rp.is_active, rp.rate_mode,
              rp.parent_rate_plan_id, rp.derive_type, rp.derive_value, rp.follow_parent_restrictions, p.name AS parent_name
         FROM rate_plans rp JOIN room_types rt ON rt.id = rp.room_type_id
         LEFT JOIN rate_plans p ON p.id = rp.parent_rate_plan_id
        WHERE rt.hotel_id = $1 ORDER BY rp.is_default DESC, rp.name`,
      [hotelId],
    )
  ).rows;
  return {
    hotel: {
      id: hotel.id,
      name: hotel.name,
      source: hotel.inventory_source,
      timezone: hotel.timezone,
      currency: hotel.currency.trim(),
      openHorizonDays: hotel.open_horizon_days,
      pmsId: hotel.pms_id,
    },
    channelManager: hotel.cm_account_id
      ? { name: hotel.cm_name, lastPushAt: hotel.last_push_at, lastPushError: hotel.last_push_error, pushEnabled: hotel.push_enabled, hasCredentials: hotel.cm_has_credentials }
      : null,
    roomTypes: rooms.map((r) => ({
      id: r.id,
      pmsId: r.pms_id,
      code: r.code,
      name: r.name,
      totalRooms: r.total_rooms,
      baseOccupancy: r.base_occupancy,
      maxAdults: r.max_adults,
      maxChildren: r.max_children,
      maxInfants: r.max_infants,
      isActive: r.is_active,
      ratePlans: plans
        .filter((p) => p.room_type_id === r.id)
        .map((p) => ({
          id: p.id,
          pmsId: p.pms_id,
          code: p.code,
          name: p.name,
          mealPlan: p.meal_plan,
          isDefault: p.is_default,
          isActive: p.is_active,
          rateMode: p.rate_mode,
          parentRatePlanId: p.parent_rate_plan_id,
          parentName: p.parent_name,
          deriveType: p.derive_type,
          // Percent in % (e.g. -10.5), amount in minor units.
          deriveValue: p.derive_value === null ? null : p.derive_type === 'PERCENT' ? Number(p.derive_value) / 100 : Number(p.derive_value),
          followParentRestrictions: p.follow_parent_restrictions,
        })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Room types
// ---------------------------------------------------------------------------
const RoomTypeBody = z
  .object({
    name: z.string().trim().min(2).max(80),
    totalRooms: z.number().int().min(0).max(1000),
    baseOccupancy: z.number().int().min(1).max(20),
    maxAdults: z.number().int().min(1).max(20),
    maxChildren: z.number().int().min(0).max(20),
    maxInfants: z.number().int().min(0).max(20),
    isActive: z.boolean().optional(),
    // Create only: first rate plan and its starting price.
    ratePlanName: z.string().trim().min(2).max(80).optional(),
    mealPlan: MEAL.optional(),
    priceMinor: z.number().int().positive().max(100_000_000_00).optional(),
  })
  .strict()
  .refine((b) => b.baseOccupancy <= b.maxAdults + b.maxChildren, { message: 'Base occupancy cannot exceed max guests', path: ['baseOccupancy'] });

export async function createRoomType(hotelId: string, userId: string, body: unknown) {
  const b = parse(RoomTypeBody, body);
  return withTransaction(async (client) => {
    const h = await extranetHotel(client, hotelId);
    const code = b.name.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 8) + '-' + randomBytes(2).toString('hex').toUpperCase();
    const rt = (
      await client.query(
        `INSERT INTO room_types (hotel_id, code, name, total_rooms, base_occupancy, max_adults, max_children, max_infants, max_occupancy)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [hotelId, code, b.name, b.totalRooms, b.baseOccupancy, b.maxAdults, b.maxChildren, b.maxInfants, b.maxAdults + b.maxChildren],
      )
    ).rows[0];
    const rp = (
      await client.query(
        `INSERT INTO rate_plans (room_type_id, code, name, meal_plan, is_default) VALUES ($1, $2, $3, $4, true) RETURNING id`,
        [rt.id, b.mealPlan ?? 'EP', b.ratePlanName ?? 'Standard rate', b.mealPlan ?? 'EP'],
      )
    ).rows[0];

    // Open for sale right away across the hotel's horizon.
    const days = h.open_horizon_days || 365;
    const end = addDays(h.today, days - 1);
    await client.query(
      `INSERT INTO daily_inventory (room_type_id, stay_date, allotment)
       SELECT $1, d::date, $4 FROM generate_series($2::date, $3::date, interval '1 day') d`,
      [rt.id, h.today, end, b.totalRooms],
    );
    if (b.priceMinor) {
      await client.query(
        `INSERT INTO daily_rates (rate_plan_id, stay_date, price_minor, currency)
         SELECT $1, d::date, $4, $5 FROM generate_series($2::date, $3::date, interval '1 day') d`,
        [rp.id, h.today, end, b.priceMinor, h.currency],
      );
    }
    await audit(client, { hotelId, userId, action: 'ARI_UPDATE', summary: `Created room type ${b.name} (${b.totalRooms} rooms), open for ${days} days`, details: { roomTypeId: rt.id } });
    await enqueueForSubscribers(client, hotelId, 'ARI_CHANGED', { changes: [{ roomTypeId: rt.id, ratePlanId: rp.id, from: h.today, to: end }], cause: 'room_type_created' });
    return { id: rt.id, ratePlanId: rp.id };
  });
}

export async function updateRoomType(hotelId: string, userId: string, roomTypeId: string, body: unknown) {
  const b = parse(RoomTypeBody, body);
  return withTransaction(async (client) => {
    const h = await extranetHotel(client, hotelId);
    const cur = (await client.query('SELECT * FROM room_types WHERE id = $1 AND hotel_id = $2 FOR UPDATE', [roomTypeId, hotelId])).rows[0];
    if (!cur) throw new AppError('NOT_FOUND', 'Room type not found');
    await client.query(
      `UPDATE room_types SET name = $2, total_rooms = $3, base_occupancy = $4, max_adults = $5, max_children = $6, max_infants = $7,
              max_occupancy = $8, is_active = COALESCE($9, is_active) WHERE id = $1`,
      [roomTypeId, b.name, b.totalRooms, b.baseOccupancy, b.maxAdults, b.maxChildren, b.maxInfants, b.maxAdults + b.maxChildren, b.isActive ?? null],
    );
    // Rooms added or removed physically: shift every future night by the difference.
    // Allotment is "rooms left to sell", so sold rooms stay sold.
    const delta = b.totalRooms - cur.total_rooms;
    if (delta !== 0) {
      await client.query(
        `UPDATE daily_inventory SET allotment = GREATEST(allotment + $3, 0), updated_at = now()
          WHERE room_type_id = $1 AND stay_date >= $2`,
        [roomTypeId, h.today, delta],
      );
      await enqueueForSubscribers(client, hotelId, 'ARI_CHANGED', {
        changes: [{ roomTypeId, ratePlanId: null, from: h.today, to: addDays(h.today, (h.open_horizon_days || 365) - 1) }],
        cause: 'total_rooms_changed',
      });
    }
    await audit(client, {
      hotelId,
      userId,
      action: 'ARI_UPDATE',
      summary: `Updated room type ${b.name}${delta ? `: total rooms ${cur.total_rooms} to ${b.totalRooms} (future nights ${delta > 0 ? '+' : ''}${delta})` : ''}`,
      details: { roomTypeId, before: { totalRooms: cur.total_rooms, name: cur.name }, after: b },
    });
    return { ok: true, shiftedBy: delta };
  });
}

// ---------------------------------------------------------------------------
// Rate plans
// ---------------------------------------------------------------------------
const RatePlanBody = z
  .object({
    roomTypeId: z.uuid(),
    name: z.string().trim().min(2).max(80),
    mealPlan: MEAL,
    rateMode: z.enum(['MANUAL', 'DERIVED']),
    parentRatePlanId: z.uuid().optional(),
    deriveType: z.enum(['PERCENT', 'AMOUNT']).optional(),
    /** PERCENT: -90 to +500 (%); AMOUNT: minor units, may be negative. */
    deriveValue: z.number().optional(),
    followParentRestrictions: z.boolean().default(true),
    isDefault: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.rateMode === 'DERIVED') {
      if (!b.parentRatePlanId) ctx.addIssue({ code: 'custom', path: ['parentRatePlanId'], message: 'Choose the plan to follow' });
      if (!b.deriveType || b.deriveValue === undefined) ctx.addIssue({ code: 'custom', path: ['deriveValue'], message: 'Set the adjustment' });
      if (b.deriveType === 'PERCENT' && b.deriveValue !== undefined && (b.deriveValue < -90 || b.deriveValue > 500)) {
        ctx.addIssue({ code: 'custom', path: ['deriveValue'], message: 'Percent must be between -90 and +500' });
      }
      if (b.deriveType === 'AMOUNT' && b.deriveValue !== undefined && (!Number.isInteger(b.deriveValue) || Math.abs(b.deriveValue) > 100_000_00)) {
        ctx.addIssue({ code: 'custom', path: ['deriveValue'], message: 'Amount out of range' });
      }
    }
  });

export async function saveRatePlan(hotelId: string, userId: string, ratePlanId: string | null, body: unknown) {
  const b = parse(RatePlanBody, body);
  return withTransaction(async (client) => {
    const h = await extranetHotel(client, hotelId);
    const rt = (await client.query('SELECT id, name FROM room_types WHERE id = $1 AND hotel_id = $2', [b.roomTypeId, hotelId])).rows[0];
    if (!rt) throw new AppError('NOT_FOUND', 'Room type not found');

    let parent: { id: string; rate_mode: string } | undefined;
    if (b.rateMode === 'DERIVED') {
      parent = (
        await client.query(
          `SELECT rp.id, rp.rate_mode FROM rate_plans rp JOIN room_types r ON r.id = rp.room_type_id WHERE rp.id = $1 AND r.hotel_id = $2`,
          [b.parentRatePlanId, hotelId],
        )
      ).rows[0];
      if (!parent) throw new AppError('VALIDATION_ERROR', 'Parent rate plan not found in this hotel');
      if (parent.rate_mode !== 'MANUAL') throw new AppError('VALIDATION_ERROR', 'A derived plan must follow a manual plan (no chains)');
      if (ratePlanId && parent.id === ratePlanId) throw new AppError('VALIDATION_ERROR', 'A plan cannot follow itself');
    }
    if (ratePlanId && b.rateMode === 'DERIVED') {
      const kids = await client.query('SELECT 1 FROM rate_plans WHERE parent_rate_plan_id = $1 LIMIT 1', [ratePlanId]);
      if (kids.rowCount) throw new AppError('VALIDATION_ERROR', 'Other plans follow this one, so it must stay manual');
    }
    const deriveValue = b.rateMode === 'DERIVED' ? (b.deriveType === 'PERCENT' ? Math.round(b.deriveValue! * 100) : Math.round(b.deriveValue!)) : null;

    if (b.isDefault) await client.query('UPDATE rate_plans SET is_default = false WHERE room_type_id = $1 AND is_default', [b.roomTypeId]);
    let id = ratePlanId;
    if (!id) {
      id = (
        await client.query(
          `INSERT INTO rate_plans (room_type_id, code, name, meal_plan, is_default, rate_mode, parent_rate_plan_id, derive_type, derive_value, follow_parent_restrictions)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [b.roomTypeId, `${b.mealPlan}-${randomBytes(2).toString('hex').toUpperCase()}`, b.name, b.mealPlan, b.isDefault ?? false, b.rateMode,
            parent?.id ?? null, b.rateMode === 'DERIVED' ? b.deriveType : null, deriveValue, b.followParentRestrictions],
        )
      ).rows[0].id;
    } else {
      const upd = await client.query(
        `UPDATE rate_plans rp SET name = $2, meal_plan = $3, is_default = COALESCE($4, rp.is_default), rate_mode = $5, parent_rate_plan_id = $6,
                derive_type = $7, derive_value = $8, follow_parent_restrictions = $9, is_active = COALESCE($10, rp.is_active)
          FROM room_types rt WHERE rp.id = $1 AND rt.id = rp.room_type_id AND rt.hotel_id = $11`,
        [id, b.name, b.mealPlan, b.isDefault ?? null, b.rateMode, parent?.id ?? null, b.rateMode === 'DERIVED' ? b.deriveType : null, deriveValue,
          b.followParentRestrictions, b.isActive ?? null, hotelId],
      );
      if (!upd.rowCount) throw new AppError('NOT_FOUND', 'Rate plan not found');
    }

    // Derived: compute every future price now, so checkout reads stored values.
    if (b.rateMode === 'DERIVED') {
      await rederiveChildren(client, parent!.id, h.today, addDays(h.today, 749), id!);
      await enqueueForSubscribers(client, hotelId, 'ARI_CHANGED', {
        changes: [{ roomTypeId: b.roomTypeId, ratePlanId: id, from: h.today, to: addDays(h.today, (h.open_horizon_days || 365) - 1) }],
        cause: 'rate_plan_rule',
      });
    }
    const rule = b.rateMode === 'DERIVED' ? ` follows parent ${b.deriveValue! >= 0 ? '+' : ''}${b.deriveType === 'PERCENT' ? `${b.deriveValue}%` : (b.deriveValue! / 100).toFixed(2)}` : '';
    await audit(client, { hotelId, userId, action: 'ARI_UPDATE', summary: `${ratePlanId ? 'Updated' : 'Created'} rate plan ${b.name} for ${rt.name}${rule}`, details: { ratePlanId: id } });
    return { id };
  });
}

// ---------------------------------------------------------------------------
// Settings, rolling horizon, reset, full sync
// ---------------------------------------------------------------------------
const SettingsBody = z.object({ openHorizonDays: z.number().int().min(0).max(730) }).strict();

export async function updateSettings(hotelId: string, userId: string, body: unknown) {
  const b = parse(SettingsBody, body);
  await withTransaction(async (client) => {
    await extranetHotel(client, hotelId);
    await client.query('UPDATE hotels SET open_horizon_days = $2 WHERE id = $1', [hotelId, b.openHorizonDays]);
    await audit(client, { hotelId, userId, action: 'ARI_UPDATE', summary: `Inventory horizon set to ${b.openHorizonDays || 'off'}${b.openHorizonDays ? ' days' : ''}` });
  });
  if (b.openHorizonDays) await rollHorizon(hotelId);
  return { ok: true };
}

/**
 * Keeps every extranet hotel open for sale `open_horizon_days` ahead. New nights get
 * the room type's total rooms; manual rate plans carry forward their latest price and
 * restrictions; derived plans are recalculated. Existing nights are never touched.
 * Runs hourly from the jobs loop (cheap: only inserts missing rows).
 */
export async function rollHorizon(onlyHotelId?: string): Promise<number> {
  const hotels = (
    await pool.query(
      `SELECT id, timezone, open_horizon_days FROM hotels
        WHERE inventory_source = 'EXTRANET' AND is_active AND open_horizon_days > 0 AND ($1::uuid IS NULL OR id = $1)`,
      [onlyHotelId ?? null],
    )
  ).rows;
  let added = 0;
  for (const h of hotels) {
    try {
      added += await withTransaction(async (client) => {
        const today = todayIn(h.timezone);
        const end = addDays(today, h.open_horizon_days - 1);
        const inv = await client.query(
          `INSERT INTO daily_inventory (room_type_id, stay_date, allotment)
           SELECT rt.id, d::date, rt.total_rooms
             FROM room_types rt CROSS JOIN generate_series($2::date, $3::date, interval '1 day') d
            WHERE rt.hotel_id = $1 AND rt.is_active AND rt.total_rooms > 0
           ON CONFLICT DO NOTHING`,
          [h.id, today, end],
        );
        // Carry the latest known rate forward for manual plans.
        const rates = await client.query(
          `INSERT INTO daily_rates (rate_plan_id, stay_date, price_minor, currency, min_los, max_los, closed_to_arrival, closed_to_departure,
                                   stop_sell, min_stay_through, max_stay_through, min_advance_days, max_advance_days, extra_adult_minor, extra_child_minor)
           SELECT last.rate_plan_id, d::date, last.price_minor, last.currency, last.min_los, last.max_los, false, false,
                  false, last.min_stay_through, last.max_stay_through, last.min_advance_days, last.max_advance_days,
                  last.extra_adult_minor, last.extra_child_minor
             FROM (
               SELECT DISTINCT ON (dr.rate_plan_id) dr.*
                 FROM daily_rates dr JOIN rate_plans rp ON rp.id = dr.rate_plan_id JOIN room_types rt ON rt.id = rp.room_type_id
                WHERE rt.hotel_id = $1 AND rp.rate_mode = 'MANUAL' AND rp.is_active AND dr.price_minor IS NOT NULL
                ORDER BY dr.rate_plan_id, dr.stay_date DESC
             ) last
             CROSS JOIN generate_series(GREATEST($2::date, last.stay_date + 1), $3::date, interval '1 day') d
           ON CONFLICT DO NOTHING
           RETURNING rate_plan_id`,
          [h.id, today, end],
        );
        const parents = [...new Set(rates.rows.map((r) => r.rate_plan_id as string))];
        for (const p of parents) await rederiveChildren(client, p, today, end);
        const n = (inv.rowCount ?? 0) + (rates.rowCount ?? 0);
        if (n > 0) {
          await enqueueForSubscribers(client, h.id, 'ARI_CHANGED', { changes: [{ roomTypeId: null, ratePlanId: null, from: today, to: end }], cause: 'horizon_roll' });
        }
        return n;
      });
    } catch (err) {
      logger.error({ err, hotelId: h.id }, 'horizon roll failed');
    }
  }
  return added;
}

/**
 * Repair tool (like the CM's "Reset availability"): recompute rooms-left for every
 * future night from first principles:
 *     total rooms - offline/OTA reservations - paid website bookings
 * Holds in progress stay as they are. Use after data was edited by hand or a sync drifted.
 */
export async function resetAvailability(hotelId: string, userId: string, roomTypeId?: string) {
  return withTransaction(async (client) => {
    const h = await extranetHotel(client, hotelId);
    const r = await client.query(
      `WITH sold AS (
         SELECT rt.id AS room_type_id, d::date AS stay_date,
                COALESCE((SELECT sum(r.rooms) FROM reservations r
                           WHERE r.room_type_id = rt.id AND r.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT')
                             AND d::date >= r.check_in AND d::date < COALESCE(r.released_from, r.check_out)), 0)
              + COALESCE((SELECT sum(x.rooms) FROM inventory_holds x
                           WHERE x.room_type_id = rt.id AND x.status = 'CONFIRMED' AND d::date >= x.check_in AND d::date < x.check_out), 0) AS rooms,
                rt.total_rooms
           FROM room_types rt
           CROSS JOIN LATERAL generate_series($2::date, (SELECT max(stay_date) FROM daily_inventory WHERE room_type_id = rt.id), interval '1 day') d
          WHERE rt.hotel_id = $1 AND ($3::uuid IS NULL OR rt.id = $3)
       )
       UPDATE daily_inventory di SET allotment = GREATEST(s.total_rooms - s.rooms, 0), updated_at = now()
         FROM sold s
        WHERE di.room_type_id = s.room_type_id AND di.stay_date = s.stay_date AND di.allotment <> GREATEST(s.total_rooms - s.rooms, 0)
       RETURNING di.room_type_id`,
      [hotelId, h.today, roomTypeId ?? null],
    );
    const fixed = r.rowCount ?? 0;
    await audit(client, { hotelId, userId, action: 'ARI_UPDATE', summary: `Reset availability from total rooms and bookings: ${fixed} night(s) corrected` });
    if (fixed) {
      await enqueueForSubscribers(client, hotelId, 'ARI_CHANGED', {
        changes: [{ roomTypeId: roomTypeId ?? null, ratePlanId: null, from: h.today, to: addDays(h.today, (h.open_horizon_days || 365) - 1) }],
        cause: 'availability_reset',
      });
    }
    return { nightsCorrected: fixed };
  });
}

/** Queues a full snapshot of the next 365 days to every connected channel. */
export async function fullSync(hotelId: string, userId: string) {
  return withTransaction(async (client) => {
    const h = (await client.query('SELECT timezone FROM hotels WHERE id = $1', [hotelId])).rows[0];
    if (!h) throw new AppError('NOT_FOUND', 'Hotel not found');
    const today = todayIn(h.timezone);
    const plans = (
      await client.query(
        `SELECT rt.id AS room_type_id, rp.id AS rate_plan_id FROM room_types rt LEFT JOIN rate_plans rp ON rp.room_type_id = rt.id AND rp.is_active
          WHERE rt.hotel_id = $1 AND rt.is_active`,
        [hotelId],
      )
    ).rows;
    const to = addDays(today, 364);
    const queued = await enqueueForSubscribers(client, hotelId, 'ARI_CHANGED', {
      changes: plans.map((p) => ({ roomTypeId: p.room_type_id, ratePlanId: p.rate_plan_id, from: today, to })),
      cause: 'full_sync',
    });
    // Channex: resend the whole horizon, not only nights that differ from the last push.
    await queueChannexFullSync(client, hotelId);
    await audit(client, { hotelId, userId, action: 'ARI_UPDATE', summary: `Full sync queued to ${queued} channel(s), ${today} to ${to}` });
    return { channelsQueued: queued };
  });
}

// ---------------------------------------------------------------------------
// Channels: health, retry, QloApps CM connection
// ---------------------------------------------------------------------------
export async function channelHealth(hotelId: string) {
  const subs = (
    await pool.query(
      `SELECT s.id, s.channel_code, s.endpoint_url, s.is_active, s.event_types,
              count(o.*) FILTER (WHERE o.status IN ('PENDING','IN_FLIGHT')) AS pending,
              count(o.*) FILTER (WHERE o.status = 'DEAD') AS failed,
              max(o.processed_at) FILTER (WHERE o.status = 'DONE') AS last_success_at,
              (SELECT last_error FROM ari_outbox WHERE subscription_id = s.id AND last_error IS NOT NULL ORDER BY id DESC LIMIT 1) AS last_error
         FROM channel_subscriptions s LEFT JOIN ari_outbox o ON o.subscription_id = s.id
        WHERE s.hotel_id = $1 GROUP BY s.id ORDER BY s.channel_code`,
      [hotelId],
    )
  ).rows;
  const cm = (
    await pool.query(
      `SELECT a.name, a.last_push_at, a.last_push_error, a.push_enabled, a.client_id IS NOT NULL AS has_credentials,
              (SELECT count(*) FROM ari_outbox o WHERE o.hotel_id = $1 AND o.event_type = 'QLO_ARI_PUSH' AND o.status IN ('PENDING','IN_FLIGHT')) AS pending,
              (SELECT count(*) FROM ari_outbox o WHERE o.hotel_id = $1 AND o.event_type = 'QLO_ARI_PUSH' AND o.status = 'DEAD') AS failed
         FROM hotels h JOIN cm_accounts a ON a.id = h.cm_account_id WHERE h.id = $1`,
      [hotelId],
    )
  ).rows[0];
  const host = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  };
  return {
    channels: subs.map((s) => ({
      id: s.id,
      code: s.channel_code,
      endpointHost: host(s.endpoint_url),
      active: s.is_active,
      events: s.event_types,
      pending: Number(s.pending),
      failed: Number(s.failed),
      lastSuccessAt: s.last_success_at,
      lastError: s.last_error,
    })),
    qloappsChannelManager: cm
      ? {
          name: cm.name,
          lastPushAt: cm.last_push_at,
          lastPushError: cm.last_push_error,
          pushEnabled: cm.push_enabled,
          hasCredentials: cm.has_credentials,
          pending: Number(cm.pending),
          failed: Number(cm.failed),
        }
      : null,
  };
}

/** Puts dead-lettered deliveries for this hotel back in the queue. */
export async function retryFailed(hotelId: string, userId: string) {
  return withTransaction(async (client) => {
    const r = await client.query(
      `UPDATE ari_outbox SET status = 'PENDING', attempts = 0, next_attempt_at = now(), last_error = NULL
        WHERE hotel_id = $1 AND status = 'DEAD'`,
      [hotelId],
    );
    await audit(client, { hotelId, userId, action: 'ARI_UPDATE', summary: `Retried ${r.rowCount ?? 0} failed channel update(s)` });
    return { retried: r.rowCount ?? 0 };
  });
}

const CmConnectBody = z
  .object({
    clientId: z.string().trim().min(4).max(200),
    clientSecret: z.string().trim().min(8).max(500),
    baseUrl: z.url().refine((u) => u.startsWith('https://') || u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost'), 'must be https').optional(),
  })
  .strict();

/**
 * Links this hotel to the owner's QloApps Channel Manager account (one account per
 * owner, shared by their hotels). A new account gets a webservice key, shown ONCE, that
 * the owner pastes into the CM under PMS > General Settings.
 */
export async function connectQloCm(hotelId: string, userId: string, body: unknown) {
  const b = parse(CmConnectBody, body);
  return withTransaction(async (client) => {
    await extranetHotel(client, hotelId);
    let account = (await client.query('SELECT id FROM cm_accounts WHERE owner_user_id = $1 FOR UPDATE', [userId])).rows[0];
    let wsKey: string | null = null;
    if (!account) {
      wsKey = randomBytes(24).toString('hex').toUpperCase().slice(0, 32);
      account = (
        await client.query(
          `INSERT INTO cm_accounts (name, ws_key_hash, client_id, client_secret, owner_user_id, base_url)
           VALUES ('QloApps Channel Manager', $1, $2, $3, $4, COALESCE($5, 'https://channels.qloapps.com')) RETURNING id`,
          [sha256Hex(wsKey), b.clientId, b.clientSecret, userId, b.baseUrl ?? null],
        )
      ).rows[0];
    } else {
      await client.query(
        `UPDATE cm_accounts SET client_id = $2, client_secret = $3, access_token = NULL, base_url = COALESCE($4, base_url) WHERE id = $1`,
        [account.id, b.clientId, b.clientSecret, b.baseUrl ?? null],
      );
    }
    await client.query('UPDATE hotels SET cm_account_id = $2 WHERE id = $1', [hotelId, account.id]);
    await audit(client, { hotelId, userId, action: 'ARI_UPDATE', summary: 'Connected to QloApps Channel Manager' });
    return { connected: true, webserviceKey: wsKey };
  });
}

export async function disconnectQloCm(hotelId: string, userId: string) {
  return withTransaction(async (client) => {
    await client.query('UPDATE hotels SET cm_account_id = NULL WHERE id = $1', [hotelId]);
    await audit(client, { hotelId, userId, action: 'ARI_UPDATE', summary: 'Disconnected from QloApps Channel Manager' });
    return { connected: false };
  });
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------
export function toCsv(rows: Array<Record<string, unknown>>, columns: Array<[string, string]>): string {
  const esc = (v: unknown) => {
    let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
    // Neutralise spreadsheet formula injection (=, +, -, @ at the start of a cell).
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(([, label]) => esc(label)).join(','), ...rows.map((r) => columns.map(([k]) => esc(r[k])).join(','))].join('\r\n') + '\r\n';
}

function parse<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const r = schema.safeParse(body);
  if (!r.success) throw new AppError('VALIDATION_ERROR', 'Please check the details', { issues: z.flattenError(r.error) });
  return r.data;
}
