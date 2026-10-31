/**
 * Hotelier extranet API (used by the web app at /extranet). Session cookie auth.
 *
 *   POST   /api/v1/hotelier/session                     sign in
 *   DELETE /api/v1/hotelier/session                     sign out
 *   GET    /api/v1/hotelier/me                          user + hotels + roles
 *   GET    /api/v1/hotelier/hotels/:hotelId/calendar    ?from=&days=        (any role)
 *   PUT    /api/v1/hotelier/hotels/:hotelId/ari         rooms/prices/close  (manager+)
 *   GET    /api/v1/hotelier/hotels/:hotelId/reservations ?from=&to=         (any role)
 *   POST   /api/v1/hotelier/hotels/:hotelId/reservations  offline sale      (any role)
 *   POST   /api/v1/hotelier/hotels/:hotelId/reservations/:id/status         (any role)
 *   GET    /api/v1/hotelier/hotels/:hotelId/activity    audit trail         (manager+)
 */
import express, { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { pool, withTransaction } from '../../db/pool.js';
import {
  channexCatalog, channexChannelsUrl, channexFullSync, channexStatus, connectChannex, createMissingInChannex, disconnectChannex,
  retryChannexBookings, saveChannexMapping,
} from '../../channels/channex/setup.js';
import { listAudit } from '../../extranet/audit.js';
import { clearSessionCookie, login, logout, readCookie, requireHotelRole, requireSession, SESSION_COOKIE, setSessionCookie } from '../../extranet/auth.js';
import { getCalendar } from '../../extranet/calendar.js';
import { changeReservationStatus, createOfflineReservation, listReservations } from '../../extranet/reservations.js';
import {
  channelHealth, connectQloCm, createRoomType, disconnectQloCm, fullSync, getSetup, resetAvailability, retryFailed, saveRatePlan,
  toCsv, updateRoomType, updateSettings,
} from '../../extranet/setup.js';
import { isUuid } from '../../inventory/catalog.js';
import { addDays, isIsoDate, todayIn } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { applyExtranetAri } from './extranet.js';

export const hotelierRouter = Router();
hotelierRouter.use(express.json({ limit: '200kb' }));
hotelierRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// ---- Auth -------------------------------------------------------------------
const LoginBody = z.object({ email: z.email().max(254), password: z.string().min(1).max(200) }).strict();

hotelierRouter.post('/session', rateLimit({ windowMs: 60_000, max: config.LOGIN_RATE_LIMIT }), async (req, res) => {
  if (req.get('x-extranet') !== '1') throw new AppError('UNAUTHORIZED', 'Missing request header');
  const body = LoginBody.safeParse(req.body);
  if (!body.success) throw new AppError('VALIDATION_ERROR', 'Enter your email and password');
  const s = await login(body.data.email, body.data.password, { ip: req.ip, userAgent: req.get('user-agent') });
  setSessionCookie(res, s.token, s.expiresAt);
  res.json({ user: s.user, expiresAt: s.expiresAt });
});

hotelierRouter.delete('/session', async (req, res) => {
  await logout(readCookie(req, SESSION_COOKIE));
  clearSessionCookie(res);
  res.json({ ok: true });
});

hotelierRouter.use(requireSession);

hotelierRouter.get('/me', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT h.id, h.name, h.inventory_source AS source, h.timezone, a.role
       FROM hotel_user_access a JOIN hotels h ON h.id = a.hotel_id
      WHERE a.user_id = $1 AND h.is_active ORDER BY h.name`,
    [req.hotelUser!.id],
  );
  res.json({ user: req.hotelUser, hotels: rows.map((h) => ({ ...h, today: todayIn(h.timezone) })) });
});

// ---- Per hotel ---------------------------------------------------------------
hotelierRouter.param('hotelId', (_req, _res, next, id) => (isUuid(id) ? next() : next(new AppError('NOT_FOUND', 'Hotel not found'))));

hotelierRouter.get('/hotels/:hotelId/calendar', requireHotelRole('frontdesk'), async (req, res) => {
  const from = String(req.query.from ?? '');
  const days = Number(req.query.days ?? 14);
  res.json(await getCalendar(req.params.hotelId as string, from, days));
});

hotelierRouter.put('/hotels/:hotelId/ari', requireHotelRole('manager'), async (req, res) => {
  const user = req.hotelUser!;
  const result = await withTransaction((client) => applyExtranetAri(client, req.params.hotelId as string, req.body, { userId: user.id, label: user.name }));
  res.json({ status: 'success', ...result });
});

hotelierRouter.get('/hotels/:hotelId/reservations', requireHotelRole('frontdesk'), async (req, res) => {
  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');
  if (!isIsoDate(from) || !isIsoDate(to) || to < from || to > addDays(from, 370)) {
    throw new AppError('VALIDATION_ERROR', 'from/to must be YYYY-MM-DD, at most a year apart');
  }
  res.json({ reservations: await listReservations(req.params.hotelId as string, from, to) });
});

hotelierRouter.post('/hotels/:hotelId/reservations', requireHotelRole('frontdesk'), async (req, res) => {
  res.status(201).json(await createOfflineReservation(req.params.hotelId as string, req.hotelUser!.id, req.body));
});

const StatusBody = z
  .object({ status: z.enum(['CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW']), remark: z.string().max(500).optional() })
  .strict();

hotelierRouter.post('/hotels/:hotelId/reservations/:reservationId/status', requireHotelRole('frontdesk'), async (req, res) => {
  const id = req.params.reservationId as string;
  if (!isUuid(id)) throw new AppError('NOT_FOUND', 'Reservation not found');
  const body = StatusBody.safeParse(req.body);
  if (!body.success) throw new AppError('VALIDATION_ERROR', 'Invalid status');
  res.json(await changeReservationStatus(req.params.hotelId as string, req.hotelUser!.id, id, body.data.status, body.data.remark));
});

// ---- Setup: room types, rate plans, settings ---------------------------------
const H = (req: express.Request) => req.params.hotelId as string;
const U = (req: express.Request) => req.hotelUser!.id;
const id = (v: unknown) => {
  if (!isUuid(v)) throw new AppError('NOT_FOUND', 'Not found');
  return v;
};

hotelierRouter.get('/hotels/:hotelId/setup', requireHotelRole('frontdesk'), async (req, res) => res.json(await getSetup(H(req))));
hotelierRouter.post('/hotels/:hotelId/room-types', requireHotelRole('manager'), async (req, res) => res.status(201).json(await createRoomType(H(req), U(req), req.body)));
hotelierRouter.put('/hotels/:hotelId/room-types/:roomTypeId', requireHotelRole('manager'), async (req, res) =>
  res.json(await updateRoomType(H(req), U(req), id(req.params.roomTypeId), req.body)),
);
hotelierRouter.post('/hotels/:hotelId/rate-plans', requireHotelRole('manager'), async (req, res) => res.status(201).json(await saveRatePlan(H(req), U(req), null, req.body)));
hotelierRouter.put('/hotels/:hotelId/rate-plans/:ratePlanId', requireHotelRole('manager'), async (req, res) =>
  res.json(await saveRatePlan(H(req), U(req), id(req.params.ratePlanId), req.body)),
);
hotelierRouter.put('/hotels/:hotelId/settings', requireHotelRole('owner'), async (req, res) => res.json(await updateSettings(H(req), U(req), req.body)));
hotelierRouter.post('/hotels/:hotelId/reset-availability', requireHotelRole('manager'), async (req, res) =>
  res.json(await resetAvailability(H(req), U(req), req.body?.roomTypeId ? id(req.body.roomTypeId) : undefined)),
);

// ---- Channels ------------------------------------------------------------------
hotelierRouter.get('/hotels/:hotelId/channels', requireHotelRole('manager'), async (req, res) => res.json(await channelHealth(H(req))));
hotelierRouter.post('/hotels/:hotelId/channels/sync', requireHotelRole('manager'), rateLimit({ windowMs: 60_000, max: 3 }), async (req, res) =>
  res.json(await fullSync(H(req), U(req))),
);
hotelierRouter.post('/hotels/:hotelId/channels/retry', requireHotelRole('manager'), async (req, res) => res.json(await retryFailed(H(req), U(req))));
hotelierRouter.post('/hotels/:hotelId/channels/qloapps', requireHotelRole('owner'), async (req, res) => {
  const r = await connectQloCm(H(req), U(req), req.body);
  // What the owner pastes into the CM (PMS > General Settings).
  res.json({ ...r, webserviceUrl: `${req.protocol}://${req.get('host')}` });
});
hotelierRouter.delete('/hotels/:hotelId/channels/qloapps', requireHotelRole('owner'), async (req, res) => res.json(await disconnectQloCm(H(req), U(req))));

