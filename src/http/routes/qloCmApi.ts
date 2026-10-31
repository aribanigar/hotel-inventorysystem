/**
 * QloApps-Channel-Manager-compatible PMS API, so the hosted QloApps Channel Manager can
 * connect to this system exactly as it connects to a QloApps PMS.
 *
 * In the CM: PMS > General Settings
 *   Webservice URL : https://<this server>          (it calls /api/cm_api/...)
 *   Webservice key : the key shown once when the account was created
 *
 *   GET  /api/cm_api/test_connection
 *   GET  /api/cm_api/properties
 *   GET  /api/cm_api/room_types?filter[id_property]=N
 *   GET  /api/cm_api/ari?filter[id_property]=N[&filter[id_room_type]=N&filter[date_from]=&filter[date_to]=]
 *   GET  /api/cm_api/bookings?filter[id_property]=N
 *   POST /api/cm_api/booking_notification            (JSON body, any content type)
 *
 * Auth like the PrestaShop webservice: HTTP Basic with the key as the username, or
 * ?ws_key=. The key is compared by sha256 hash in constant time.
 */
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { buildQloAri, defaultAriWindow, formatBooking, processCmBooking, QLO_COMPAT_VERSION } from '../../channels/qloappsCm.js';
import { pool } from '../../db/pool.js';
import { safeEqual, sha256Hex } from '../../lib/crypto.js';
import { addDays, daysBetween, isIsoDate } from '../../lib/dates.js';
import { AppError, isAppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { rateLimit } from '../middleware/rateLimit.js';

declare module 'express-serve-static-core' {
  interface Request {
    cmAccountId?: string;
  }
}

export const qloCmApiRouter = Router();
qloCmApiRouter.use(rateLimit({ windowMs: 60_000, max: 600 }));

function wsKeyFrom(req: Request): string | null {
  const q = req.query.ws_key;
  if (typeof q === 'string' && q) return q;
  const auth = req.get('authorization') ?? '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    return decoded.split(':')[0] || null;
  }
  return null;
}

qloCmApiRouter.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const key = wsKeyFrom(req);
    if (!key || key.length > 200) return deny(res);
    const hash = sha256Hex(key);
    const { rows } = await pool.query('SELECT id, ws_key_hash FROM cm_accounts WHERE ws_key_hash = $1', [hash]);
    if (!rows[0] || !safeEqual(rows[0].ws_key_hash, hash)) return deny(res);
    req.cmAccountId = rows[0].id;
    next();
  } catch (err) {
    next(err);
  }
});

function deny(res: Response) {
  res.status(401).set('WWW-Authenticate', 'Basic realm="Webservice"').json({ success: false, error: 'Invalid authentication key' });
}

/** `filter[id_property]=3` arrives either nested or as a literal key, depending on the parser. */
function filter(req: Request, name: string): string | undefined {
  const nested = (req.query.filter as Record<string, unknown> | undefined)?.[name];
  const flat = req.query[`filter[${name}]`];
  const v = nested ?? flat;
  if (Array.isArray(v)) return String(v[0]);
  if (v && typeof v === 'object') return String(Object.values(v)[0]); // filter[check_in][gte]=...
  return v === undefined ? undefined : String(v);
}

async function propertyOf(req: Request) {
  const id = Number(filter(req, 'id_property'));
  if (!Number.isInteger(id) || id <= 0) throw new AppError('VALIDATION_ERROR', 'id_property is required!');
  const { rows } = await pool.query('SELECT id, pms_id, timezone FROM hotels WHERE pms_id = $1 AND cm_account_id = $2 AND is_active', [id, req.cmAccountId]);
  if (!rows[0]) throw new AppError('NOT_FOUND', 'Property not found.');
  return rows[0];
}

qloCmApiRouter.get('/test_connection', (_req, res) => {
  res.json({ success: true, QLO_VERSION: QLO_COMPAT_VERSION });
});

