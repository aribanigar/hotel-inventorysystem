/**
 * Checkout endpoints used by the frontend.
 *
 *   POST /api/v1/checkout/live-ping            "Proceed to Pay" -> hold + payment order
 *   GET  /api/v1/checkout/holds/:token         countdown + status polling
 *   POST /api/v1/checkout/holds/:token/release user left checkout -> free the room now
 *
 * Frontend handling of live-ping errors (error.code):
 *   PRICE_CHANGED  -> show details.liveTotalMinor, ask the user to accept the new price
 *   SOLD_OUT       -> "Just sold out", suggest other rooms/dates
 *   RESTRICTED     -> show details.reason (e.g. MIN_LOS: "minimum 2 nights")
 *   INVENTORY_BUSY / SUPPLIER_TIMEOUT / SUPPLIER_UNAVAILABLE -> retryable: true, offer "Try again"
 */
import { Router } from 'express';
import { config } from '../../config.js';
import { executeLivePingCheck } from '../../engine/livePing.js';
import { getHoldByToken, releaseHold } from '../../engine/holds.js';
import { AppError } from '../../lib/errors.js';
import { rateLimit } from '../middleware/rateLimit.js';

export const checkoutRouter = Router();

const TOKEN = /^pbt_[A-Za-z0-9_-]{32}$/;

checkoutRouter.post('/live-ping', rateLimit({ windowMs: 60_000, max: config.LIVE_PING_RATE_LIMIT }), async (req, res) => {
  // Abort the supplier call if the shopper closes the tab mid-check.
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  const idempotencyKey = req.get('idempotency-key') ?? req.body?.idempotencyKey;
  const result = await executeLivePingCheck({ ...req.body, ...(idempotencyKey ? { idempotencyKey } : {}) }, { signal: ac.signal });
  res.status(201).json(result);
});

checkoutRouter.get('/holds/:token', async (req, res) => {
  if (!TOKEN.test(req.params.token)) throw new AppError('HOLD_NOT_FOUND', 'Booking session not found');
  res.setHeader('Cache-Control', 'no-store');
  res.json(await getHoldByToken(req.params.token));
});

checkoutRouter.post('/holds/:token/release', async (req, res) => {
  if (!TOKEN.test(req.params.token)) throw new AppError('HOLD_NOT_FOUND', 'Booking session not found');
  const released = await releaseHold({ token: req.params.token }, 'RELEASED', 'released by customer');
  res.json({ released });
});
