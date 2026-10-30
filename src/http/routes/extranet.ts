/**
 * SOURCE 3 write side: PUT /api/v1/extranet/hotels/:hotelId/ari
 *
 * Used by our own extranet (houseboat owners, boutique stays) to set rooms, prices and
 * restrictions. Same tables, same upsert and same locks as the channel-manager webhook,
 * so the Live Ping treats both identically.
 *
 * Auth: Bearer EXTRANET_ADMIN_TOKEN. Replace with your admin session/JWT when wiring
 * into the existing OTA admin panel.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { withTransaction } from '../../db/pool.js';
import { applyAriUpdates } from '../../inventory/ariUpdates.js';
import { isUuid } from '../../inventory/catalog.js';
import { safeEqual } from '../../lib/crypto.js';
import { daysBetween, isIsoDate } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';

export const extranetRouter = Router();

function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const token = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!config.EXTRANET_ADMIN_TOKEN || !token || !safeEqual(token, config.EXTRANET_ADMIN_TOKEN)) {
    return next(new AppError('UNAUTHORIZED', 'Invalid credentials'));
  }
  next();
}

const Uuid = z.string().refine(isUuid, 'must be a uuid');
const IsoDate = z.string().refine(isIsoDate, 'must be YYYY-MM-DD');

const Body = z
  .object({
    updates: z
      .array(
        z
          .object({
            roomTypeId: Uuid,
            ratePlanId: Uuid.optional(),
            startDate: IsoDate,
            endDate: IsoDate,
            availability: z.number().int().min(0).max(1000).optional(),
            priceMinor: z.number().int().positive().max(100_000_000_00).optional(),
            stopSell: z.boolean().optional(),
            minLos: z.number().int().min(1).max(365).optional(),
            maxLos: z.number().int().min(1).max(365).nullable().optional(),
            closedToArrival: z.boolean().optional(),
            closedToDeparture: z.boolean().optional(),
          })
          .strict()
          .refine((u) => u.endDate >= u.startDate && daysBetween(u.startDate, u.endDate) < 750, 'invalid date range'),
      )
      .min(1)
      .max(500),
  })
  .strict();

extranetRouter.put('/hotels/:hotelId/ari', requireAdmin, async (req, res) => {
  const { hotelId } = req.params;
  if (!isUuid(hotelId)) throw new AppError('VALIDATION_ERROR', 'Invalid hotel id');
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Invalid ARI payload', { issues: z.flattenError(parsed.error) });

  const result = await withTransaction(async (client) => {
    // Only EXTRANET hotels may be edited here; CM hotels are owned by their CM.
    const { rows } = await client.query(
      `SELECT h.currency,
              ARRAY(SELECT id::text FROM room_types WHERE hotel_id = h.id) AS rooms,
              ARRAY(SELECT rp.id::text || '|' || rp.room_type_id::text FROM rate_plans rp JOIN room_types rt ON rt.id = rp.room_type_id WHERE rt.hotel_id = h.id) AS rates
         FROM hotels h WHERE h.id = $1 AND h.inventory_source = 'EXTRANET'`,
      [hotelId],
    );
    const hotel = rows[0];
    if (!hotel) throw new AppError('NOT_FOUND', 'Extranet hotel not found');
    const rooms = new Set<string>(hotel.rooms);
    const rates = new Set<string>(hotel.rates);
    for (const u of parsed.data.updates) {
      if (!rooms.has(u.roomTypeId)) throw new AppError('VALIDATION_ERROR', 'Room type does not belong to this hotel', { roomTypeId: u.roomTypeId });
      if (u.ratePlanId && !rates.has(`${u.ratePlanId}|${u.roomTypeId}`)) {
        throw new AppError('VALIDATION_ERROR', 'Rate plan does not belong to this room', { ratePlanId: u.ratePlanId });
      }
      if ((u.priceMinor !== undefined || u.minLos !== undefined || u.maxLos !== undefined || u.closedToArrival !== undefined || u.closedToDeparture !== undefined) && !u.ratePlanId) {
        throw new AppError('VALIDATION_ERROR', 'ratePlanId is required for price or restriction changes');
      }
    }
    const updates = parsed.data.updates.map((u) => ({ ...u, ...(u.priceMinor !== undefined ? { currency: hotel.currency.trim() } : {}) }));
    return applyAriUpdates(client, hotelId, updates, new Date());
  });

  res.json({ status: 'success', ...result });
});
