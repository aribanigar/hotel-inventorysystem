/**
 * Channex setup for the hotelier extranet: link a hotel to a Channex property, map
 * room types and rate plans, create missing ones in Channex, full sync, open Channex's
 * channel screen (where the hotel connects Booking.com, Expedia, Agoda, MakeMyTrip...),
 * and disconnect.
 *
 * Network calls to Channex are made OUTSIDE database transactions, so a slow Channex
 * never holds our row locks.
 */
import { z } from 'zod';
import { config } from '../../config.js';
import { pool, withTransaction } from '../../db/pool.js';
import { audit } from '../../extranet/audit.js';
import { addDays, todayIn } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { HttpCallError } from '../../lib/http.js';
import { queueChannexFullSync } from './ari.js';
import { pullChannexBookings } from './bookings.js';
import { channex, channexConfigured, channexListAll, describeChannexError } from './client.js';

const MEAL_TYPE: Record<string, string> = { EP: 'room_only', CP: 'breakfast', MAP: 'half_board', AP: 'full_board' };
const Uuid = z.uuid();

function parse<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const r = schema.safeParse(body);
  if (!r.success) throw new AppError('VALIDATION_ERROR', 'Please check the details', { issues: z.flattenError(r.error) });
  return r.data;
}

/** Turns a Channex failure into a clear message for the hotelier. */
function channexFailure(err: unknown, what: string): never {
  if (err instanceof AppError) throw err;
  if (err instanceof HttpCallError && err.status === 404) throw new AppError('NOT_FOUND', `${what}: not found in Channex`);
  throw new AppError('SUPPLIER_UNAVAILABLE', `${what}: ${describeChannexError(err)}`);
}

async function hotelRow(hotelId: string) {
  const h = (await pool.query('SELECT id, name, timezone, currency, inventory_source FROM hotels WHERE id = $1 AND is_active', [hotelId])).rows[0];
  if (!h) throw new AppError('NOT_FOUND', 'Hotel not found');
  if (h.inventory_source !== 'EXTRANET') throw new AppError('CONFLICT', "This hotel's rooms and rates are managed by another system");
  return { ...h, currency: String(h.currency).trim() } as { id: string; name: string; timezone: string; currency: string };
}

async function linkedProperty(hotelId: string): Promise<string> {
  const p = (await pool.query('SELECT channex_property_id FROM channex_properties WHERE hotel_id = $1', [hotelId])).rows[0];
  if (!p) throw new AppError('CONFLICT', 'This hotel is not connected to Channex yet');
  return p.channex_property_id;
}

/** Marks a whole horizon dirty for one room type / rate plan after its mapping changed. */
async function resetEntity(client: import('pg').PoolClient, hotelId: string, tz: string, roomTypeId: string | null, ratePlanId: string | null) {
  const today = todayIn(tz);
  if (roomTypeId && !ratePlanId) await client.query('DELETE FROM channex_sent_availability WHERE room_type_id = $1', [roomTypeId]);
  if (ratePlanId) await client.query('DELETE FROM channex_sent_restrictions WHERE rate_plan_id = $1', [ratePlanId]);
  await client.query(`INSERT INTO channex_dirty (hotel_id, room_type_id, rate_plan_id, date_from, date_to) VALUES ($1, $2, $3, $4, $5)`, [
    hotelId,
    roomTypeId,
    ratePlanId,
    today,
    addDays(today, config.CHANNEX_HORIZON_DAYS - 1),
  ]);
}

// ---------------------------------------------------------------------------
// Status (Channels tab)
// ---------------------------------------------------------------------------

