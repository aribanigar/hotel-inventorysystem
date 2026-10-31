/**
 * SOURCE 3 write side: PUT /api/v1/extranet/hotels/:hotelId/ari
 *
 * Ops/admin access with Bearer EXTRANET_ADMIN_TOKEN (scripts, bulk loads). Hotel staff
 * use the same logic through their own login at /api/v1/hotelier (see hotelier.ts).
 * Same tables, same upsert and same locks as the channel-manager webhook, so the Live
 * Ping treats every source identically.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { config } from '../../config.js';
import { withTransaction } from '../../db/pool.js';
import { audit } from '../../extranet/audit.js';
import { applyAriUpdates, touchesRatePlan, type AriApplyResult } from '../../inventory/ariUpdates.js';
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

export const ExtranetAriBody = z
  .object({
    updates: z
      .array(
        z
          .object({
            roomTypeId: Uuid,
            ratePlanId: Uuid.optional(),
            startDate: IsoDate,
            endDate: IsoDate,
            weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
            availability: z.number().int().min(0).max(1000).optional(),
            priceMinor: z.number().int().positive().max(100_000_000_00).optional(),
            stopSell: z.boolean().optional(),
            minLos: z.number().int().min(1).max(365).optional(),
            maxLos: z.number().int().min(1).max(365).nullable().optional(),
            closedToArrival: z.boolean().optional(),
            closedToDeparture: z.boolean().optional(),
            minStayThrough: z.number().int().min(1).max(365).optional(),
            maxStayThrough: z.number().int().min(1).max(365).nullable().optional(),
            minAdvanceDays: z.number().int().min(0).max(730).optional(),
            maxAdvanceDays: z.number().int().min(0).max(730).nullable().optional(),
            extraAdultMinor: z.number().int().min(0).max(100_000_00).optional(),
            extraChildMinor: z.number().int().min(0).max(100_000_00).optional(),
          })
          .strict()
          .refine((u) => u.endDate >= u.startDate && daysBetween(u.startDate, u.endDate) < 750, 'invalid date range'),
      )
      .min(1)
      .max(500),
  })
  .strict();

/**
 * Validates ownership of every room/rate id, then applies the updates and writes an
 * audit row, all in the caller's transaction.
 */
