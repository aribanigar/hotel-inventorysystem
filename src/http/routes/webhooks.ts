/**
 * SOURCE 2: POST /api/v1/webhooks/channel-manager
 *
 * Channel managers push real-time availability, rate and restriction changes here.
 * The payload is JSON modelled on OTA_HotelAvailNotifRQ / OTA_HotelRateAmountNotifRQ
 * semantics (date ranges, delta fields, shared room availability) so STAAH or AxisRooms
 * can map their existing ARI feed to it directly.
 *
 * Example body:
 * {
 *   "requestId": "8f1c3a52-6a1e-4f7e-9b0e-2b7d9f0d7c11",   // unique per push (EchoToken)
 *   "timestamp": "2026-11-02T10:15:00Z",                   // when the CM generated it
 *   "hotelCode": "STAAH-GULMARG-01",
 *   "updates": [
 *     { "roomCode": "DLX", "startDate": "2026-12-20", "endDate": "2026-12-31", "availability": 4 },
 *     { "roomCode": "DLX", "ratePlanCode": "CP", "startDate": "2026-12-20", "endDate": "2026-12-31",
 *       "rate": { "amount": "8500.00", "currency": "INR" }, "minLos": 2, "closedToArrival": false }
 *   ]
 * }
 *
 * Response contract (fast, like SiteMinder's < 2 s guidance):
 *   200 { status: "success", ... }      applied
 *   200 { status: "duplicate", ... }    same requestId already applied: safe no-op
 *   401 UNAUTHORIZED
 *   400 VALIDATION_ERROR (bad payload or unmapped room/rate codes; nothing applied)
 *   404 NOT_FOUND (hotelCode not mapped to this partner)
 *   409 INVENTORY_BUSY (retry with backoff)
 */
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { withTransaction } from '../../db/pool.js';
import { applyAriUpdates, type AriUpdate } from '../../inventory/ariUpdates.js';
import { daysBetween, isIsoDate } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { decimalToMinor } from '../../lib/money.js';
import { channelAuth } from '../middleware/channelAuth.js';
import { rateLimit } from '../middleware/rateLimit.js';

const MAX_UPDATES = 500;
const MAX_RANGE_DAYS = 750; // SiteMinder's initial-load horizon

const IsoDate = z.string().refine(isIsoDate, 'must be a YYYY-MM-DD date');

const UpdateSchema = z
  .object({
    roomCode: z.string().min(1).max(64),
    ratePlanCode: z.string().min(1).max(64).optional(),
    startDate: IsoDate,
    endDate: IsoDate,
    /** Optional weekday filter, 0 = Sunday ... 6 = Saturday. */
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    availability: z.number().int().min(0).max(10_000).optional(),
    rate: z.object({ amount: z.union([z.string().max(32), z.number()]), currency: z.string().length(3) }).optional(),
    stopSell: z.boolean().optional(),
    minLos: z.number().int().min(1).max(365).optional(),
    maxLos: z.number().int().min(1).max(365).nullable().optional(),
    closedToArrival: z.boolean().optional(),
    closedToDeparture: z.boolean().optional(),
    minStayThrough: z.number().int().min(1).max(365).optional(),
    maxStayThrough: z.number().int().min(1).max(365).nullable().optional(),
    minAdvanceDays: z.number().int().min(0).max(730).optional(),
    maxAdvanceDays: z.number().int().min(0).max(730).nullable().optional(),
    extraAdult: z.union([z.string().max(32), z.number()]).optional(),
    extraChild: z.union([z.string().max(32), z.number()]).optional(),
  })
  .strict()
  .superRefine((u, ctx) => {
    if (u.endDate < u.startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'endDate before startDate' });
    else if (daysBetween(u.startDate, u.endDate) + 1 > MAX_RANGE_DAYS) {
      ctx.addIssue({ code: 'custom', path: ['endDate'], message: `range longer than ${MAX_RANGE_DAYS} days` });
    }
    const rateFields =
      u.rate || u.minLos !== undefined || u.maxLos !== undefined || u.closedToArrival !== undefined || u.closedToDeparture !== undefined ||
      u.minStayThrough !== undefined || u.maxStayThrough !== undefined || u.minAdvanceDays !== undefined || u.maxAdvanceDays !== undefined ||
      u.extraAdult !== undefined || u.extraChild !== undefined;
    if (rateFields && !u.ratePlanCode) ctx.addIssue({ code: 'custom', path: ['ratePlanCode'], message: 'required for rate or restriction updates' });
    if (!rateFields && u.availability === undefined && u.stopSell === undefined) {
      ctx.addIssue({ code: 'custom', message: 'update carries no changes' });
    }
    if (u.minLos !== undefined && u.maxLos != null && u.maxLos < u.minLos) {
      ctx.addIssue({ code: 'custom', path: ['maxLos'], message: 'maxLos below minLos' });
    }
  });

