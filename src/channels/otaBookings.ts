/**
 * Applying an OTA booking that arrives through a channel manager (QloApps CM or
 * Channex). Shared so every connection behaves the same:
 *
 *  - serialised per booking (advisory lock on its id), so retries and webhook/feed
 *    races cannot double-book;
 *  - new / modified replace the booking's live rows: old nights go back to inventory,
 *    new nights are taken under the same row locks (room type, then date) as walk-ins
 *    and website checkouts;
 *  - an OTA booking cannot be refused (the guest already booked on the OTA). If a
 *    night is short it is still recorded, allotment never goes negative, the row is
 *    flagged overbooked and an ALERT is logged for the desk;
 *  - cancelled gives the remaining nights back (never past nights, never twice);
 *  - every change queues ARI_CHANGED, so the new availability goes back to all
 *    channels.
 */
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { todayIn } from '../lib/dates.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { enqueueForSubscribers } from '../outbox/outbox.js';

export type OtaBookingRef = { kind: 'QLO_CM'; accountId: string; bookingId: string } | { kind: 'CHANNEX'; bookingId: string };

export interface OtaLine {
  roomTypeId: string;
  ratePlanId: string | null;
  checkIn: string;
  checkOut: string;
  rooms: number;
  adults: number;
  children: number;
}

export interface OtaBooking {
  status: 'new' | 'modified' | 'cancelled' | 'completed';
  /** Shown in the reservation history, e.g. "Channel manager: cancelled". */
  remark: string;
  lines: OtaLine[];
  guestName: string;
  guestPhone?: string | null;
  guestEmail?: string | null;
  totalMinor: number | null;
  currency: string;
  otaName: string;
  notes?: string | null;
  /** Short code put in the reservation reference (OTA or CM booking code). */
  referenceCode: string;
  /** "via channel manager" / "via Channex": used in history and audit lines. */
  via: string;
  payload: unknown;
}

export type OtaApplyResult = 'booked' | 'cancelled' | 'not_found' | 'unchanged';

interface Hotel {
  id: string;
  timezone: string;
  currency: string;
}

function matchClause(ref: OtaBookingRef): { sql: string; params: unknown[] } {
  return ref.kind === 'QLO_CM'
    ? { sql: 'cm_account_id = $2 AND cm_booking_id = $3', params: [ref.accountId, ref.bookingId] }
    : { sql: 'channex_booking_id = $2::uuid', params: [ref.bookingId] };
}

