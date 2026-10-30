import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256Hex = (input: string | Buffer): string => createHash('sha256').update(input).digest('hex');

export const hmacSha256Hex = (secret: string, payload: string | Buffer): string =>
  createHmac('sha256', secret).update(payload).digest('hex');

/**
 * Constant-time string comparison. A plain `===` leaks, through response timing,
 * how many leading characters of a guessed secret were right.
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // Still burn a comparison so length mismatch isn't measurably faster.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** Unguessable, URL-safe token (192 bits). Used as the pending booking token. */
export const newToken = (prefix: string): string => `${prefix}_${randomBytes(24).toString('base64url')}`;