// Channex (direct OTA connectivity)
const cxLimit = () => rateLimit({ windowMs: 60_000, max: 3, key: (req) => `${req.ip}:${req.params.hotelId}:${req.path}` });
hotelierRouter.get('/hotels/:hotelId/channels/channex', requireHotelRole('manager'), async (req, res) => res.json(await channexStatus(H(req))));
hotelierRouter.post('/hotels/:hotelId/channels/channex', requireHotelRole('owner'), cxLimit(), async (req, res) => res.json(await connectChannex(H(req), U(req), req.body)));
hotelierRouter.delete('/hotels/:hotelId/channels/channex', requireHotelRole('owner'), async (req, res) => res.json(await disconnectChannex(H(req), U(req))));
hotelierRouter.get('/hotels/:hotelId/channels/channex/catalog', requireHotelRole('owner'), async (req, res) => res.json(await channexCatalog(H(req))));
hotelierRouter.put('/hotels/:hotelId/channels/channex/mapping', requireHotelRole('owner'), async (req, res) => res.json(await saveChannexMapping(H(req), U(req), req.body)));
hotelierRouter.post('/hotels/:hotelId/channels/channex/create-missing', requireHotelRole('owner'), cxLimit(), async (req, res) =>
  res.json(await createMissingInChannex(H(req), U(req))),
);
hotelierRouter.post('/hotels/:hotelId/channels/channex/full-sync', requireHotelRole('manager'), cxLimit(), async (req, res) => res.json(await channexFullSync(H(req), U(req))));
hotelierRouter.post('/hotels/:hotelId/channels/channex/ota-link', requireHotelRole('owner'), cxLimit(), async (req, res) =>
  res.json(await channexChannelsUrl(H(req), req.hotelUser!.name ?? req.hotelUser!.email ?? 'owner')),
);
hotelierRouter.post('/hotels/:hotelId/channels/channex/retry-bookings', requireHotelRole('manager'), cxLimit(), async (req, res) =>
  res.json(await retryChannexBookings(H(req))),
);

