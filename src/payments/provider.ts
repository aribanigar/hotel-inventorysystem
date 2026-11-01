/**
 * Payment gateway abstraction. Razorpay in production, a mock for local dev/tests.
 *
 * Razorpay flow used here:
 *  1. Server creates an Order (amount in paise) right after a successful Live Ping.
 *  2. Frontend opens Razorpay Checkout with that order_id.
 *  3. Payment is confirmed by EITHER the client callback (signature over
 *     `${order_id}|${payment_id}` with the key secret) OR the server webhook
 *     (signature over the raw body with the webhook secret). Both paths are idempotent,
 *     so whichever arrives first confirms and the other becomes a no-op.
 */
import { z } from 'zod';
import { config, configured } from '../config.js';
import { hmacSha256Hex, safeEqual } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { HttpCallError, requestJson } from '../lib/http.js';
import { logger } from '../lib/logger.js';

export interface CreateOrderInput {
  amountMinor: number;
  currency: string;
  /** Our hold id: max 40 chars for Razorpay. */
  receipt: string;
  notes: Record<string, string>;
}

export interface CreatedOrder {
  provider: 'razorpay' | 'mock';
  orderId: string;
  /** Safe to send to the browser (never contains secrets). */
  checkout: Record<string, unknown>;
}

export interface PaymentProvider {
  readonly name: 'razorpay' | 'mock';
  createOrder(input: CreateOrderInput): Promise<CreatedOrder>;
}

const RazorpayOrder = z.object({ id: z.string().startsWith('order_'), amount: z.number().int(), currency: z.string(), status: z.string() });

class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay' as const;

  async createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
    // Thrown before any gateway call; Live Ping then releases the hold it just took.
    if (!configured.payments) throw new AppError('NOT_CONFIGURED', 'Online payment is not set up yet');
    const auth =Buffer.from(`${config.RAZORPAY_KEY_ID}:${config.RAZORPAY_KEY_SECRET}`).toString('base64');
    try {
      const { json } = await requestJson('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: { authorization: `Basic ${auth}` },
        body: { amount: input.amountMinor, currency: input.currency, receipt: input.receipt.slice(0, 40), notes: input.notes },
        timeoutMs: 8_000,
      });
      const order = RazorpayOrder.parse(json);
      // Never launch a checkout for an amount different from the one we verified.
      if (order.amount !== input.amountMinor || order.currency !== input.currency) {
        throw new AppError('PAYMENT_ERROR', 'Payment order amount mismatch');
      }
      return {
        provider: 'razorpay',
        orderId: order.id,
        checkout: { key: config.RAZORPAY_KEY_ID, order_id: order.id, amount: order.amount, currency: order.currency },
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      logger.error({ err: err instanceof HttpCallError ? { kind: err.kind, status: err.status, body: err.bodySnippet } : err }, 'razorpay order creation failed');
      throw new AppError('PAYMENT_ERROR', 'Could not start payment, please try again', undefined, { cause: err });
    }
  }
}

class MockProvider implements PaymentProvider {
  readonly name = 'mock' as const;
  async createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
    const orderId = `mock_order_${crypto.randomUUID().replaceAll('-', '')}`;
    return { provider: 'mock', orderId, checkout: { order_id: orderId, amount: input.amountMinor, currency: input.currency } };
  }
}

let provider: PaymentProvider | undefined;
export function paymentProvider(): PaymentProvider {
  provider ??= config.PAYMENT_PROVIDER === 'razorpay' ? new RazorpayProvider() : new MockProvider();
  return provider;
}
/** Test hook. */
export function setPaymentProvider(p: PaymentProvider | undefined) {
  provider = p;
}

/** Client-side callback signature: HMAC(key_secret, `${order_id}|${payment_id}`). */
export function verifyRazorpayCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
  if (!config.RAZORPAY_KEY_SECRET) return false;
  return safeEqual(hmacSha256Hex(config.RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`), signature);
}

/** Webhook signature: HMAC(webhook_secret, raw request body). */
export function verifyRazorpayWebhookSignature(rawBody: Buffer, signature: string): boolean {
  if (!config.RAZORPAY_WEBHOOK_SECRET) return false;
  return safeEqual(hmacSha256Hex(config.RAZORPAY_WEBHOOK_SECRET, rawBody), signature);
}
