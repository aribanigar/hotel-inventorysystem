/**
 * OTA bookings from Channex.
 *
 * One processing path, two triggers:
 *   - the booking webhook (POST /api/v1/channex/webhook) asks for an immediate pull;
 *   - a background loop pulls the feed every couple of minutes as the safety net
 *     (Channex: keep polling as a backup even when webhooks are on).
 *
 * For each unacknowledged revision in GET /api/v1/booking_revisions/feed (oldest first):
 *   1. find our hotel by Channex property id and our room types / rate plans by mapping;
 *   2. apply it in ONE transaction (shared OTA booking logic: locks, overbooking flag,
 *      modify, cancel) and record the revision as APPLIED;
 *   3. only after COMMIT, acknowledge it (POST /booking_revisions/:id/ack).
 * If the process dies between 2 and 3, the revision comes back in the feed, is found
 * as APPLIED, and is simply acknowledged again: no double booking.
 * A revision we cannot apply (unmapped room, unknown property) is recorded as FAILED
 * and NOT acknowledged, so it stays visible in Channex and is retried after the
 * mapping is fixed.
 */
import { pool, withTransaction } from '../../db/pool.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { decimalToMinor } from '../../lib/money.js';
import { applyOtaBooking, type OtaLine } from '../otaBookings.js';
import { channex, channexConfigured, describeChannexError } from './client.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ChannexRevision {
  id?: string;
  revision_id?: string;
  booking_id?: string;
  property_id?: string;
  status?: string;
  ota_name?: string;
  ota_reservation_code?: string;
  unique_id?: string;
  arrival_date?: string;
  departure_date?: string;
  amount?: string | number;
  currency?: string;
  notes?: string;
  customer?: { name?: string; surname?: string; mail?: string; phone?: string };
  rooms?: Array<{
    room_type_id?: string | null;
    rate_plan_id?: string | null;
    checkin_date?: string;
    checkout_date?: string;
    occupancy?: { adults?: number; children?: number; infants?: number };
    amount?: string | number;
  }>;
}

export type RevisionOutcome = 'applied' | 'already_applied' | 'failed' | 'skipped';

