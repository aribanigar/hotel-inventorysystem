/**
 * Extranet sessions for hotel staff.
 *
 * - Login with email + password (scrypt). 5 wrong passwords lock the account 15 minutes.
 * - The session token lives in an HttpOnly, SameSite=Strict cookie, so page scripts
 *   (and any injected script) can't read it. Only its sha256 is stored in the DB.
 * - Every state-changing request must carry `X-Extranet: 1`. Browsers won't send a
 *   custom header cross-site without a CORS preflight we never allow, so together
 *   with SameSite=Strict this blocks CSRF.
 * - Access is per hotel and per role (owner > manager > frontdesk), checked on every
 *   request against the DB, so revoking access takes effect immediately.
 */
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { newToken, sha256Hex } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { DUMMY_PASSWORD_HASH, verifyPassword } from './passwords.js';

export const SESSION_COOKIE = 'hx_session';
const SESSION_HOURS = 12;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export type Role = 'owner' | 'manager' | 'frontdesk';
const RANK: Record<Role, number> = { frontdesk: 1, manager: 2, owner: 3 };

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    hotelUser?: SessionUser;
    hotelRole?: Role;
  }
}

export async function login(email: string, password: string, meta: { ip?: string | undefined; userAgent?: string | undefined }) {
  const { rows } = await pool.query(
    `SELECT id, email, name, password_hash, is_active, failed_logins, locked_until
       FROM hotel_users WHERE lower(email) = lower($1)`,
    [email],
  );
  const u = rows[0];

  // Always run scrypt, even for unknown emails, so timing doesn't reveal which exist.
  const ok = await verifyPassword(password, u?.password_hash ?? DUMMY_PASSWORD_HASH);
  const generic = new AppError('UNAUTHORIZED', 'Email or password is incorrect');

  if (!u || !u.is_active) throw generic;
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    throw new AppError('RATE_LIMITED', 'Too many attempts. Try again in a few minutes.');
  }
  if (!ok) {
    await pool.query(
      `UPDATE hotel_users
          SET failed_logins = failed_logins + 1,
              locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) END
        WHERE id = $1`,
      [u.id, MAX_FAILED, LOCK_MINUTES],
    );
    logger.warn({ userId: u.id, ip: meta.ip }, 'extranet login failed');
    throw generic;
  }

  const token = newToken('hxs');
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600_000);
  await pool.query('UPDATE hotel_users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
  await pool.query(
    'INSERT INTO extranet_sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5)',
    [sha256Hex(token), u.id, expiresAt, meta.ip ?? null, (meta.userAgent ?? '').slice(0, 300)],
  );
  // Opportunistic cleanup of this user's expired sessions.
  await pool.query('DELETE FROM extranet_sessions WHERE user_id = $1 AND expires_at < now()', [u.id]);
  return { token, expiresAt, user: { id: u.id as string, email: u.email as string, name: u.name as string } };
}

export async function logout(token: string | undefined) {
  if (token) await pool.query('DELETE FROM extranet_sessions WHERE token_hash = $1', [sha256Hex(token)]);
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.NODE_ENV === 'production',
    path: '/api/v1/hotelier',
    expires: expiresAt,
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { path: '/api/v1/hotelier' });
}

/** Minimal cookie reader (avoids a dependency for one cookie). */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Loads the session user; rejects with 401 when absent/expired. */
export async function requireSession(req: Request, _res: Response, next: NextFunction) {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('x-extranet') !== '1') {
      throw new AppError('UNAUTHORIZED', 'Missing request header');
    }
    const token = readCookie(req, SESSION_COOKIE);
    if (!token || !/^hxs_[A-Za-z0-9_-]{32}$/.test(token)) throw new AppError('UNAUTHORIZED', 'Please sign in');
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.name
         FROM extranet_sessions s JOIN hotel_users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now() AND u.is_active`,
      [sha256Hex(token)],
    );
    if (!rows[0]) throw new AppError('UNAUTHORIZED', 'Your session has ended, please sign in again');
    req.hotelUser = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

/** Requires access to :hotelId with at least `min` role. */
export function requireHotelRole(min: Role) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const hotelId = req.params.hotelId;
      const { rows } = await pool.query<{ role: Role }>(
        'SELECT role FROM hotel_user_access WHERE user_id = $1 AND hotel_id = $2::uuid',
        [req.hotelUser!.id, hotelId],
      );
      const role = rows[0]?.role;
      // Same 404 for "no such hotel" and "not yours", so ids can't be probed.
      if (!role) throw new AppError('NOT_FOUND', 'Hotel not found');
      if (RANK[role] < RANK[min]) throw new AppError('FORBIDDEN', `This action needs the ${min} role`);
      req.hotelRole = role;
      next();
    } catch (err) {
      next(err);
    }
  };
}
