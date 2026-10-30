/**
 * Authenticates channel managers (STAAH, AxisRooms, ...) calling our webhook.
 *
 * Layer 1, always on: API key in the header
 *     X-Api-Key: <keyId>.<secret>
 *   keyId finds the partner; sha256(secret) is compared in constant time with the
 *   stored hash. We never store the secret itself, so a DB leak doesn't leak keys.
 *
 * Layer 2, per partner (require_signature): HMAC request signing
 *     X-Timestamp: <unix seconds>
 *     X-Signature: hex(HMAC-SHA256(signing_secret, `${timestamp}.${rawBody}`))
 *   Proves the body wasn't altered and blocks replays older than the allowed skew.
 *
 * Failures always return the same generic 401, so attackers can't tell a wrong key id
 * from a wrong secret.
 */
import type { NextFunction, Request, Response } from 'express';
import { config } from '../../config.js';
import { pool } from '../../db/pool.js';
import { hmacSha256Hex, safeEqual, sha256Hex } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

export interface ChannelPartner {
  id: string;
  code: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    channelPartner?: ChannelPartner;
    rawBody?: Buffer;
    requestId?: string;
  }
}

// A fixed dummy hash so an unknown key id costs the same as a known one.
const DUMMY_HASH = sha256Hex('dummy-secret-for-timing');

export async function channelAuth(req: Request, _res: Response, next: NextFunction) {
  const deny = (why: string) => {
    logger.warn({ requestId: req.requestId, ip: req.ip, why }, 'channel webhook auth failed');
    next(new AppError('UNAUTHORIZED', 'Invalid credentials'));
  };

  const header = req.get('x-api-key');
  if (!header || header.length > 300) return deny('missing or oversized api key');
  const dot = header.indexOf('.');
  if (dot <= 0 || dot === header.length - 1) return deny('malformed api key');
  const keyId = header.slice(0, dot);
  const secret = header.slice(dot + 1);

  let partner: { id: string; code: string; api_key_hash: string; signing_secret: string | null; require_signature: boolean; is_active: boolean } | undefined;
  try {
    const { rows } = await pool.query(
      `SELECT id, code, api_key_hash, signing_secret, require_signature, is_active
         FROM channel_partners WHERE api_key_id = $1`,
      [keyId],
    );
    partner = rows[0];
  } catch (err) {
    return next(err); // DB down: 500, not a misleading 401
  }

  const keyOk = safeEqual(sha256Hex(secret), partner?.api_key_hash ?? DUMMY_HASH);
  if (!partner || !keyOk) return deny('unknown key or bad secret');
  if (!partner.is_active) return deny('partner disabled');

  if (partner.require_signature) {
    if (!partner.signing_secret || !req.rawBody) return deny('signature required but not configured');
    const ts = req.get('x-timestamp') ?? '';
    const sig = (req.get('x-signature') ?? '').toLowerCase();
    if (!/^\d{9,11}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return deny('missing signature headers');
    const skew = Math.abs(Date.now() / 1000 - Number(ts));
    if (skew > config.WEBHOOK_MAX_SKEW_SECONDS) return deny(`timestamp skew ${Math.round(skew)}s`);
    const expected = hmacSha256Hex(partner.signing_secret, Buffer.concat([Buffer.from(`${ts}.`), req.rawBody]));
    if (!safeEqual(expected, sig)) return deny('bad signature');
  }

  req.channelPartner = { id: partner.id, code: partner.code };
  next();
}