export async function applyOtaBooking(client: PoolClient, hotel: Hotel, ref: OtaBookingRef, b: OtaBooking): Promise<{ result: OtaApplyResult; overbooked: boolean }> {
  const today = todayIn(hotel.timezone);
  const lockKey = ref.kind === 'QLO_CM' ? `cm:${ref.accountId}:${ref.bookingId}` : `cx:${ref.bookingId}`;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);

  const m = matchClause(ref);
  const existing = (
    await client.query(`SELECT * FROM reservations WHERE hotel_id = $1 AND ${m.sql} ORDER BY check_in, room_type_id FOR UPDATE`, [hotel.id, ...m.params])
  ).rows;
  const live = existing.filter((r) => r.status === 'CONFIRMED' || r.status === 'CHECKED_IN');

  const releaseLive = async () => {
    for (const r of live) {
      const start = r.check_in > today ? r.check_in : today;
      if (!r.released_from && start < r.check_out) {
        await client.query(
          `UPDATE daily_inventory SET allotment = allotment + $4, updated_at = now()
            WHERE room_type_id = $1 AND stay_date >= $2 AND stay_date < $3`,
          [r.room_type_id, start, r.check_out, r.rooms],
        );
        await enqueueForSubscribers(client, hotel.id, 'ARI_CHANGED', {
          changes: [{ roomTypeId: r.room_type_id, ratePlanId: r.rate_plan_id, from: start, to: r.check_out }],
          cause: 'ota_cancel',
        });
      }
      await client.query(`UPDATE reservations SET status = 'CANCELLED', released_from = COALESCE(released_from, $2::date), updated_at = now() WHERE id = $1`, [
        r.id,
        start < r.check_out ? start : null,
      ]);
      await client.query(`INSERT INTO reservation_events (reservation_id, from_status, to_status, remark) VALUES ($1, $2, 'CANCELLED', $3)`, [
        r.id,
        r.status,
        b.remark,
      ]);
    }
  };

  if (b.status === 'cancelled') {
    if (!existing.length) return { result: 'not_found', overbooked: false };
    await releaseLive();
    return { result: 'cancelled', overbooked: false };
  }
  if (b.status === 'completed' && live.length) return { result: 'unchanged', overbooked: false }; // payment confirmation only

  // new (or a re-sent new) / modified: replace the live rows with the requested ones.
  if (!b.lines.length) throw new AppError('VALIDATION_ERROR', 'Requested room(s) not available.');
  if (live.length) await releaseLive();

  const sorted = [...b.lines].sort((x, y) => x.roomTypeId.localeCompare(y.roomTypeId) || x.checkIn.localeCompare(y.checkIn));
  let first = true;
  let anyOverbooked = false;
  for (const line of sorted) {
    const inv = await client.query<{ stay_date: string; available: number }>(
      `SELECT stay_date, available FROM daily_inventory WHERE room_type_id = $1 AND stay_date >= $2 AND stay_date < $3 ORDER BY stay_date FOR UPDATE`,
      [line.roomTypeId, line.checkIn, line.checkOut],
    );
    const nights = Math.round((Date.parse(line.checkOut) - Date.parse(line.checkIn)) / 86_400_000);
    const overbooked = inv.rows.length < nights || inv.rows.some((n) => n.available < line.rooms);
    anyOverbooked ||= overbooked;
    await client.query(
      `UPDATE daily_inventory SET allotment = GREATEST(allotment - $4, 0), updated_at = now()
        WHERE room_type_id = $1 AND stay_date >= $2 AND stay_date < $3`,
      [line.roomTypeId, line.checkIn, line.checkOut, line.rooms],
    );
    const prefix = ref.kind === 'QLO_CM' ? 'CM' : 'CX';
    const created = (
      await client.query(
        `INSERT INTO reservations
           (reference, hotel_id, room_type_id, rate_plan_id, source, source_detail, check_in, check_out, rooms, adults, children,
            guest_name, guest_phone, guest_email, amount_minor, currency, notes, cm_account_id, cm_booking_id, channex_booking_id,
            overbooked, external_payload)
         VALUES ($1,$2,$3,$4,'CHANNEL_MANAGER',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb)
         RETURNING id`,
        [
          // Unique per row: a modified booking creates new rows while old ones stay as history.
          `${prefix}-${b.referenceCode.replace(/[^A-Za-z0-9]/g, '').slice(0, 20)}-${randomBytes(3).toString('hex').toUpperCase()}`,
          hotel.id, line.roomTypeId, line.ratePlanId, b.otaName.slice(0, 120), line.checkIn, line.checkOut, line.rooms,
          Math.max(1, line.adults || 2 * line.rooms), Math.max(0, line.children),
          (b.guestName || 'OTA guest').slice(0, 120), b.guestPhone ? String(b.guestPhone).slice(0, 40) : null,
          b.guestEmail ? String(b.guestEmail).slice(0, 254) : null,
          first ? b.totalMinor : null, String(b.currency || hotel.currency).trim().slice(0, 3).toUpperCase(),
          b.notes ? String(b.notes).slice(0, 1000) : null,
          ref.kind === 'QLO_CM' ? ref.accountId : null, ref.kind === 'QLO_CM' ? ref.bookingId : null,
          ref.kind === 'CHANNEX' ? ref.bookingId : null, overbooked, JSON.stringify(b.payload),
        ],
      )
    ).rows[0];
    first = false;
    await client.query(`INSERT INTO reservation_events (reservation_id, from_status, to_status, remark) VALUES ($1, NULL, 'CONFIRMED', $2)`, [
      created.id,
      `${b.otaName} ${b.via}${overbooked ? ' (OVERBOOKED)' : ''}`,
    ]);
    await client.query(
      `INSERT INTO extranet_audit (hotel_id, user_id, action, summary, details) VALUES ($1, NULL, 'RESERVATION_CREATE', $2, $3::jsonb)`,
      [
        hotel.id,
        `${b.otaName}: ${line.rooms} room(s), ${line.checkIn} to ${line.checkOut}, ${b.guestName}${overbooked ? ' - OVERBOOKED, needs action' : ''}`,
        JSON.stringify({ ref: { kind: ref.kind, bookingId: ref.bookingId }, status: b.status }),
      ],
    );
    if (overbooked) {
      logger.error({ hotelId: hotel.id, ref, roomTypeId: line.roomTypeId, checkIn: line.checkIn, checkOut: line.checkOut }, 'ALERT: OTA booking arrived for a sold-out night (overbooked)');
    }
    await enqueueForSubscribers(client, hotel.id, 'ARI_CHANGED', {
      changes: [{ roomTypeId: line.roomTypeId, ratePlanId: line.ratePlanId, from: line.checkIn, to: line.checkOut }],
      cause: 'ota_booking',
    });
  }
  return { result: 'booked', overbooked: anyOverbooked };
}