/** Applies one revision (idempotent by revision id). Does NOT acknowledge it. */
export async function applyChannexRevision(revisionId: string, rev: ChannexRevision): Promise<{ outcome: RevisionOutcome; error?: string }> {
  if (!UUID.test(revisionId)) return { outcome: 'skipped', error: 'revision id is not a UUID' };
  const status = String(rev.status ?? '').toLowerCase();
  const bookingId = String(rev.booking_id ?? '');

  try {
    return await withTransaction(async (client) => {
      // Serialise per revision so the webhook pull and the timer pull can't both apply it.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cxrev:${revisionId}`]);
      const seen = (await client.query('SELECT state FROM channex_booking_revisions WHERE revision_id = $1', [revisionId])).rows[0];
      if (seen?.state === 'APPLIED') return { outcome: 'already_applied' as const };

      if (!UUID.test(bookingId)) throw new AppError('VALIDATION_ERROR', 'booking_id missing');
      if (!['new', 'modified', 'cancelled'].includes(status)) throw new AppError('VALIDATION_ERROR', `unknown revision status "${status}"`);
      // Revisions are applied oldest first. If an earlier revision of this booking is
      // stuck (e.g. unmapped room), wait for it: applying a later "cancelled" first and
      // the stuck "new" afterwards would resurrect a cancelled booking.
      const stuck = (
        await client.query(
          `SELECT 1 FROM channex_booking_revisions
            WHERE booking_id = $1::uuid AND state = 'FAILED' AND revision_id <> $2::uuid
              AND received_at < COALESCE((SELECT received_at FROM channex_booking_revisions WHERE revision_id = $2::uuid), now())
            LIMIT 1`,
          [bookingId, revisionId],
        )
      ).rowCount;
      if (stuck) throw new AppError('CONFLICT', 'Waiting for an earlier revision of this booking that could not be applied yet');

      const hotel = (
        await client.query(
          `SELECT h.id, h.timezone, h.currency, h.inventory_source FROM channex_properties p JOIN hotels h ON h.id = p.hotel_id
            WHERE p.channex_property_id = $1::uuid`,
          [UUID.test(String(rev.property_id)) ? rev.property_id : '00000000-0000-0000-0000-000000000000'],
        )
      ).rows[0];
      if (!hotel) throw new AppError('NOT_FOUND', `Channex property ${rev.property_id} is not linked to any hotel here`);
      if (hotel.inventory_source !== 'EXTRANET') throw new AppError('CONFLICT', 'This hotel is not managed in our extranet');

      // Rooms: one entry per booked room in Channex; group identical ones.
      const lines: OtaLine[] = [];
      if (status !== 'cancelled') {
        const groups = new Map<string, OtaLine>();
        for (const room of rev.rooms ?? []) {
          const cxRoom = room.room_type_id;
          const rt = cxRoom
            ? (await client.query('SELECT room_type_id FROM channex_room_map WHERE hotel_id = $1 AND channex_room_type_id = $2::uuid', [hotel.id, cxRoom])).rows[0]
            : null;
          if (!rt) throw new AppError('VALIDATION_ERROR', `Booking has a room that is not mapped (Channex room type ${cxRoom ?? 'none'})`);
          let ratePlanId: string | null = null;
          if (room.rate_plan_id && UUID.test(room.rate_plan_id)) {
            ratePlanId =
              (await client.query('SELECT rate_plan_id FROM channex_rate_map WHERE hotel_id = $1 AND channex_rate_plan_id = $2::uuid', [hotel.id, room.rate_plan_id])).rows[0]
                ?.rate_plan_id ?? null;
          }
          ratePlanId ??= (await client.query('SELECT id FROM rate_plans WHERE room_type_id = $1 AND is_default LIMIT 1', [rt.room_type_id])).rows[0]?.id ?? null;
          const checkIn = String(room.checkin_date ?? rev.arrival_date ?? '').slice(0, 10);
          const checkOut = String(room.checkout_date ?? rev.departure_date ?? '').slice(0, 10);
          if (!DATE.test(checkIn) || !DATE.test(checkOut) || checkOut <= checkIn) throw new AppError('VALIDATION_ERROR', 'Invalid check-in/check-out dates');
          const key = `${rt.room_type_id}|${ratePlanId}|${checkIn}|${checkOut}`;
          const g = groups.get(key) ?? { roomTypeId: rt.room_type_id, ratePlanId, checkIn, checkOut, rooms: 0, adults: 0, children: 0 };
          g.rooms += 1;
          g.adults += Math.max(0, Number(room.occupancy?.adults ?? 0) || 0);
          g.children += Math.max(0, Number(room.occupancy?.children ?? 0) || 0) + Math.max(0, Number(room.occupancy?.infants ?? 0) || 0);
          groups.set(key, g);
        }
        for (const g of groups.values()) lines.push({ ...g, rooms: Math.min(20, g.rooms) });
      }

      const c = rev.customer ?? {};
      const otaName = String(rev.ota_name || 'Channex').slice(0, 120);
      const { result, overbooked } = await applyOtaBooking(
        client,
        hotel,
        { kind: 'CHANNEX', bookingId },
        {
          status: status as 'new' | 'modified' | 'cancelled',
          remark: `${otaName} via Channex: ${status}`,
          lines,
          guestName: `${c.name ?? ''} ${c.surname ?? ''}`.trim() || 'OTA guest',
          guestPhone: c.phone ?? null,
          guestEmail: c.mail ?? null,
          totalMinor: rev.amount !== undefined && rev.amount !== null ? decimalToMinor(rev.amount) : null,
          currency: String(rev.currency ?? hotel.currency),
          otaName,
          notes: rev.notes ?? null,
          referenceCode: String(rev.ota_reservation_code || rev.unique_id || bookingId.slice(0, 8)),
          via: 'via Channex',
          payload: rev,
        },
      );
      await client.query(
        `INSERT INTO channex_booking_revisions (revision_id, booking_id, hotel_id, status, state, result, ota_name, payload, applied_at)
         VALUES ($1, $2, $3, $4, 'APPLIED', $5, $6, $7::jsonb, now())
         ON CONFLICT (revision_id) DO UPDATE SET state = 'APPLIED', result = EXCLUDED.result, error = NULL, hotel_id = EXCLUDED.hotel_id,
           attempts = channex_booking_revisions.attempts + 1, applied_at = now(), payload = EXCLUDED.payload`,
        [revisionId, bookingId, hotel.id, status, result + (overbooked ? ' (overbooked)' : ''), otaName, JSON.stringify(rev)],
      );
      return { outcome: 'applied' as const };
    });
  } catch (err) {
    const message = (err as Error).message?.slice(0, 500) ?? 'unknown error';
    const hotelId = (
      await pool.query('SELECT hotel_id FROM channex_properties WHERE channex_property_id::text = $1', [String(rev.property_id ?? '')])
    ).rows[0]?.hotel_id ?? null;
    const r = await pool.query(
      `INSERT INTO channex_booking_revisions (revision_id, booking_id, hotel_id, status, state, error, ota_name, payload)
       VALUES ($1, $2, $3, $4, 'FAILED', $5, $6, $7::jsonb)
       ON CONFLICT (revision_id) DO UPDATE SET error = EXCLUDED.error, attempts = channex_booking_revisions.attempts + 1,
         hotel_id = COALESCE(EXCLUDED.hotel_id, channex_booking_revisions.hotel_id)
       WHERE channex_booking_revisions.state = 'FAILED'
       RETURNING attempts`,
      [revisionId, UUID.test(bookingId) ? bookingId : revisionId, hotelId, status || 'unknown', message, rev.ota_name ?? null, JSON.stringify(rev)],
    );
    if ((r.rows[0]?.attempts ?? 1) === 1) {
      logger.error({ revisionId, bookingId, propertyId: rev.property_id, message }, 'ALERT: Channex booking could not be applied; fix the mapping (it stays unacknowledged)');
    }
    return { outcome: 'failed', error: message };
  }
}