qloCmApiRouter.get('/properties', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT pms_id, name, currency, timezone FROM hotels WHERE cm_account_id = $1 AND is_active AND inventory_source = 'EXTRANET' ORDER BY pms_id`,
    [req.cmAccountId],
  );
  res.json({
    success: true,
    data: rows.map((h) => ({
      id: h.pms_id,
      id_category: h.pms_id,
      name: h.name,
      property_type: 'hotel',
      description: '',
      email: '',
      phone: '',
      currency: h.currency.trim(),
      country_code: 'IN',
      state: '',
      city: '',
      address1: '',
      address2: '',
      zip_code: '',
      latitude: '',
      longitude: '',
      timezone: h.timezone,
    })),
  });
});

qloCmApiRouter.get('/room_types', async (req, res) => {
  const hotel = await propertyOf(req);
  const { rows } = await pool.query(
    `SELECT pms_id, name, total_rooms, base_occupancy, max_adults, max_children, max_infants
       FROM room_types WHERE hotel_id = $1 AND is_active ORDER BY pms_id`,
    [hotel.id],
  );
  res.json({
    success: true,
    data: rows.map((r) => ({
      id: r.pms_id,
      id_product: r.pms_id,
      name: r.name,
      total_rooms: r.total_rooms,
      base_occupancy: r.base_occupancy,
      max_adults: r.max_adults,
      max_children: r.max_children,
      max_infants: r.max_infants,
    })),
  });
});

qloCmApiRouter.get('/ari', async (req, res) => {
  const hotel = await propertyOf(req);
  const win = defaultAriWindow(hotel.timezone);
  const from = filter(req, 'date_from')?.slice(0, 10) ?? win.from;
  let to = filter(req, 'date_to')?.slice(0, 10) ?? win.to;
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) throw new AppError('VALIDATION_ERROR', 'Invalid date range');
  if (daysBetween(from, to) > 749) to = addDays(from, 749);
  let roomTypeId: string | null = null;
  const rtPms = filter(req, 'id_room_type');
  if (rtPms) {
    const rt = (await pool.query('SELECT id FROM room_types WHERE pms_id = $1 AND hotel_id = $2', [Number(rtPms), hotel.id])).rows[0];
    if (!rt) throw new AppError('NOT_FOUND', 'Room type not found.');
    roomTypeId = rt.id;
  }
  const payload = await buildQloAri(pool, hotel.id, [{ roomTypeId, from, to }]);
  res.json({ success: true, data: payload ? [payload] : [] });
});

qloCmApiRouter.get('/bookings', async (req, res) => {
  const hotel = await propertyOf(req);
  const { rows } = await pool.query(
    `SELECT r.*, rt.pms_id AS room_pms_id FROM reservations r JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.hotel_id = $1 AND r.check_out >= (now() AT TIME ZONE $2)::date
      ORDER BY r.created_at DESC LIMIT 500`,
    [hotel.id, hotel.timezone],
  );
  // One entry per booking: CM bookings grouped by their CM id, others by reservation.
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const r of rows) {
    const k = r.cm_booking_id ? `cm:${r.cm_booking_id}` : `r:${r.id}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  res.json({ success: true, data: [...groups.values()].map((g) => formatBooking(g, hotel.pms_id)) });
});

qloCmApiRouter.post('/booking_notification', express.text({ type: () => true, limit: '1mb' }), async (req, res) => {
  let body: unknown;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    res.status(400).json({ success: false, error: 'Body must be JSON' });
    return;
  }
  if (!body || typeof body !== 'object') {
    res.status(400).json({ success: false, error: 'Body must be JSON' });
    return;
  }
  try {
    const data = await processCmBooking(req.cmAccountId!, body as never);
    res.json({ data });
  } catch (err) {
    if (isAppError(err) && err.status < 500 && err.code !== 'INVENTORY_BUSY') {
      // The CM's error shape. Business errors are answered 200 like the stock connector.
      res.json({ success: false, error: err.message });
      return;
    }
    logger.error({ err }, 'cm booking_notification failed');
    throw err; // 5xx -> the CM retries
  }
});

// Unknown resources answer in the CM's error shape.
qloCmApiRouter.use((_req, res) => {
  res.status(404).json({ success: false, error: 'This HTTP method is not allowed' });
});