export async function applyExtranetAri(
  client: PoolClient,
  hotelId: string,
  body: unknown,
  actor: { userId: string | null; label: string },
): Promise<AriApplyResult> {
  const parsed = ExtranetAriBody.safeParse(body);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Invalid ARI payload', { issues: z.flattenError(parsed.error) });

  // Only EXTRANET hotels may be edited here; CM hotels are owned by their CM.
  const { rows } = await client.query(
    `SELECT h.currency, h.inventory_source,
            ARRAY(SELECT id::text FROM room_types WHERE hotel_id = h.id) AS rooms,
            ARRAY(SELECT rp.id::text || '|' || rp.room_type_id::text FROM rate_plans rp JOIN room_types rt ON rt.id = rp.room_type_id WHERE rt.hotel_id = h.id) AS rates,
            ARRAY(SELECT rp.id::text || '|' || rp.follow_parent_restrictions::text FROM rate_plans rp JOIN room_types rt ON rt.id = rp.room_type_id
                   WHERE rt.hotel_id = h.id AND rp.rate_mode = 'DERIVED') AS derived
       FROM hotels h WHERE h.id = $1`,
    [hotelId],
  );
  const hotel = rows[0];
  if (!hotel) throw new AppError('NOT_FOUND', 'Extranet hotel not found');
  if (hotel.inventory_source !== 'EXTRANET') {
    throw new AppError('CONFLICT', "This hotel's rooms and rates are managed by its channel manager or supplier", { source: hotel.inventory_source });
  }
  const rooms = new Set<string>(hotel.rooms);
  const rates = new Set<string>(hotel.rates);
  // Derived plans: price always follows the parent; restrictions too unless the plan opts out.
  const derived = new Map<string, boolean>((hotel.derived as string[]).map((x) => x.split('|') as [string, string]).map(([id, follow]) => [id, follow === 'true']));
  for (const u of parsed.data.updates) {
    if (!rooms.has(u.roomTypeId)) throw new AppError('VALIDATION_ERROR', 'Room type does not belong to this hotel', { roomTypeId: u.roomTypeId });
    if (u.ratePlanId && !rates.has(`${u.ratePlanId}|${u.roomTypeId}`)) {
      throw new AppError('VALIDATION_ERROR', 'Rate plan does not belong to this room', { ratePlanId: u.ratePlanId });
    }
    const priceish = u.priceMinor !== undefined || u.extraAdultMinor !== undefined || u.extraChildMinor !== undefined;
    const touchesRate = touchesRatePlan({ ...u, ratePlanId: u.ratePlanId ?? null }) || priceish;
    if (touchesRate && !u.ratePlanId && (priceish || u.minLos !== undefined || u.maxLos !== undefined || u.closedToArrival !== undefined ||
      u.closedToDeparture !== undefined || u.minStayThrough !== undefined || u.maxStayThrough !== undefined || u.minAdvanceDays !== undefined || u.maxAdvanceDays !== undefined)) {
      throw new AppError('VALIDATION_ERROR', 'ratePlanId is required for price or restriction changes');
    }
    if (u.ratePlanId && derived.has(u.ratePlanId)) {
      if (priceish) throw new AppError('VALIDATION_ERROR', 'This rate plan is derived: its prices follow the parent plan', { ratePlanId: u.ratePlanId });
      if (derived.get(u.ratePlanId) && touchesRatePlan(u)) {
        throw new AppError('VALIDATION_ERROR', 'This rate plan follows its parent plan for restrictions', { ratePlanId: u.ratePlanId });
      }
    }
  }

  const updates = parsed.data.updates.map((u) => ({ ...u, ...(u.priceMinor !== undefined ? { currency: hotel.currency.trim() } : {}) }));
  const result = await applyAriUpdates(client, hotelId, updates, new Date());

  await audit(client, {
    hotelId,
    userId: actor.userId,
    action: 'ARI_UPDATE',
    summary: `${actor.label} updated ${updates.length} range(s): ${describe(updates)}`,
    details: { updates, result },
  });
  return result;
}

function describe(updates: Array<z.infer<typeof ExtranetAriBody>['updates'][number]>): string {
  return updates
    .slice(0, 3)
    .map((u) => {
      const parts: string[] = [];
      if (u.availability !== undefined) parts.push(`${u.availability} room(s)`);
      if (u.priceMinor !== undefined) parts.push(`price ${(u.priceMinor / 100).toFixed(2)}`);
      if (u.stopSell !== undefined) parts.push(u.stopSell ? 'closed' : 'opened');
      if (u.minLos !== undefined) parts.push(`min ${u.minLos} nights`);
      if (u.minStayThrough !== undefined) parts.push(`min stay-through ${u.minStayThrough}`);
      if (u.closedToArrival !== undefined) parts.push(u.closedToArrival ? 'no check-ins' : 'check-ins open');
      if (u.closedToDeparture !== undefined) parts.push(u.closedToDeparture ? 'no check-outs' : 'check-outs open');
      if (u.minAdvanceDays !== undefined) parts.push(`book ${u.minAdvanceDays}+ days ahead`);
      if (u.extraAdultMinor !== undefined) parts.push(`extra adult ${(u.extraAdultMinor / 100).toFixed(2)}`);
      if (u.weekdays && u.weekdays.length < 7) parts.push(`on ${u.weekdays.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join('/')}`);
      const range = u.startDate === u.endDate ? u.startDate : `${u.startDate} to ${u.endDate}`;
      return `${range} ${parts.join(', ')}`.trim();
    })
    .join('; ')
    .concat(updates.length > 3 ? ` (+${updates.length - 3} more)` : '');
}

extranetRouter.put('/hotels/:hotelId/ari', requireAdmin, async (req, res) => {
  const { hotelId } = req.params;
  if (!isUuid(hotelId)) throw new AppError('VALIDATION_ERROR', 'Invalid hotel id');
  const result = await withTransaction((client) => applyExtranetAri(client, hotelId, req.body, { userId: null, label: 'Admin' }));
  res.json({ status: 'success', ...result });
});