export async function channexStatus(hotelId: string) {
  const p = (
    await pool.query(
      `SELECT p.*, (SELECT count(*) FROM channex_dirty d WHERE d.hotel_id = p.hotel_id) AS pending_changes
         FROM channex_properties p WHERE p.hotel_id = $1`,
      [hotelId],
    )
  ).rows[0];
  const rooms = (
    await pool.query(
      `SELECT rt.id, rt.name, rt.code, m.channex_room_type_id,
              COALESCE(json_agg(json_build_object('id', rp.id, 'name', rp.name, 'code', rp.code, 'rateMode', rp.rate_mode,
                       'channexRatePlanId', rm.channex_rate_plan_id) ORDER BY rp.is_default DESC, rp.name)
                       FILTER (WHERE rp.id IS NOT NULL), '[]') AS rate_plans
         FROM room_types rt
         LEFT JOIN channex_room_map m ON m.room_type_id = rt.id
         LEFT JOIN rate_plans rp ON rp.room_type_id = rt.id AND rp.is_active
         LEFT JOIN channex_rate_map rm ON rm.rate_plan_id = rp.id
        WHERE rt.hotel_id = $1 AND rt.is_active
        GROUP BY rt.id, m.channex_room_type_id ORDER BY rt.name`,
      [hotelId],
    )
  ).rows;
  const failed = (
    await pool.query(
      `SELECT revision_id, booking_id, status, ota_name, error, attempts, received_at FROM channex_booking_revisions
        WHERE hotel_id = $1 AND state = 'FAILED' ORDER BY received_at DESC LIMIT 20`,
      [hotelId],
    )
  ).rows;
  const recent = (
    await pool.query(
      `SELECT revision_id, status, ota_name, result, applied_at, acked_at FROM channex_booking_revisions
        WHERE hotel_id = $1 AND state = 'APPLIED' ORDER BY applied_at DESC LIMIT 10`,
      [hotelId],
    )
  ).rows;
  const unmappedRooms = rooms.filter((r) => !r.channex_room_type_id).length;
  const unmappedRates = rooms.reduce((n, r) => n + (r.rate_plans as Array<{ channexRatePlanId: string | null }>).filter((x) => !x.channexRatePlanId).length, 0);
  return {
    configured: channexConfigured(),
    server: new URL(config.CHANNEX_BASE_URL).host,
    connected: Boolean(p),
    propertyId: p?.channex_property_id ?? null,
    pushEnabled: p?.push_enabled ?? false,
    pendingChanges: Number(p?.pending_changes ?? 0),
    consecutiveFailures: p?.consecutive_failures ?? 0,
    nextPushAt: p?.next_push_at ?? null,
    lastPushAt: p?.last_push_at ?? null,
    lastPushError: p?.last_push_error ?? null,
    lastWarnings: p?.last_warnings ?? null,
    lastTaskIds: p?.last_task_ids ?? [],
    lastFullSyncAt: p?.last_full_sync_at ?? null,
    mapping: rooms.map((r) => ({ roomTypeId: r.id, name: r.name, code: r.code, channexRoomTypeId: r.channex_room_type_id, ratePlans: r.rate_plans })),
    unmapped: { rooms: unmappedRooms, ratePlans: unmappedRates },
    failedBookings: failed,
    recentBookings: recent,
  };
}

// ---------------------------------------------------------------------------
// Connect / disconnect
// ---------------------------------------------------------------------------

const ConnectBody = z.union([
  z.object({ mode: z.literal('create') }).strict(),
  z.object({ mode: z.literal('link'), propertyId: Uuid }).strict(),
]);

