import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share one real Postgres database: run files one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:54329/hotel_inventory_test',
      SUPPLIER_BASE_URL: 'http://127.0.0.1:4199',
      SUPPLIER_API_KEY: 'test-key',
      SUPPLIER_TIMEOUT_MS: '800',
      PAYMENT_PROVIDER: 'mock',
      RUN_JOBS_IN_PROCESS: 'false',
      EXTRANET_ADMIN_TOKEN: 'test-extranet-admin-token-0123456789',
      HOLD_TTL_SECONDS: '600',
      LIVE_PING_RATE_LIMIT: '1000',
      LOGIN_RATE_LIMIT: '1000',
      CHANNEX_BASE_URL: 'http://127.0.0.1:4197',
      CHANNEX_API_KEY: 'test-channex-api-key',
      CHANNEX_WEBHOOK_SECRET: 'test-channex-webhook-secret-0123',
      CHANNEX_WEBHOOK_HMAC_SECRET: 'test-channex-hmac-secret',
      CHANNEX_MIN_PUSH_INTERVAL_MS: '0',
      CRON_SECRET: 'test-cron-secret-0123456789',
      CRON_TICK_BUDGET_MS: '1000',
    },
  },
});
