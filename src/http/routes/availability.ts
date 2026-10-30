/**
 * GET /api/v1/hotels/:hotelId/availability?checkIn=&checkOut=&rooms=&roomTypeId=
 *
 * Read-only live availability for listing and room pages. Takes no locks: the
 * authoritative check is always the Live Ping at checkout.
 *
 * Source 1 hotels hit the supplier per room type, so callers should pass roomTypeId
 * (or accept a slower response). A supplier failure for one room returns
 * `error` for that room instead of failing the whole page.
 */
import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { isUuid } from '../../inventory/catalog.js';
import { fetchExternalLiveInventory } from '../../inventory/external.js';
import { fetchInternalLiveInventory } from '../../inventory/internal.js';
import { assertValidStay } from '../../lib/dates.js';
import { AppError, isAppError } from '../../lib/errors.js';
import { rateLimit } from '../middleware/rateLimit.js';

export const availabilityRouter = Router();

availabilityRouter.get('/:hotelId/availability', rateLimit({ windowMs: 60_000, max: 240 }), async (req, res) => {
  const { hotelId } = req.params;
  const checkIn = String(req.query.checkIn ?? '');
  const checkOut = String(req.query.checkOut ?? '');
  const rooms = Number(req.query.rooms ?? 1);
  const onlyRoom = req.query.roomTypeId ? String(req.query.roomTypeId) : undefined;
  if (!isUuid(hotelId) || (onlyRoom && !isUuid(onlyRoom))) throw new AppError('VALIDATION_ERROR', 'Invalid id');
  if (!Number.isInteger(rooms) || rooms < 1 || rooms > 9) throw new AppError('VALIDATION_ERROR', 'rooms must be 1-9');

  const { rows: hotelRows } = await pool.query('SELECT id, name, inventory_source, timezone FROM hotels WHERE id = $1 AND is_active', [hotelId]);
  const hotel = hotelRows[0];
  if (!hotel) throw new AppError('NOT_FOUND', 'Hotel not found');
  assertValidStay(checkIn, checkOut, hotel.timezone);

  const { rows: roomRows } = await pool.query(
    `SELECT id, name, max_occupancy FROM room_types WHERE hotel_id = $1 AND is_active AND ($2::uuid IS NULL OR id = $2) ORDER BY name LIMIT 30`,
    [hotelId, onlyRoom ?? null],
  );
  if (hotel.inventory_source === 'EXTERNAL_B2B' && roomRows.length > 5 && !onlyRoom) {
    throw new AppError('VALIDATION_ERROR', 'Pass roomTypeId for supplier-backed hotels with many room types');
  }

  const results = await Promise.all(
    roomRows.map(async (room) => {
      try {
        const live =
          hotel.inventory_source === 'EXTERNAL_B2B'
            ? await fetchExternalLiveInventory(hotelId, room.id, checkIn, checkOut, { rooms })
            : await fetchInternalLiveInventory(hotelId, room.id, checkIn, checkOut, { rooms });
        const { supplierBookingKey: _k, supplierExpiresAt: _e, ...publicView } = live;
        return { roomTypeId: room.id, name: room.name, maxOccupancy: room.max_occupancy, ...publicView };
      } catch (err) {
        if (!isAppError(err)) throw err;
        return { roomTypeId: room.id, name: room.name, available: false, error: err.toJSON() };
      }
    }),
  );

  res.setHeader('Cache-Control', 'no-store');
  res.json({ hotelId, name: hotel.name, source: hotel.inventory_source, checkIn, checkOut, rooms, roomTypes: results });
});