export async function connectChannex(hotelId: string, userId: string, body: unknown) {
  const b = parse(ConnectBody, body);
  const h = await hotelRow(hotelId);
  if (!channexConfigured()) throw new AppError('VALIDATION_ERROR', 'Channex is not set up on this server (CHANNEX_API_KEY is missing)');
  const existing = (await pool.query('SELECT channex_property_id FROM channex_properties WHERE hotel_id = $1', [hotelId])).rows[0];
  if (existing) throw new AppError('CONFLICT', 'This hotel is already connected to Channex');

  let propertyId: string;
  try {
    if (b.mode === 'create') {
      const res = await channex<{ id: string }>('POST', '/api/v1/properties', {
        property: { title: h.name, currency: h.currency, timezone: h.timezone, property_type: 'hotel', settings: { min_stay_type: 'both' } },
      });
      if (!res.data?.id) throw new AppError('SUPPLIER_UNAVAILABLE', 'Channex did not return a property id');
      propertyId = res.data.id;
    } else {
      const res = await channex<{ id: string; attributes: { currency?: string; title?: string } }>('GET', `/api/v1/properties/${b.propertyId}`);
      const cur = res.data?.attributes?.currency;
      if (cur && cur.toUpperCase() !== h.currency.toUpperCase()) {
        throw new AppError('VALIDATION_ERROR', `The Channex property is priced in ${cur}, this hotel in ${h.currency}. Use a property with the same currency.`);
      }
      propertyId = b.propertyId;
    }
  } catch (err) {
    channexFailure(err, 'Could not connect the Channex property');
  }

  await withTransaction(async (client) => {
    const taken = (await client.query('SELECT hotel_id FROM channex_properties WHERE channex_property_id = $1', [propertyId])).rows[0];
    if (taken) throw new AppError('CONFLICT', 'That Channex property is already linked to another hotel');
    await client.query('INSERT INTO channex_properties (hotel_id, channex_property_id, connected_by) VALUES ($1, $2, $3)', [hotelId, propertyId, userId]);
    await audit(client, { hotelId, userId, action: 'ARI_UPDATE', summary: `Connected to Channex (${b.mode === 'create' ? 'new' : 'existing'} property ${propertyId})` });
  });
  return { connected: true, propertyId };
}

