import { z } from 'zod';

// Load .env if present (Node 20.12+). Real environments inject vars directly.
try {
  process.loadEnvFile();
} catch {
  /* no .env file: fine */
}

/** True inside a Vercel build or function (Vercel sets VERCEL=1). */
export const onVercel = Boolean(process.env.VERCEL);

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    /** Until set, every /api route answers 503 NOT_CONFIGURED (the app still deploys). */
    DATABASE_URL: z.string().min(1).optional(),
    /** Direct (non-pooler) connection for migrations; Neon's Vercel integration sets it. */
    DATABASE_URL_UNPOOLED: z.string().min(1).optional(),
    /** Per instance. Serverless runs many small instances, so keep it low there. */
    DB_POOL_MAX: z.coerce.number().int().min(2).max(200).default(onVercel ? 5 : 20),

    HOLD_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
    /** Background loops inside the API process. Off on Vercel, where cron calls /api/cron/*. */
    RUN_JOBS_IN_PROCESS: bool.default(!onVercel),
    /** Bearer token Vercel Cron (or any scheduler) sends to /api/cron/*. Vercel sets the header from this var. */
    CRON_SECRET: z.string().min(16).optional(),
    /** How long one /api/cron/tick call keeps running the fast jobs before returning. */
    CRON_TICK_BUDGET_MS: z.coerce.number().int().min(1_000).max(280_000).default(50_000),
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

    /** Defaults to razorpay in production so a missing setting never confirms bookings unpaid. */
    PAYMENT_PROVIDER: z.enum(['razorpay', 'mock']).optional(),
    /** Optional: until all three are set, checkout answers 503 NOT_CONFIGURED. */
    RAZORPAY_KEY_ID: z.string().min(1).optional(),
    RAZORPAY_KEY_SECRET: z.string().min(1).optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    // The mock provider confirms bookings without taking money: never allow it live.
    if (env.NODE_ENV === 'production' && env.PAYMENT_PROVIDER === 'mock') {
      ctx.addIssue({ code: 'custom', path: ['PAYMENT_PROVIDER'], message: 'must be razorpay in production' });
    }
  })
  .transform((env) => ({
    ...env,
    PAYMENT_PROVIDER: env.PAYMENT_PROVIDER ?? (env.NODE_ENV === 'production' ? 'razorpay' : 'mock'),
  }));

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Printed before the logger exists; never includes values, only names.
  console.error('Invalid environment configuration:\n' + z.prettifyError(parsed.error));
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;

/** Whether each optional feature has its env vars. Missing ones answer 503 NOT_CONFIGURED. */
export const configured = {
  database: Boolean(config.DATABASE_URL),
  payments:
    config.PAYMENT_PROVIDER === 'mock' ||
    Boolean(config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET && config.RAZORPAY_WEBHOOK_SECRET),
  cron: Boolean(config.CRON_SECRET),
};

/** Names of env vars still to set, for the boot log and /healthz. Never values. */
export function missingEnv(): string[] {
  const out: string[] = [];
  if (!configured.database) out.push('DATABASE_URL');
  if (!configured.payments) {
    for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'] as const) if (!config[k]) out.push(k);
  }
  if (onVercel && !configured.cron) out.push('CRON_SECRET');
  return out;
}
