import { pino } from 'pino';
import { config } from '../config.js';

export const logger = pino({
  level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL,
  // Never let keys, signatures or customer contact details reach the logs.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'req.headers["x-signature"]',
      'req.headers["x-razorpay-signature"]',
      '*.customer.email',
      '*.customer.phone',
      'customer.email',
      'customer.phone',
    ],
    censor: '[redacted]',
  },
});
