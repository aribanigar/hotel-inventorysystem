import express, { type NextFunction, type Request, type Response } from 'express';
import { configured, missingEnv } from '../config.js';
import { pool } from '../db/pool.js';
import { AppError, isAppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { availabilityRouter } from './routes/availability.js';
import { channexWebhookRouter } from './routes/channexWebhook.js';
import { checkoutRouter } from './routes/checkout.js';
import { cronRouter } from './routes/cron.js';
import { extranetRouter } from './routes/extranet.js';
import { hotelierRouter } from './routes/hotelier.js';
import { qloCmApiRouter } from './routes/qloCmApi.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/extranet');
import { paymentsRouter } from './routes/payments.js';
import { webhooksRouter } from './routes/webhooks.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Behind one proxy/load balancer (Vercel, Hostinger, Railway, Nginx). Needed for correct
  // req.ip. Vercel overwrites X-Forwarded-For with the client IP, so one hop is right there too.
  app.set('trust proxy', 1);

  // Request id + basic security headers + access log.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const incoming = req.get('x-request-id');
    req.requestId = incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
    res.setHeader('x-request-id', req.requestId);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      logger.info(
        { requestId: req.requestId, method: req.method, path: req.path, status: res.statusCode, ms: Number(process.hrtime.bigint() - start) / 1e6 },
        'request',
      );
    });
    next();
  });

  const missing = missingEnv();
  if (missing.length) logger.warn({ missing }, 'env vars not set yet; those features answer 503 NOT_CONFIGURED');

  // No database yet: every API route answers 503 instead of failing on a connection.
  // Static files and /healthz still work, so the deploy can be checked first.
  if (!configured.database) {
    app.use('/api', (_req, _res, next) => next(new AppError('NOT_CONFIGURED', 'Database is not set up yet (DATABASE_URL)')));
  }

  // Routes that need the RAW body (signature checks) are mounted BEFORE express.json.
  app.use('/api/v1/webhooks', webhooksRouter);
  app.use('/api/v1/payments', paymentsRouter);
  // QloApps-Channel-Manager-compatible PMS API (reads its own raw JSON body).
  app.use('/api/cm_api', qloCmApiRouter);
  // Channex booking webhooks (HMAC over the raw body).
  app.use('/api/v1/channex', channexWebhookRouter);

  app.use(express.json({ limit: '100kb' }));
  app.use('/api/v1/checkout', checkoutRouter);
  app.use('/api/v1/hotels', availabilityRouter);
  app.use('/api/v1/extranet', extranetRouter);
  app.use('/api/v1/hotelier', hotelierRouter);
  // Scheduled jobs for serverless hosting (Vercel Cron).
  app.use('/api/cron', cronRouter);

  // Hotelier web app: static files, locked down with a strict CSP (no inline script,
  // no third-party origins, no framing).
  app.use(
    '/extranet',
    (_req, res, next) => {
      res.setHeader(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      res.setHeader('x-frame-options', 'DENY');
      next();
    },
    // maxAge 0 + ETag: browsers revalidate every load (cheap 304s), so a deploy is
    // visible to hotel staff immediately instead of after a stale-cache window.
    express.static(PUBLIC_DIR, { index: 'index.html', maxAge: 0 }),
  );

  app.get('/healthz', async (_req, res) => {
    // Names only, never values: tells you which env vars are still to set.
    const missing = missingEnv();
    if (!configured.database) return void res.status(503).json({ ok: false, missing });
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, missing });
    } catch {
      res.status(503).json({ ok: false, missing });
    }
  });

  app.use((_req, _res, next) => next(new AppError('NOT_FOUND', 'Route not found')));

  // Single error funnel: known errors keep their code; everything else becomes a
  // generic 500 with no internals leaked to the client.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    let appErr: AppError;
    if (isAppError(err)) {
      appErr = err;
    } else if ((err as { type?: string }).type === 'entity.parse.failed') {
      appErr = new AppError('VALIDATION_ERROR', 'Body must be valid JSON');
    } else if ((err as { type?: string }).type === 'entity.too.large') {
      appErr = new AppError('VALIDATION_ERROR', 'Request body too large');
    } else {
      logger.error({ err, requestId: req.requestId, path: req.path }, 'unhandled error');
      appErr = new AppError('INTERNAL_ERROR', 'Something went wrong');
    }
    if (appErr.status >= 500 && isAppError(err)) logger.warn({ code: appErr.code, requestId: req.requestId, details: appErr.details }, appErr.message);
    if (res.headersSent) return;
    res.status(appErr.status).json({ error: appErr.toJSON(), requestId: req.requestId });
  });

  return app;
}
