/**
 * Payment confirmation.
 *
 *   POST /api/v1/payments/razorpay/verify   client callback after Razorpay Checkout
 *   POST /api/v1/payments/razorpay/webhook  server-to-server (payment.captured / order.paid)
 *   POST /api/v1/payments/mock/confirm      dev/test only
 *
 * Configure the Razorpay webhook too, not just the client callback: if the shopper's
 * phone drops signal right after paying, only the webhook will ever reach us.
 */
import express, { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { confirmPayment } from '../../engine/holds.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { verifyRazorpayCheckoutSignature, verifyRazorpayWebhookSignature } from '../../payments/provider.js';

export const paymentsRouter = Router();

const VerifyBody = z.object({
  razorpay_order_id: z.string().min(1).max(64),
  razorpay_payment_id: z.string().min(1).max(64),
  razorpay_signature: z.string().regex(/^[0-9a-f]{64}$/),
});

paymentsRouter.post('/razorpay/verify', express.json({ limit: '10kb' }), async (req, res) => {
  const body = VerifyBody.safeParse(req.body);
  if (!body.success) throw new AppError('VALIDATION_ERROR', 'Invalid payment callback');
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sig } = body.data;
  if (!verifyRazorpayCheckoutSignature(orderId, paymentId, sig)) throw new AppError('UNAUTHORIZED', 'Invalid payment signature');
  // The signature proves Razorpay issued this payment for this order. The amount was
  // fixed when we created the order, so it can't differ here.
  res.json(await confirmPayment({ orderId, paymentId }));
});

paymentsRouter.post('/razorpay/webhook', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const sig = req.get('x-razorpay-signature') ?? '';
  if (!verifyRazorpayWebhookSignature(raw, sig)) throw new AppError('UNAUTHORIZED', 'Invalid webhook signature');

  let event: { event?: string; payload?: { payment?: { entity?: Record<string, unknown> } } };
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Invalid JSON');
  }

  const payment = event.payload?.payment?.entity;
  if ((event.event === 'payment.captured' || event.event === 'order.paid') && payment) {
    const orderId = String(payment.order_id ?? '');
    const paymentId = String(payment.id ?? '');
    const amount = Number(payment.amount);
    if (orderId && paymentId && Number.isSafeInteger(amount)) {
      try {
        await confirmPayment({ orderId, paymentId, amountMinor: amount, currency: String(payment.currency ?? '') });
      } catch (err) {
        // Orders not created by this service (other products on the same Razorpay
        // account) are acknowledged, not retried forever.
        if (err instanceof AppError && err.code === 'HOLD_NOT_FOUND') {
          logger.info({ orderId }, 'razorpay webhook for unknown order ignored');
        } else {
          throw err; // 5xx -> Razorpay retries the webhook
        }
      }
    }
  }
  res.json({ ok: true });
});

if (config.NODE_ENV !== 'production') {
  paymentsRouter.post('/mock/confirm', express.json(), async (req, res) => {
    const orderId = String(req.body?.orderId ?? '');
    if (!orderId.startsWith('mock_order_')) throw new AppError('VALIDATION_ERROR', 'orderId must be a mock order');
    res.json(
      await confirmPayment({
        orderId,
        paymentId: `mock_pay_${crypto.randomUUID()}`,
        ...(req.body?.amountMinor !== undefined ? { amountMinor: Number(req.body.amountMinor), currency: String(req.body.currency ?? 'INR') } : {}),
      }),
    );
  });
}
