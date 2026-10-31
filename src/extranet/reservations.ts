/**
 * Offline reservations: a room sold at the front desk, by phone, on WhatsApp or by a
 * travel agent. Recorded as a real reservation and taken out of inventory under the
 * same row locks the online checkout uses, so an offline sale and an online buyer can
 * never both get the last room. The change reaches every subscribed channel through
 * the outbox, in the same transaction.
 */
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, withTransaction } from '../db/pool.js';
import { addDays, daysBetween, isIsoDate, MAX_NIGHTS, stayNights, todayIn } from '../lib/dates.js';
import { AppError } from '../lib/errors.js';
import { enqueueForSubscribers } from '../outbox/outbox.js';
import { audit } from './audit.js';

export const RESERVATION_SOURCES = ['WALK_IN', 'PHONE', 'WHATSAPP', 'TRAVEL_AGENT', 'OTHER_OTA', 'OTHER'] as const;
export type ReservationStatus = 'CONFIRMED' | 'CHECKED_IN' | 'CHECKED_OUT' | 'CANCELLED' | 'NO_SHOW';

const IsoDate = z.string().refine(isIsoDate, 'must be YYYY-MM-DD');
const Uuid = z.uuid();

export const OfflineReservationSchema = z
  .object({
    roomTypeId: Uuid,
    ratePlanId: Uuid.optional(),
    checkIn: IsoDate,
    checkOut: IsoDate,
    rooms: z.number().int().min(1).max(20).default(1),
    adults: z.number().int().min(1).max(60).default(2),
    children: z.number().int().min(0).max(40).default(0),
    source: z.enum(RESERVATION_SOURCES),
    sourceDetail: z.string().trim().max(120).optional(),
    guestName: z.string().trim().min(2).max(120),
    guestPhone: z.string().trim().regex(/^\+?[0-9 ]{8,18}$/, 'digits only').optional().or(z.literal('').transform(() => undefined)),
    guestEmail: z.email().max(254).optional().or(z.literal('').transform(() => undefined)),
    amountMinor: z.number().int().min(0).max(100_000_000_00).optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict()
  .refine((r) => r.checkOut > r.checkIn, { message: 'checkOut must be after checkIn', path: ['checkOut'] })
  .refine((r) => daysBetween(r.checkIn, r.checkOut) <= MAX_NIGHTS, { message: `at most ${MAX_NIGHTS} nights`, path: ['checkOut'] });

export type OfflineReservationInput = z.input<typeof OfflineReservationSchema>;

/** Hotels whose inventory a channel manager owns must record manual sales there. */
async function assertExtranetHotel(db: PoolClient, hotelId: string) {
  const { rows } = await db.query(
    `SELECT h.inventory_source, h.timezone, h.currency, cp.name AS partner_name
       FROM hotels h LEFT JOIN channel_partners cp ON cp.id = h.channel_partner_id
      WHERE h.id = $1 AND h.is_active`,
    [hotelId],
  );
  const h = rows[0];
  if (!h) throw new AppError('NOT_FOUND', 'Hotel not found');
  if (h.inventory_source !== 'EXTRANET') {
    const who = h.inventory_source === 'CHANNEL_MANAGER' ? (h.partner_name ?? 'its channel manager') : 'the B2B supplier';
    throw new AppError('CONFLICT', `This hotel's rooms are managed by ${who}. Record offline sales there so every channel stays in sync.`, {
      source: h.inventory_source,
    });
  }
  return { timezone: h.timezone as string, currency: (h.currency as string).trim() };
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I: easy to read out on the phone
function newReference(): string {
  const bytes = randomBytes(6);
  return 'HB-' + Array.from(bytes, (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
}

export async function createOfflineReservation(hotelId: string, userId: string, input: OfflineReservationInput) {
  const parsed = OfflineReservationSchema.safeParse(input);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Please check the booking details', { issues: z.flattenError(parsed.error) });
  const r = parsed.data;

  return withTransaction(
    async (client) => {
      const hotel = await assertExtranetHotel(client, hotelId);
      const today = todayIn(hotel.timezone);
      // Walk-ins arrive today; allow yesterday too for late-night entries after midnight.
      if (r.checkIn < addDays(today, -1)) throw new AppError('VALIDATION_ERROR', 'Check-in is in the past');

      const room = await client.query(
        `SELECT rt.id, rt.name, rt.max_occupancy, rt.max_adults, rt.max_children,
                (SELECT id FROM rate_plans WHERE room_type_id = rt.id AND is_active
                   AND ($3::uuid IS NULL AND is_default OR id = $3::uuid) LIMIT 1) AS rate_plan_id
           FROM room_types rt WHERE rt.id = $1 AND rt.hotel_id = $2 AND rt.is_active`,
        [r.roomTypeId, hotelId, r.ratePlanId ?? null],
      );
      const rt = room.rows[0];
      if (!rt) throw new AppError('NOT_FOUND', 'Room type not found');
      if (r.adults > rt.max_adults * r.rooms || r.children > rt.max_children * r.rooms || r.adults + r.children > rt.max_occupancy * r.rooms) {
        throw new AppError('VALIDATION_ERROR', `${rt.name} takes up to ${rt.max_adults} adults and ${rt.max_children} children per room`);
      }

      // 1. Lock every night (date order = same lock order as the online checkout).
      const nights = stayNights(r.checkIn, r.checkOut);
      const inv = await client.query<{ stay_date: string; available: number }>(
        `SELECT stay_date, available FROM daily_inventory
          WHERE room_type_id = $1 AND stay_date >= $2 AND stay_date < $3
          ORDER BY stay_date FOR UPDATE`,
        [r.roomTypeId, r.checkIn, r.checkOut],
      );
      const byDate = new Map(inv.rows.map((x) => [x.stay_date, x.available]));
      const short = nights
        .map((d) => ({ date: d, available: byDate.get(d) }))
        .filter((n) => n.available === undefined || n.available < r.rooms);
      if (short.length) {
        // Stop-sell is a channel restriction; the hotel itself may still sell a walk-in.
        // Capacity is what counts.
        throw new AppError('SOLD_OUT', `Not enough rooms on ${short.map((s) => s.date).join(', ')}`, {
          nights: short.map((s) => ({ date: s.date, available: s.available ?? 0, loaded: s.available !== undefined })),
        });
      }

      // 2. Take the rooms. The WHERE re-checks capacity in the same statement.
      const upd = await client.query(
        `UPDATE daily_inventory SET allotment = allotment - $4, updated_at = now()
          WHERE room_type_id = $1 AND stay_date >= $2 AND stay_date < $3 AND allotment - held >= $4`,
        [r.roomTypeId, r.checkIn, r.checkOut, r.rooms],
      );
      if (upd.rowCount !== nights.length) throw new AppError('SOLD_OUT', 'Room just sold out');

      // 3. Record the reservation (retry the short reference on the rare collision).
      let created;
      for (let attempt = 0; ; attempt++) {
        try {
          await client.query('SAVEPOINT ref');
          created = (
            await client.query(
              `INSERT INTO reservations
                 (reference, hotel_id, room_type_id, rate_plan_id, source, source_detail, check_in, check_out, rooms,
                  adults, children, guest_name, guest_phone, guest_email, amount_minor, currency, notes, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
               RETURNING *`,
              [newReference(), hotelId, r.roomTypeId, rt.rate_plan_id, r.source, r.sourceDetail ?? null, r.checkIn, r.checkOut, r.rooms,
                r.adults, r.children, r.guestName, r.guestPhone ?? null, r.guestEmail ?? null, r.amountMinor ?? null, hotel.currency,
                r.notes ?? null, userId],
            )
          ).rows[0];
          await client.query('RELEASE SAVEPOINT ref');
          break;
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT ref');
          if ((err as { code?: string }).code !== '23505' || attempt >= 4) throw err;
        }
      }

      await client.query(
        `INSERT INTO reservation_events (reservation_id, from_status, to_status, user_id, remark) VALUES ($1, NULL, 'CONFIRMED', $2, $3)`,
        [created.id, userId, `Recorded as ${r.source}`],
      );
      await audit(client, {
        hotelId,
        userId,
        action: 'RESERVATION_CREATE',
        summary: `${r.rooms} x ${rt.name}, ${r.checkIn} to ${r.checkOut}, ${r.guestName} (${r.source.replace('_', ' ').toLowerCase()})`,
        details: { reservationId: created.id, reference: created.reference },
      });

      // 4. Every channel hears about the lower availability, in this same transaction.
      await enqueueForSubscribers(client, hotelId, 'ARI_CHANGED', {
        changes: [{ roomTypeId: r.roomTypeId, ratePlanId: rt.rate_plan_id, from: r.checkIn, to: r.checkOut }],
        cause: 'offline_sale',
      });

      return toPublic(created);
    },
    { lockTimeoutMs: 3_000 },
  );
}

// Allowed status moves. Everything else is refused.
const TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CHECKED_IN: ['CHECKED_OUT'],
  CHECKED_OUT: [],
  CANCELLED: [],
  NO_SHOW: [],
};

/**
 * Moves a reservation through its lifecycle. Cancel, no-show and early checkout give
 * the unused nights (from today onwards) back to inventory, exactly once.
 */
export async function changeReservationStatus(hotelId: string, userId: string, reservationId: string, to: ReservationStatus, remark?: string) {
  return withTransaction(async (client) => {
    const hotel = await assertExtranetHotel(client, hotelId);
    // Lock the reservation row first, then inventory: same order as every other path.
    const { rows } = await client.query('SELECT * FROM reservations WHERE id = $1 AND hotel_id = $2 FOR UPDATE', [reservationId, hotelId]);
    const res = rows[0];
    if (!res) throw new AppError('NOT_FOUND', 'Reservation not found');
    const from = res.status as ReservationStatus;
    if (from === to) return toPublic(res);
    if (!TRANSITIONS[from].includes(to)) {
      throw new AppError('CONFLICT', `A ${label(from)} booking cannot be marked ${label(to)}`);
    }

    // Which nights come back? From today (or check-in if later) to check-out.
    let releaseFrom: string | null = null;
    if ((to === 'CANCELLED' || to === 'NO_SHOW' || to === 'CHECKED_OUT') && !res.released_from) {
      const today = todayIn(hotel.timezone);
      const start = res.check_in > today ? res.check_in : today;
      if (start < res.check_out) {
        releaseFrom = start;
        await client.query(
          `UPDATE daily_inventory SET allotment = allotment + $4, updated_at = now()
            WHERE room_type_id = $1 AND stay_date >= $2 AND stay_date < $3`,
          [res.room_type_id, start, res.check_out, res.rooms],
        );
        await enqueueForSubscribers(client, hotelId, 'ARI_CHANGED', {
          changes: [{ roomTypeId: res.room_type_id, ratePlanId: res.rate_plan_id, from: start, to: res.check_out }],
          cause: `offline_${to.toLowerCase()}`,
        });
      }
    }

    const updated = (
      await client.query(
        `UPDATE reservations SET status = $2, released_from = COALESCE($3::date, released_from), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [reservationId, to, releaseFrom],
      )
    ).rows[0];
    await client.query(
      'INSERT INTO reservation_events (reservation_id, from_status, to_status, user_id, remark) VALUES ($1, $2, $3, $4, $5)',
      [reservationId, from, to, userId, remark?.slice(0, 500) ?? null],
    );
    await audit(client, {
      hotelId,
      userId,
      action: 'RESERVATION_STATUS',
      summary: `${res.reference} ${res.guest_name}: ${label(from)} to ${label(to)}${releaseFrom ? `, ${daysBetween(releaseFrom, res.check_out)} night(s) back on sale` : ''}`,
      details: { reservationId, from, to, releaseFrom },
    });
    return toPublic(updated);
  });
}

/** Offline reservations + paid online bookings, so the desk sees every guest in one list. */
export async function listReservations(hotelId: string, from: string, to: string) {
  const { rows } = await pool.query(
    `SELECT r.id, r.reference, CASE WHEN r.source = 'CHANNEL_MANAGER' THEN 'OTA' ELSE 'OFFLINE' END AS channel, r.source, r.source_detail, r.status::text, r.check_in, r.check_out, r.rooms,
            r.adults, r.children, r.guest_name, r.guest_phone, r.guest_email, r.amount_minor, r.currency, r.notes,
            rt.name AS room_name, r.room_type_id, r.created_at, u.name AS created_by, r.overbooked
       FROM reservations r
       JOIN room_types rt ON rt.id = r.room_type_id
       LEFT JOIN hotel_users u ON u.id = r.created_by
      WHERE r.hotel_id = $1 AND r.check_out > $2 AND r.check_in <= $3
     UNION ALL
     SELECT h.id, upper(substr(h.pending_booking_token, 5, 8)), 'ONLINE', 'WEBSITE', NULL, h.status::text, h.check_in, h.check_out, h.rooms,
            NULL, NULL, h.customer->>'name', h.customer->>'phone', h.customer->>'email', h.quoted_total_minor, h.currency, NULL,
            rt.name, h.room_type_id, h.created_at, NULL, false
       FROM inventory_holds h
       JOIN room_types rt ON rt.id = h.room_type_id
      WHERE h.hotel_id = $1 AND h.status = 'CONFIRMED' AND h.check_out > $2 AND h.check_in <= $3
      ORDER BY check_in, created_at`,
    [hotelId, from, to],
  );
  return rows.map((x) => ({ ...x, currency: (x.currency as string).trim() }));
}

function toPublic(r: Record<string, unknown>) {
  return {
    id: r.id,
    reference: r.reference,
    status: r.status,
    source: r.source,
    sourceDetail: r.source_detail,
    roomTypeId: r.room_type_id,
    checkIn: r.check_in,
    checkOut: r.check_out,
    rooms: r.rooms,
    adults: r.adults,
    children: r.children,
    guestName: r.guest_name,
    guestPhone: r.guest_phone,
    guestEmail: r.guest_email,
    amountMinor: r.amount_minor,
    currency: typeof r.currency === 'string' ? r.currency.trim() : r.currency,
    notes: r.notes,
    releasedFrom: r.released_from,
    createdAt: r.created_at,
  };
}

const label = (s: ReservationStatus) => s.replace('_', ' ').toLowerCase();
