import express, { type NextFunction, type Request, type Response } from 'express';
import { pool } from '../db/pool.js';
import { AppError, isAppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { availabilityRouter } from './routes/availability.js';
import { checkoutRouter } from './routes/checkout.js';
import { extranetRouter } from './routes/extranet.js';
import { paymentsRouter } from './routes/payments.js';
import { webhooksRouter } from './routes/webhooks.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Behind one proxy/load balancer (Hostinger, Railway, Nginx). Needed for correct req.ip.
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

  // Routes that need the RAW body (signature checks) are mounted BEFORE express.json.
  app.use('/api/v1/webhooks', webhooksRouter);
  app.use('/api/v1/payments', paymentsRouter);

  app.use(express.json({ limit: '100kb' }));
  app.use('/api/v1/checkout', checkoutRouter);
  app.use('/api/v1/hotels', availabilityRouter);
  app.use('/api/v1/extranet', extranetRouter);

  app.get('/healthz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
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
