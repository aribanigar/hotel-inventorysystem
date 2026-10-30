/**
 * Small in-memory fixed-window rate limiter keyed by IP (or any key).
 * Good enough for a single instance and as a first line of defence. Behind several
 * instances, put a shared limiter (Redis, or the CDN/WAF) in front as well.
 */
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../lib/errors.js';

export function rateLimit(opts: { windowMs: number; max: number; key?: (req: Request) => string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Periodically drop expired windows so the map can't grow without bound.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, opts.windowMs);
  sweep.unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = opts.key?.(req) ?? req.ip ?? 'unknown';
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > opts.max) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return next(new AppError('RATE_LIMITED', 'Too many requests'));
    }
    next();
  };
}