const PushSchema = z
  .object({
    requestId: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
    timestamp: z.iso.datetime({ offset: true }),
    hotelCode: z.string().min(1).max(64),
    updates: z.array(UpdateSchema).min(1).max(MAX_UPDATES),
  })
  .strict();

export const webhooksRouter = Router();

webhooksRouter.post(
  '/channel-manager',
  // Per-IP limit before we even touch the DB. A CM pushing a 750-day load uses large
  // batches, not thousands of requests per minute.
  rateLimit({ windowMs: 60_000, max: 600 }),
  // Keep the raw bytes: the HMAC signature is computed over them, not over re-serialised JSON.
  express.raw({ type: ['application/json', 'application/*+json'], limit: '2mb' }),
  (req: Request, _res: Response, next) => {
    req.rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    next();
  },
  channelAuth,
  async (req: Request, res: Response) => {
    const partner = req.channelPartner!;

    // ---- 1. Parse + validate ------------------------------------------------
    let body: unknown;
    try {
      body = JSON.parse(req.rawBody!.toString('utf8'));
    } catch {
      throw new AppError('VALIDATION_ERROR', 'Body must be valid JSON');
    }
    const parsed = PushSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Invalid ARI payload', { issues: z.flattenError(parsed.error) });
    }
    const push = parsed.data;

    const sourceTs = new Date(push.timestamp);
    // A timestamp far in the future would make that row immune to every later push
    // (the stale guard would reject them all). Refuse it outright.
    if (sourceTs.getTime() > Date.now() + config.WEBHOOK_MAX_SKEW_SECONDS * 1000) {
      throw new AppError('VALIDATION_ERROR', 'timestamp is in the future', { timestamp: push.timestamp });
    }

    // Convert prices up front so a bad amount rejects the whole batch before any write.
    const priceErrors: string[] = [];
    // Extra-guest amounts may be 0 (decimalToMinor rejects 0), so parse them separately.
    const extra = (v: string | number | undefined, field: string) => {
      if (v === undefined) return undefined;
      if (v === 0 || v === '0' || v === '0.00') return 0;
      const m = decimalToMinor(v);
      if (m === null) priceErrors.push(field);
      return m ?? undefined;
    };
    const extras = push.updates.map((u, i) => ({ adult: extra(u.extraAdult, `updates[${i}].extraAdult`), child: extra(u.extraChild, `updates[${i}].extraChild`) }));
    const prices = push.updates.map((u, i) => {
      if (!u.rate) return undefined;
      const minor = decimalToMinor(u.rate.amount);
      if (minor === null) priceErrors.push(`updates[${i}].rate.amount`);
      return minor ?? undefined;
    });
    if (priceErrors.length) throw new AppError('VALIDATION_ERROR', 'Invalid rate amount', { fields: priceErrors });

    // ---- 2. One transaction: dedupe, map codes, upsert, log -------------------
    const outcome = await withTransaction(
      async (client) => {
        // Idempotency. If the CM retries a push we already applied (e.g. our 200 was
        // lost in transit), the unique (partner_id, request_id) makes this a no-op.
        // A concurrent duplicate blocks here until the first commits, then no-ops.
        const ins = await client.query(
          `INSERT INTO webhook_events (partner_id, request_id, payload)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (partner_id, request_id) DO NOTHING
           RETURNING id`,
          [partner.id, push.requestId, JSON.stringify(push)],
        );
        if (ins.rowCount === 0) return { duplicate: true as const };
        const eventId = ins.rows[0].id as string;

        // The hotel must belong to THIS partner. A STAAH key can never write to an
        // AxisRooms hotel or to an extranet houseboat.
        const hotel = await client.query(
          `SELECT id FROM hotels
            WHERE channel_partner_id = $1 AND cm_hotel_code = $2
              AND inventory_source = 'CHANNEL_MANAGER' AND is_active`,
          [partner.id, push.hotelCode],
        );
        if (!hotel.rows[0]) throw new AppError('NOT_FOUND', 'Unknown hotelCode for this partner', { hotelCode: push.hotelCode });
        const hotelId = hotel.rows[0].id as string;

        // Resolve every room/rate code in one round trip.
        const { rows: mapRows } = await client.query(
          `SELECT rt.cm_room_code, rt.id AS room_type_id, rp.cm_rate_code, rp.id AS rate_plan_id
             FROM room_types rt
             LEFT JOIN rate_plans rp ON rp.room_type_id = rt.id AND rp.is_active AND rp.cm_rate_code IS NOT NULL
            WHERE rt.hotel_id = $1 AND rt.is_active AND rt.cm_room_code IS NOT NULL`,
          [hotelId],
        );
        const roomIds = new Map<string, string>();
        const rateIds = new Map<string, string>();
        for (const r of mapRows) {
          roomIds.set(r.cm_room_code, r.room_type_id);
          if (r.cm_rate_code) rateIds.set(`${r.cm_room_code}|${r.cm_rate_code}`, r.rate_plan_id);
        }

        // All-or-nothing: an unmapped code rejects the batch, so the CM sees a clear
        // error and we never end up with half a push applied.
        const unknown: string[] = [];
        const updates: AriUpdate[] = push.updates.map((u, i) => {
          const roomTypeId = roomIds.get(u.roomCode);
          const ratePlanId = u.ratePlanCode ? rateIds.get(`${u.roomCode}|${u.ratePlanCode}`) : undefined;
          if (!roomTypeId) unknown.push(`room ${u.roomCode}`);
          if (u.ratePlanCode && !ratePlanId) unknown.push(`rate ${u.roomCode}/${u.ratePlanCode}`);
          return {
            roomTypeId: roomTypeId ?? '',
            ratePlanId: ratePlanId ?? null,
            startDate: u.startDate,
            endDate: u.endDate,
            ...(u.availability !== undefined ? { availability: u.availability } : {}),
            ...(prices[i] !== undefined ? { priceMinor: prices[i], currency: u.rate!.currency.toUpperCase() } : {}),
            ...(u.stopSell !== undefined ? { stopSell: u.stopSell } : {}),
            ...(u.minLos !== undefined ? { minLos: u.minLos } : {}),
            ...(u.maxLos !== undefined ? { maxLos: u.maxLos } : {}),
            ...(u.closedToArrival !== undefined ? { closedToArrival: u.closedToArrival } : {}),
            ...(u.closedToDeparture !== undefined ? { closedToDeparture: u.closedToDeparture } : {}),
            ...(u.weekdays ? { weekdays: u.weekdays } : {}),
            ...(u.minStayThrough !== undefined ? { minStayThrough: u.minStayThrough } : {}),
            ...(u.maxStayThrough !== undefined ? { maxStayThrough: u.maxStayThrough } : {}),
            ...(u.minAdvanceDays !== undefined ? { minAdvanceDays: u.minAdvanceDays } : {}),
            ...(u.maxAdvanceDays !== undefined ? { maxAdvanceDays: u.maxAdvanceDays } : {}),
            ...(extras[i]!.adult !== undefined ? { extraAdultMinor: extras[i]!.adult } : {}),
            ...(extras[i]!.child !== undefined ? { extraChildMinor: extras[i]!.child } : {}),
          };
        });
        if (unknown.length) {
          throw new AppError('VALIDATION_ERROR', 'Unmapped room or rate codes', { unknown: [...new Set(unknown)] });
        }

        const applied = await applyAriUpdates(client, hotelId, updates, sourceTs);
        await client.query('UPDATE webhook_events SET result = $2::jsonb WHERE id = $1', [eventId, JSON.stringify(applied)]);
        return { duplicate: false as const, hotelId, applied };
      },
      // Webhooks may wait a little longer for locks than checkout, but still bounded.
      { lockTimeoutMs: 5_000, statementTimeoutMs: 15_000 },
    );

    if (outcome.duplicate) {
      res.status(200).json({ status: 'duplicate', requestId: push.requestId });
      return;
    }
    logger.info({ partner: partner.code, requestId: push.requestId, hotelCode: push.hotelCode, ...outcome.applied }, 'ARI push applied');
    res.status(200).json({ status: 'success', requestId: push.requestId, ...outcome.applied });
  },
);