async function ack(revisionId: string) {
  await channex('POST', `/api/v1/booking_revisions/${revisionId}/ack`);
  await pool.query('UPDATE channex_booking_revisions SET acked_at = now() WHERE revision_id = $1', [revisionId]);
}

let running: Promise<number> | null = null;

/**
 * Pulls and applies every unacknowledged revision. Safe to call concurrently (calls
 * share one in-flight run). Returns how many revisions were applied.
 */
export function pullChannexBookings(): Promise<number> {
  if (!channexConfigured()) return Promise.resolve(0);
  running ??= (async () => {
    let applied = 0;
    try {
      for (let round = 0; round < 20; round++) {
        const q = new URLSearchParams({ 'order[inserted_at]': 'asc', 'pagination[limit]': '100', 'pagination[page]': '1' });
        const res = await channex<Array<{ id: string; attributes: ChannexRevision }>>('GET', `/api/v1/booking_revisions/feed?${q}`);
        const items = res.data ?? [];
        let progressed = 0;
        for (const item of items) {
          const revId = item.id ?? item.attributes?.id;
          const r = await applyChannexRevision(String(revId), item.attributes ?? {});
          if (r.outcome === 'applied' || r.outcome === 'already_applied') {
            if (r.outcome === 'applied') applied++;
            try {
              await ack(String(revId));
              progressed++;
            } catch (err) {
              // Applied but not acked: it will come back and be acked then.
              logger.warn({ revisionId: revId, message: describeChannexError(err) }, 'Channex ack failed, will retry');
            }
          }
        }
        // Stop when the feed is drained, or when what is left can't be applied yet.
        if (items.length < 100 || progressed === 0) break;
      }
    } catch (err) {
      logger.warn({ message: describeChannexError(err) }, 'Channex booking feed pull failed');
    } finally {
      running = null;
    }
    return applied;
  })();
  return running;
}