// ---- Export --------------------------------------------------------------------
hotelierRouter.get('/hotels/:hotelId/reservations.csv', requireHotelRole('frontdesk'), async (req, res) => {
  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');
  if (!isIsoDate(from) || !isIsoDate(to) || to < from || to > addDays(from, 370)) throw new AppError('VALIDATION_ERROR', 'Invalid dates');
  const rows = await listReservations(H(req), from, to);
  const csv = toCsv(rows, [
    ['reference', 'Reference'], ['channel', 'Channel'], ['source', 'Source'], ['source_detail', 'Source detail'], ['status', 'Status'],
    ['guest_name', 'Guest'], ['guest_phone', 'Phone'], ['guest_email', 'Email'], ['room_name', 'Room type'], ['rooms', 'Rooms'],
    ['check_in', 'Check-in'], ['check_out', 'Check-out'], ['adults', 'Adults'], ['children', 'Children'], ['amount_minor', 'Amount (paise)'],
    ['currency', 'Currency'], ['overbooked', 'Overbooked'], ['created_at', 'Created'], ['notes', 'Notes'],
  ]);
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="bookings-${from}-to-${to}.csv"`);
  res.send('\ufeff' + csv); // BOM so Excel opens UTF-8 names correctly
});

hotelierRouter.get('/hotels/:hotelId/activity', requireHotelRole('manager'), async (req, res) => {
  res.json({ activity: await listAudit(pool, req.params.hotelId as string, Number(req.query.limit ?? 50)) });
});
