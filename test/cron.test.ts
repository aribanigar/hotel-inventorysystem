/** Scheduled-job endpoints used by Vercel Cron (or any scheduler). */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { createApp } from '../src/http/app.js';
import vercelApp from '../src/index.js';

const app = createApp();
const AUTH = { authorization: 'Bearer test-cron-secret-0123456789' };

beforeAll(async () => {
  await migrate();
});
afterAll(async () => {
  await pool.end();
});

describe('cron endpoints', () => {
  it('refuse calls without the right bearer token', async () => {
    await request(app).get('/api/cron/tick').expect(401);
    await request(app).get('/api/cron/tick').set({ authorization: 'Bearer wrong-secret-0123456789xx' }).expect(401);
    await request(app).get('/api/cron/hourly').set({ authorization: 'test-cron-secret-0123456789' }).expect(401);
  });

  it('tick runs the fast jobs once within its budget and reports counts', async () => {
    const started = Date.now();
    const res = await request(app).get('/api/cron/tick').set(AUTH).expect(200);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(Object.keys(res.body.processed).sort()).toEqual(['channex-bookings', 'channex-push', 'hold-sweeper', 'outbox']);
  });

  it('hourly and daily run the slow jobs', async () => {
    const h = await request(app).get('/api/cron/hourly').set(AUTH).expect(200);
    expect(h.body.processed).toHaveProperty('horizon-roll');
    const d = await request(app).get('/api/cron/daily').set(AUTH).expect(200);
    expect(d.body.processed).toHaveProperty('channex-prune');
  });

  it('the Vercel entry serves the same API', async () => {
    const res = await request(vercelApp).get('/healthz').expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['x-powered-by']).toBeUndefined();
    await request(vercelApp).get('/api/cron/tick').expect(401);
  });
});
