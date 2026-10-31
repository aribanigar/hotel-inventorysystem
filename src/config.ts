import { z } from 'zod';

// Load .env if present (Node 20.12+). Real environments inject vars directly.
try {
  process.loadEnvFile();
} catch {
  /* no .env file: fine */
}

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    DB_POOL_MAX: z.coerce.number().int().min(2).max(200).default(20),

    HOLD_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
    RUN_JOBS_IN_PROCESS: bool.default(true),
    /** Live Ping requests allowed per IP per minute. */
    LIVE_PING_RATE_LIMIT: z.coerce.number().int().min(1).default(30),
    /** Extranet sign-in attempts allowed per IP per minute. */
    LOGIN_RATE_LIMIT: z.coerce.number().int().min(1).default(20),

    SUPPLIER_BASE_URL: z.url().optional(),
    SUPPLIER_API_KEY: z.string().optional(),
    SUPPLIER_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(8000),

    WEBHOOK_MAX_SKEW_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),

    EXTRANET_ADMIN_TOKEN: z.string().min(24).optional(),

    /** Channex.io: staging until certification passes, then the production host Channex gives you. */
    CHANNEX_BASE_URL: z.url().default('https://staging.channex.io'),
    CHANNEX_API_KEY: z.string().min(8).optional(),
    /** Shared secret Channex sends in the X-Channex-Webhook-Secret header (set on the webhook). */
    CHANNEX_WEBHOOK_SECRET: z.string().min(24).optional(),
    /** Optional HMAC signing secret (Channex "signing key"); verified when set. */
    CHANNEX_WEBHOOK_HMAC_SECRET: z.string().min(16).optional(),
    /** Minimum gap between pushes for one property. 6 s keeps us at <= 10 calls/min per endpoint. */
    CHANNEX_MIN_PUSH_INTERVAL_MS: z.coerce.number().int().min(0).max(60_000).default(6_000),
    /** Nights ahead kept in sync with Channex (its full sync is 500 days). */
    CHANNEX_HORIZON_DAYS: z.coerce.number().int().min(30).max(730).default(500),

    PAYMENT_PROVIDER: z.enum(['razorpay', 'mock']).default('mock'),
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // Fail fast at boot rather than at the first customer checkout.
    if (env.NODE_ENV === 'production' && env.PAYMENT_PROVIDER !== 'razorpay') {
      ctx.addIssue({ code: 'custom', path: ['PAYMENT_PROVIDER'], message: 'must be razorpay in production' });
    }
    if (env.PAYMENT_PROVIDER === 'razorpay') {
      for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'] as const) {
        if (!env[k]) ctx.addIssue({ code: 'custom', path: [k], message: 'required when PAYMENT_PROVIDER=razorpay' });
      }
    }
  });

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Printed before the logger exists; never includes values, only names.
  console.error('Invalid environment configuration:\n' + z.prettifyError(parsed.error));
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
