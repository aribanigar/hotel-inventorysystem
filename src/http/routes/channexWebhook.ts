/**
 * POST /api/v1/channex/webhook
 *
 * Channex calls this on booking events (event mask: booking, booking_unmapped_room,
 * booking_unmapped_rate, non_acked_booking, sync_error, disconnect_channel ...).
 *
 * Security (either or both, at least one must be configured):
 *   - X-Channex-Webhook-Secret header equal to CHANNEX_WEBHOOK_SECRET (set in the
 *     webhook's `headers` in Channex);
 *   - HMAC-SHA256 of "<x-hmac-timestamp>.<raw body>" with CHANNEX_WEBHOOK_HMAC_SECRET,
 *     compared in constant time against every signature in x-hmac-signature-256
 *     (two during key rotation), timestamp within WEBHOOK_MAX_SKEW_SECONDS.
 *
 * The body is never trusted for booking data: a booking event only triggers a pull of
 * the revisions feed, which reads the booking from Channex's API and acknowledges it
 * after it is saved. We answer 200 at once (Channex retries 5xx for ~24 h).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import { config } from '../../config.js';
import { pullChannexBookings } from '../../channels/channex/bookings.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { rateLimit } from '../middleware/rateLimit.js';

export const channexWebhookRouter = Router();

const safeEqual = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

export function verifyChannexWebhook(headers: Record<string, string | undefined>, raw: Buffer, nowS = Date.now() / 1000): boolean {
  const shared = config.CHANNEX_WEBHOOK_SECRET;
  const hmacSecret = config.CHANNEX_WEBHOOK_HMAC_SECRET;
  if (!shared && !hmacSecret) return false; // refuse until one is configured
  if (shared) {
    const got = headers['x-channex-webhook-secret'] ?? '';
    if (!safeEqual(Buffer.from(got), Buffer.from(shared))) return false;
  }
  if (hmacSecret) {
    const ts = headers['x-hmac-timestamp'] ?? '';
    if (!/^\d{9,12}$/.test(ts) || Math.abs(nowS - Number(ts)) > config.WEBHOOK_MAX_SKEW_SECONDS) return false;
    const expected = createHmac('sha256', hmacSecret).update(`${ts}.`).update(raw).digest();
    const sigs = (headers['x-hmac-signature-256'] ?? '').split(',').map((s) => s.trim()).filter((s) => /^[0-9a-f]{64}$/.test(s));
    if (!sigs.some((s) => safeEqual(Buffer.from(s, 'hex'), expected))) return false;
  }
  return true;
}

const BOOKING_EVENTS = new Set(['booking', 'booking_new', 'booking_modification', 'booking_cancellation', 'non_acked_booking']);
const ALERT_EVENTS = new Set(['booking_unmapped_room', 'booking_unmapped_rate', 'sync_error', 'rate_error', 'disconnect_channel', 'disconnect_listing']);

channexWebhookRouter.post(
  '/webhook',
  rateLimit({ windowMs: 60_000, max: 600 }),
  express.raw({ type: () => true, limit: '1mb' }),
  (req: Request, res: Response) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const headers = {
      'x-channex-webhook-secret': req.get('x-channex-webhook-secret'),
      'x-hmac-timestamp': req.get('x-hmac-timestamp'),
      'x-hmac-signature-256': req.get('x-hmac-signature-256'),
    };
    if (!verifyChannexWebhook(headers, raw)) throw new AppError('UNAUTHORIZED', 'Invalid webhook credentials');

    let body: { event?: string; property_id?: string; payload?: unknown };
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new AppError('VALIDATION_ERROR', 'Body must be valid JSON');
    }
    const event = String(body.event ?? '');
    if (BOOKING_EVENTS.has(event)) {
      // Fire and forget; the feed pull is idempotent and also runs on a timer.
      void pullChannexBookings().catch((err) => logger.warn({ err }, 'Channex pull after webhook failed'));
    } else if (ALERT_EVENTS.has(event)) {
      logger.error({ event, propertyId: body.property_id, payload: body.payload }, 'ALERT: Channex reported a channel problem');
    } else {
      logger.debug({ event, propertyId: body.property_id }, 'Channex webhook ignored');
    }
    res.json({ ok: true });
  },
);