export async function disconnectChannex(hotelId: string, userId: string) {
  return withTransaction(async (client) => {
    const r = await client.query('DELETE FROM channex_properties WHERE hotel_id = $1 RETURNING channex_property_id', [hotelId]);
    if (!r.rowCount) throw new AppError('NOT_FOUND', 'This hotel is not connected to Channex');
    await client.query('DELETE FROM channex_dirty WHERE hotel_id = $1', [hotelId]);
    await client.query('DELETE FROM channex_sent_availability WHERE room_type_id IN (SELECT room_type_id FROM channex_room_map WHERE hotel_id = $1)', [hotelId]);
    await client.query('DELETE FROM channex_sent_restrictions WHERE rate_plan_id IN (SELECT rate_plan_id FROM channex_rate_map WHERE hotel_id = $1)', [hotelId]);
    await client.query('DELETE FROM channex_rate_map WHERE hotel_id = $1', [hotelId]);
    await client.query('DELETE FROM channex_room_map WHERE hotel_id = $1', [hotelId]);
    await audit(client, { hotelId, userId, action: 'ARI_UPDATE', summary: 'Disconnected from Channex (OTA connections stay set up in Channex)' });
    return { disconnected: true };
  });
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

interface CxRoom {
  id: string;
  title: string;
}
interface CxRate {
  id: string;
  title: string;
  roomTypeId: string | null;
}

/** Room types and rate plans that exist in the Channex property (for the mapping screen). */
export async function channexCatalog(hotelId: string): Promise<{ roomTypes: CxRoom[]; ratePlans: CxRate[] }> {
  const propertyId = await linkedProperty(hotelId);
  try {
    const rooms = await channexListAll<{ title?: string }>('/api/v1/room_types', { 'filter[property_id]': propertyId });
    const rates = await channexListAll<{ title?: string; room_type_id?: string }>('/api/v1/rate_plans', { 'filter[property_id]': propertyId });
    return {
      roomTypes: rooms.map((r) => ({ id: r.id, title: r.attributes?.title ?? r.id })),
      ratePlans: rates.map((r) => {
        const rel = (r as unknown as { relationships?: { room_type?: { data?: { id?: string } } } }).relationships;
        return { id: r.id, title: r.attributes?.title ?? r.id, roomTypeId: r.attributes?.room_type_id ?? rel?.room_type?.data?.id ?? null };
      }),
    };
  } catch (err) {
    channexFailure(err, 'Could not read the Channex property');
  }
}

const MappingBody = z
  .object({
    rooms: z.array(z.object({ roomTypeId: Uuid, channexRoomTypeId: Uuid.nullable() }).strict()).max(200).default([]),
    ratePlans: z.array(z.object({ ratePlanId: Uuid, channexRatePlanId: Uuid.nullable() }).strict()).max(1000).default([]),
  })
  .strict();

export async function saveChannexMapping(hotelId: string, userId: string, body: unknown, catalogOverride?: { roomTypes: CxRoom[]; ratePlans: CxRate[] }) {
  const b = parse(MappingBody, body);
  const h = await hotelRow(hotelId);
  await linkedProperty(hotelId);
  const catalog = catalogOverride ?? (await channexCatalog(hotelId));
  const cxRooms = new Set(catalog.roomTypes.map((r) => r.id));
  const cxRates = new Map(catalog.ratePlans.map((r) => [r.id, r]));

  return withTransaction(async (client) => {
    let changed = 0;
    for (const m of b.rooms) {
      const ours = (await client.query('SELECT id FROM room_types WHERE id = $1 AND hotel_id = $2', [m.roomTypeId, hotelId])).rows[0];
      if (!ours) throw new AppError('VALIDATION_ERROR', 'Unknown room type');
      if (m.channexRoomTypeId && !cxRooms.has(m.channexRoomTypeId)) throw new AppError('VALIDATION_ERROR', 'That Channex room type is not in this property');
      const prev = (await client.query('SELECT channex_room_type_id FROM channex_room_map WHERE room_type_id = $1', [m.roomTypeId])).rows[0]?.channex_room_type_id ?? null;
      if (prev === m.channexRoomTypeId) continue;
      if (!m.channexRoomTypeId) await client.query('DELETE FROM channex_room_map WHERE room_type_id = $1', [m.roomTypeId]);
      else {
        const clash = (await client.query('SELECT room_type_id FROM channex_room_map WHERE hotel_id = $1 AND channex_room_type_id = $2 AND room_type_id <> $3', [hotelId, m.channexRoomTypeId, m.roomTypeId])).rowCount;
        if (clash) throw new AppError('VALIDATION_ERROR', 'Two room types cannot share one Channex room type');
        await client.query(
          `INSERT INTO channex_room_map (room_type_id, hotel_id, channex_room_type_id) VALUES ($1, $2, $3)
           ON CONFLICT (room_type_id) DO UPDATE SET channex_room_type_id = EXCLUDED.channex_room_type_id`,
          [m.roomTypeId, hotelId, m.channexRoomTypeId],
        );
        await resetEntity(client, hotelId, h.timezone, m.roomTypeId, null);
      }
      changed++;
    }
    for (const m of b.ratePlans) {
      const ours = (
        await client.query(
          `SELECT rp.id, rm.channex_room_type_id FROM rate_plans rp JOIN room_types rt ON rt.id = rp.room_type_id
             LEFT JOIN channex_room_map rm ON rm.room_type_id = rt.id WHERE rp.id = $1 AND rt.hotel_id = $2`,
          [m.ratePlanId, hotelId],
        )
      ).rows[0];
      if (!ours) throw new AppError('VALIDATION_ERROR', 'Unknown rate plan');
      if (m.channexRatePlanId) {
        const cx = cxRates.get(m.channexRatePlanId);
        if (!cx) throw new AppError('VALIDATION_ERROR', 'That Channex rate plan is not in this property');
        if (!ours.channex_room_type_id) throw new AppError('VALIDATION_ERROR', 'Map the room type before its rate plans');
        if (cx.roomTypeId && cx.roomTypeId !== ours.channex_room_type_id) throw new AppError('VALIDATION_ERROR', 'That Channex rate plan belongs to a different room type');
      }
      const prev = (await client.query('SELECT channex_rate_plan_id FROM channex_rate_map WHERE rate_plan_id = $1', [m.ratePlanId])).rows[0]?.channex_rate_plan_id ?? null;
      if (prev === m.channexRatePlanId) continue;
      if (!m.channexRatePlanId) await client.query('DELETE FROM channex_rate_map WHERE rate_plan_id = $1', [m.ratePlanId]);
      else {
        const clash = (await client.query('SELECT 1 FROM channex_rate_map WHERE hotel_id = $1 AND channex_rate_plan_id = $2 AND rate_plan_id <> $3', [hotelId, m.channexRatePlanId, m.ratePlanId])).rowCount;
        if (clash) throw new AppError('VALIDATION_ERROR', 'Two rate plans cannot share one Channex rate plan');
        await client.query(
          `INSERT INTO channex_rate_map (rate_plan_id, hotel_id, channex_rate_plan_id) VALUES ($1, $2, $3)
           ON CONFLICT (rate_plan_id) DO UPDATE SET channex_rate_plan_id = EXCLUDED.channex_rate_plan_id`,
          [m.ratePlanId, hotelId, m.channexRatePlanId],
        );
        await resetEntity(client, hotelId, h.timezone, null, m.ratePlanId);
      }
      changed++;
    }
    if (changed) await audit(client, { hotelId, userId, action: 'ARI_UPDATE', summary: `Channex mapping updated (${changed} change(s))` });
    return { changed };
  });
}

/**
 * Creates every unmapped room type and rate plan in Channex and maps it. Rate plans
 * are created as plain manual per-room plans: we always send the final nightly price
 * (derived plans are calculated here), so Channex never re-derives anything.
 */
export async function createMissingInChannex(hotelId: string, userId: string) {
  const h = await hotelRow(hotelId);
  const propertyId = await linkedProperty(hotelId);
  const today = todayIn(h.timezone);
  const rooms = (
    await pool.query(
      `SELECT rt.id, rt.name, rt.total_rooms, rt.max_adults, rt.max_children, rt.max_infants, rt.base_occupancy, m.channex_room_type_id
         FROM room_types rt LEFT JOIN channex_room_map m ON m.room_type_id = rt.id
        WHERE rt.hotel_id = $1 AND rt.is_active ORDER BY rt.name`,
      [hotelId],
    )
  ).rows;
  const created = { roomTypes: 0, ratePlans: 0 };
  try {
    for (const r of rooms) {
      let cxRoom = r.channex_room_type_id as string | null;
      if (!cxRoom) {
        const res = await channex<{ id: string }>('POST', '/api/v1/room_types', {
          room_type: {
            property_id: propertyId,
            title: r.name,
            count_of_rooms: Math.max(0, Number(r.total_rooms)),
            occ_adults: Math.max(1, Number(r.max_adults)),
            occ_children: Math.max(0, Number(r.max_children)),
            occ_infants: Math.max(0, Number(r.max_infants)),
            default_occupancy: Math.min(Number(r.base_occupancy), Number(r.max_adults)),
          },
        });
        cxRoom = res.data!.id;
        created.roomTypes++;
        // Map at once: if a later call fails, a retry won't create a duplicate.
        await mapCreated(hotelId, userId, r.id, cxRoom, null, null);
      }
      const plans = (
        await pool.query(
          `SELECT rp.id, rp.name, rp.meal_plan, (SELECT price_minor FROM daily_rates WHERE rate_plan_id = rp.id AND stay_date >= $2 AND price_minor IS NOT NULL ORDER BY stay_date LIMIT 1) AS price
             FROM rate_plans rp LEFT JOIN channex_rate_map m ON m.rate_plan_id = rp.id
            WHERE rp.room_type_id = $1 AND rp.is_active AND m.rate_plan_id IS NULL ORDER BY rp.is_default DESC, rp.name`,
          [r.id, today],
        )
      ).rows;
      for (const p of plans) {
        const option: Record<string, unknown> = { occupancy: Math.max(1, Number(r.max_adults)), is_primary: true };
        if (p.price) option.rate = Number(p.price);
        const res = await channex<{ id: string }>('POST', '/api/v1/rate_plans', {
          rate_plan: {
            property_id: propertyId,
            room_type_id: cxRoom,
            title: p.name,
            currency: h.currency,
            sell_mode: 'per_room',
            rate_mode: 'manual',
            meal_type: MEAL_TYPE[p.meal_plan] ?? 'room_only',
            options: [option],
          },
        });
        created.ratePlans++;
        await mapCreated(hotelId, userId, r.id, cxRoom, p.id, res.data!.id);
      }
    }
  } catch (err) {
    channexFailure(err, `Created ${created.roomTypes} room type(s) and ${created.ratePlans} rate plan(s), then Channex failed`);
  }
  return created;
}

/** Saves one mapping produced by createMissingInChannex (no catalog round trip needed). */
async function mapCreated(hotelId: string, userId: string, roomTypeId: string, cxRoom: string, ratePlanId: string | null, cxRate: string | null) {
  await saveChannexMapping(
    hotelId,
    userId,
    { rooms: [{ roomTypeId, channexRoomTypeId: cxRoom }], ratePlans: ratePlanId ? [{ ratePlanId, channexRatePlanId: cxRate }] : [] },
    { roomTypes: [{ id: cxRoom, title: '' }], ratePlans: cxRate ? [{ id: cxRate, title: '', roomTypeId: cxRoom }] : [] },
  );
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Go-live / recovery: resend 500 days of availability, rates and restrictions (2 calls). */
export async function channexFullSync(hotelId: string, userId: string) {
  return withTransaction(async (client) => {
    if (!(await queueChannexFullSync(client, hotelId))) throw new AppError('CONFLICT', 'This hotel is not connected to Channex yet');
    await audit(client, { hotelId, userId, action: 'ARI_UPDATE', summary: `Channex full sync queued (${config.CHANNEX_HORIZON_DAYS} days)` });
    return { queued: true, days: config.CHANNEX_HORIZON_DAYS };
  });
}

/**
 * One-time link to Channex's channel screen for this property, where the hotel
 * connects and maps Booking.com, Expedia, Agoda, MakeMyTrip/Goibibo, Airbnb and the
 * rest. The token lives 15 minutes and works once.
 */
export async function channexChannelsUrl(hotelId: string, userName: string) {
  const propertyId = await linkedProperty(hotelId);
  try {
    const res = await channex<{ token: string }>('POST', '/api/v1/auth/one_time_token', {
      one_time_token: { property_id: propertyId, username: userName.slice(0, 120) },
    });
    const token = res.data?.token;
    if (!token) throw new AppError('SUPPLIER_UNAVAILABLE', 'Channex did not return an access token');
    const url = new URL('/auth/exchange', config.CHANNEX_BASE_URL);
    url.search = new URLSearchParams({ oauth_session_key: token, app_mode: 'headless', redirect_to: '/channels', property_id: propertyId }).toString();
    return { url: url.toString(), expiresInMinutes: 15 };
  } catch (err) {
    channexFailure(err, 'Could not open the Channex channel screen');
  }
}

/** Re-tries bookings that could not be applied (after fixing the mapping). */
export async function retryChannexBookings(hotelId: string) {
  await linkedProperty(hotelId);
  const applied = await pullChannexBookings();
  const stillFailed = (await pool.query(`SELECT count(*)::int AS n FROM channex_booking_revisions WHERE hotel_id = $1 AND state = 'FAILED'`, [hotelId])).rows[0].n;
  return { applied, stillFailed };
}
