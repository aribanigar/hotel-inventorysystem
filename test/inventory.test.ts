/**
 * End-to-end tests against a real Postgres, a mock B2B supplier and a local receiver.
 * Run: TEST_DATABASE_URL=postgres://... npm test
 */
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { createMockSupplier, type MockSupplierState } from '../src/dev/mockSupplier.js';
import { seed, type SeedResult } from '../src/dev/seed.js';
import { expireDueHolds } from '../src/engine/holds.js';
import { createApp } from '../src/http/app.js';
import { hmacSha256Hex } from '../src/lib/crypto.js';
import { addDays, todayIn } from '../src/lib/dates.js';
import { processOutboxBatch } from '../src/outbox/worker.js';

const app = createApp();
const ADMIN = 'Bearer test-extranet-admin-token-0123456789';
const NIGHTLY = 850000; // Rs 8,500.00 per night from the seed
const customer = { name: 'Test Guest', email: 'guest@example.com', phone: '+919999999999' };

let s: SeedResult;
let supplier: { state: MockSupplierState; server: Server };
let receiver: Server;
const received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];

/** Non-overlapping stay windows so tests don't share inventory rows. */
const stay = (offset: number, nights = 2) => {
  const checkIn = addDays(todayIn('Asia/Kolkata'), offset);
  return { checkIn, checkOut: addDays(checkIn, nights) };
};

const inv = async (roomTypeId: string, date: string) =>
  (await pool.query('SELECT allotment, held, available FROM daily_inventory WHERE room_type_id = $1 AND stay_date = $2', [roomTypeId, date])).rows[0];

const setControl = (patch: Partial<MockSupplierState>) => Object.assign(supplier.state, patch);

beforeAll(async () => {
  // Fresh schema every run.
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  s = await seed({ days: 60, allotment: 3, nightlyMinor: NIGHTLY });

  const mock = createMockSupplier();
  supplier = { state: mock.state, server: await mock.listen(4199) };

  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => receiver.listen(4198, r));
});

afterAll(async () => {
  supplier.server.close();
  receiver.close();
  await pool.end();
});

// ---------------------------------------------------------------------------
describe('Source 2: channel-manager webhook', () => {
  const push = (body: unknown, key = s.partner.apiKey) =>
    request(app).post('/api/v1/webhooks/channel-manager').set('x-api-key', key).set('content-type', 'application/json').send(JSON.stringify(body));

  const range = stay(20, 3);
  const base = () => ({ hotelCode: s.cmHotel.hotelCode, requestId: crypto.randomUUID(), timestamp: new Date().toISOString() });

  it('rejects missing and wrong credentials with the same 401', async () => {
    const a = await request(app).post('/api/v1/webhooks/channel-manager').set('content-type', 'application/json').send('{}');
    const b = await push({}, `${s.partner.apiKey.split('.')[0]}.wrong-secret`);
    const c = await push({}, 'ck_nope.whatever');
    for (const r of [a, b, c]) {
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('UNAUTHORIZED');
    }
  });

  it('upserts availability: inserts new nights, updates existing ones', async () => {
    const r = await push({ ...base(), updates: [{ roomCode: 'SUP', startDate: range.checkIn, endDate: range.checkOut, availability: 7 }] });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('success');
    expect(r.body.inventoryRowsWritten).toBe(4);
    expect((await inv(s.cmHotel.roomTypeId, range.checkIn)).allotment).toBe(7);

    // A night beyond the seeded 60 days does not exist yet: must be INSERTED.
    const far = addDays(todayIn('Asia/Kolkata'), 200);
    const r2 = await push({ ...base(), updates: [{ roomCode: 'SUP', startDate: far, endDate: far, availability: 2 }] });
    expect(r2.body.inventoryRowsWritten).toBe(1);
    expect((await inv(s.cmHotel.roomTypeId, far)).allotment).toBe(2);
  });

  it('ignores an older (out-of-order) push and de-duplicates a retried requestId', async () => {
    const old = new Date(Date.now() - 3600_000).toISOString();
    const r = await push({ ...base(), timestamp: old, updates: [{ roomCode: 'SUP', startDate: range.checkIn, endDate: range.checkIn, availability: 1 }] });
    expect(r.body.staleRowsSkipped).toBe(1);
    expect((await inv(s.cmHotel.roomTypeId, range.checkIn)).allotment).toBe(7);

    const body = { ...base(), updates: [{ roomCode: 'SUP', startDate: range.checkIn, endDate: range.checkIn, availability: 6 }] };
    expect((await push(body)).body.status).toBe('success');
    expect((await push(body)).body.status).toBe('duplicate');
  });

  it('applies rates + restrictions and rejects unmapped codes atomically', async () => {
    const ok = await push({
      ...base(),
      updates: [{ roomCode: 'SUP', ratePlanCode: 'CP', startDate: range.checkIn, endDate: range.checkOut, rate: { amount: '9100.50', currency: 'INR' }, minLos: 2 }],
    });
    expect(ok.status).toBe(200);
    const rate = (await pool.query('SELECT price_minor, min_los FROM daily_rates WHERE rate_plan_id = $1 AND stay_date = $2', [s.cmHotel.ratePlanId, range.checkIn])).rows[0];
    expect(rate).toEqual({ price_minor: 910050, min_los: 2 });

    const bad = await push({
      ...base(),
      updates: [
        { roomCode: 'SUP', startDate: range.checkIn, endDate: range.checkIn, availability: 0 },
        { roomCode: 'NOPE', startDate: range.checkIn, endDate: range.checkIn, availability: 0 },
      ],
    });
    expect(bad.status).toBe(400);
    expect((await inv(s.cmHotel.roomTypeId, range.checkIn)).allotment).toBe(6); // first update NOT applied
  });

  it('rejects a timestamp in the future (would freeze the row)', async () => {
    const r = await push({ ...base(), timestamp: new Date(Date.now() + 3600_000).toISOString(), updates: [{ roomCode: 'SUP', startDate: range.checkIn, endDate: range.checkIn, availability: 1 }] });
    expect(r.status).toBe(400);
  });

  it('enforces HMAC signatures when the partner requires them', async () => {
    await pool.query('UPDATE channel_partners SET require_signature = true WHERE id = $1', [s.partner.id]);
    const raw = JSON.stringify({ ...base(), updates: [{ roomCode: 'SUP', startDate: range.checkIn, endDate: range.checkIn, availability: 5 }] });
    const unsigned = await request(app).post('/api/v1/webhooks/channel-manager').set('x-api-key', s.partner.apiKey).set('content-type', 'application/json').send(raw);
    expect(unsigned.status).toBe(401);

    const ts = Math.floor(Date.now() / 1000).toString();
    const signed = await request(app)
      .post('/api/v1/webhooks/channel-manager')
      .set('x-api-key', s.partner.apiKey)
      .set('x-timestamp', ts)
      .set('x-signature', hmacSha256Hex(s.partner.signingSecret, `${ts}.${raw}`))
      .set('content-type', 'application/json')
      .send(raw);
    expect(signed.status).toBe(200);
    await pool.query('UPDATE channel_partners SET require_signature = false WHERE id = $1', [s.partner.id]);
  });
});

// ---------------------------------------------------------------------------
describe('Live Ping: Sources 2 + 3 (row-locked)', () => {
  const ping = (body: Record<string, unknown>) => request(app).post('/api/v1/checkout/live-ping').send({ customer, ...body });
  const hb = () => ({ hotelId: s.houseboat.hotelId, roomTypeId: s.houseboat.roomTypeId });

  it('holds the room, decrements inventory, returns a token and 10-minute timer', async () => {
    const d = stay(3);
    const r = await ping({ ...hb(), ...d, displayedTotalMinor: NIGHTLY * 2 });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('HELD');
    expect(r.body.pendingBookingToken).toMatch(/^pbt_/);
    expect(r.body.holdSeconds).toBeGreaterThan(590);
    expect(r.body.payment.orderId).toMatch(/^mock_order_/);
    expect(await inv(s.houseboat.roomTypeId, d.checkIn)).toEqual({ allotment: 3, held: 1, available: 2 });
    expect(await inv(s.houseboat.roomTypeId, addDays(d.checkIn, 1))).toEqual({ allotment: 3, held: 1, available: 2 });
    expect(await inv(s.houseboat.roomTypeId, d.checkOut)).toMatchObject({ held: 0 }); // checkout day is not a night

    const hold = await request(app).get(`/api/v1/checkout/holds/${r.body.pendingBookingToken}`);
    expect(hold.body.status).toBe('ACTIVE');
  });

  it('PRICE_CHANGED when the screen price differs; nothing is held', async () => {
    const d = stay(6);
    const r = await ping({ ...hb(), ...d, displayedTotalMinor: NIGHTLY * 2 - 100 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('PRICE_CHANGED');
    expect(r.body.error.details.liveTotalMinor).toBe(NIGHTLY * 2);
    expect((await inv(s.houseboat.roomTypeId, d.checkIn)).held).toBe(0);
  });

  it('RESTRICTED when min stay is not met', async () => {
    const d = stay(9, 1);
    await request(app)
      .put(`/api/v1/extranet/hotels/${s.houseboat.hotelId}/ari`)
      .set('authorization', ADMIN)
      .send({ updates: [{ roomTypeId: s.houseboat.roomTypeId, ratePlanId: s.houseboat.ratePlanId, startDate: d.checkIn, endDate: d.checkIn, minLos: 2 }] })
      .expect(200);
    const r = await ping({ ...hb(), ...d, displayedTotalMinor: NIGHTLY });
    expect(r.body.error.code).toBe('RESTRICTED');
    expect(r.body.error.details.reason).toBe('MIN_LOS');
  });

  it('last room + 10 simultaneous buyers = exactly one hold', async () => {
    const d = stay(12);
    await request(app)
      .put(`/api/v1/extranet/hotels/${s.houseboat.hotelId}/ari`)
      .set('authorization', ADMIN)
      .send({ updates: [{ roomTypeId: s.houseboat.roomTypeId, startDate: d.checkIn, endDate: addDays(d.checkOut, -1), availability: 1 }] })
      .expect(200);

    // A local DB is so fast that 10 requests can finish one after another without ever
    // overlapping. Force a real collision: lock the rows from outside, let all 10 buyers
    // pile up on them, then let go so they all race at the same instant.
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM daily_inventory WHERE room_type_id = $1 AND stay_date >= $2 AND stay_date < $3 FOR UPDATE', [
      s.houseboat.roomTypeId,
      d.checkIn,
      d.checkOut,
    ]);
    const racing = Promise.all(Array.from({ length: 10 }, () => ping({ ...hb(), ...d, displayedTotalMinor: NIGHTLY * 2 })));
    await new Promise((r) => setTimeout(r, 600));
    const waiting = (await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()")).rows[0].n;
    await blocker.query('COMMIT');
    blocker.release();
    const results = await racing;
    expect(waiting).toBeGreaterThanOrEqual(5); // proves the requests really were concurrent
    const codes = results.map((r) => (r.status === 201 ? 'HELD' : r.body.error.code));
    expect(codes.filter((c) => c === 'HELD')).toHaveLength(1);
    expect(codes.filter((c) => c === 'SOLD_OUT' || c === 'INVENTORY_BUSY')).toHaveLength(9);
    expect(await inv(s.houseboat.roomTypeId, d.checkIn)).toEqual({ allotment: 1, held: 1, available: 0 });
  });

  it('double click with the same Idempotency-Key returns the same hold', async () => {
    const d = stay(15);
    const key = `idem-${crypto.randomUUID()}`;
    const a = await ping({ ...hb(), ...d, displayedTotalMinor: NIGHTLY * 2 }).set('idempotency-key', key);
    const b = await ping({ ...hb(), ...d, displayedTotalMinor: NIGHTLY * 2 }).set('idempotency-key', key);
    expect(a.status).toBe(201);
    expect(b.body.pendingBookingToken).toBe(a.body.pendingBookingToken);
    expect((await inv(s.houseboat.roomTypeId, d.checkIn)).held).toBe(1);
  });

  it('expired holds are swept and rooms return to sale', async () => {
    const d = stay(18);
    const r = await ping({ ...hb(), ...d, displayedTotalMinor: NIGHTLY * 2 });
    await pool.query("UPDATE inventory_holds SET expires_at = now() - interval '1 second' WHERE pending_booking_token = $1", [r.body.pendingBookingToken]);
    expect(await expireDueHolds()).toBeGreaterThanOrEqual(1);
    expect((await inv(s.houseboat.roomTypeId, d.checkIn)).held).toBe(0);
    expect((await request(app).get(`/api/v1/checkout/holds/${r.body.pendingBookingToken}`)).body.status).toBe('EXPIRED');
  });

  it('customer release frees the room immediately', async () => {
    const d = stay(24);
    const r = await ping({ ...hb(), ...d, displayedTotalMinor: NIGHTLY * 2 });
    const rel = await request(app).post(`/api/v1/checkout/holds/${r.body.pendingBookingToken}/release`);
    expect(rel.body.released).toBe(true);
    expect((await inv(s.houseboat.roomTypeId, d.checkIn)).held).toBe(0);
  });

  it('payment confirms the sale (idempotently) and notifies the channel manager', async () => {
    await pool.query(
      `INSERT INTO channel_subscriptions (hotel_id, channel_code, endpoint_url, signing_secret) VALUES ($1, 'STAAH', 'http://127.0.0.1:4198/staah', 'sub-secret')`,
      [s.cmHotel.hotelId],
    );
    const d = stay(30);
    const r = await ping({ hotelId: s.cmHotel.hotelId, roomTypeId: s.cmHotel.roomTypeId, ...d, displayedTotalMinor: NIGHTLY * 2 });
    expect(r.status).toBe(201);

    const c1 = await request(app).post('/api/v1/payments/mock/confirm').send({ orderId: r.body.payment.orderId });
    const c2 = await request(app).post('/api/v1/payments/mock/confirm').send({ orderId: r.body.payment.orderId });
    expect(c1.body).toMatchObject({ status: 'CONFIRMED', alreadyConfirmed: false });
    expect(c2.body).toMatchObject({ status: 'CONFIRMED', alreadyConfirmed: true });
    expect(await inv(s.cmHotel.roomTypeId, d.checkIn)).toEqual({ allotment: 2, held: 0, available: 2 });

    received.length = 0;
    await processOutboxBatch(100);
    const reservation = received.find((m) => m.headers['x-event-type'] === 'RESERVATION_CREATED');
    expect(reservation).toBeDefined();
    const ts = reservation!.headers['x-timestamp'] as string;
    expect(reservation!.headers['x-signature']).toBe(hmacSha256Hex('sub-secret', `${ts}.${reservation!.body}`));
    expect(JSON.parse(reservation!.body).data).toMatchObject({ checkIn: d.checkIn, rooms: 1, totalMinor: NIGHTLY * 2 });
  });

  it('wrong paid amount is flagged for refund, never confirmed', async () => {
    const d = stay(33);
    const r = await ping({ ...hb(), ...d, displayedTotalMinor: NIGHTLY * 2 });
    const c = await request(app).post('/api/v1/payments/mock/confirm').send({ orderId: r.body.payment.orderId, amountMinor: 100, currency: 'INR' });
    expect(c.body.status).toBe('NEEDS_REFUND');
    expect((await inv(s.houseboat.roomTypeId, d.checkIn)).held).toBe(0);
  });

  it('late payment after expiry: re-takes the room if still free, else refund', async () => {
    const d = stay(36);
    await request(app)
      .put(`/api/v1/extranet/hotels/${s.houseboat.hotelId}/ari`)
      .set('authorization', ADMIN)
      .send({ updates: [{ roomTypeId: s.houseboat.roomTypeId, startDate: d.checkIn, endDate: addDays(d.checkOut, -1), availability: 1 }] })
      .expect(200);

    const late = await ping({ ...hb(), ...d, displayedTotalMinor: NIGHTLY * 2 });
    await pool.query("UPDATE inventory_holds SET expires_at = now() - interval '1 second' WHERE pending_booking_token = $1", [late.body.pendingBookingToken]);
    await expireDueHolds();
    // Someone else buys the last room in the meantime...
    const other = await ping({ ...hb(), ...d, displayedTotalMinor: NIGHTLY * 2 });
    expect(other.status).toBe(201);
    // ...so the late payer must be refunded, not overbooked.
    const c = await request(app).post('/api/v1/payments/mock/confirm').send({ orderId: late.body.payment.orderId });
    expect(c.body.status).toBe('NEEDS_REFUND');
    expect(await inv(s.houseboat.roomTypeId, d.checkIn)).toEqual({ allotment: 1, held: 1, available: 0 });
  });
});

// ---------------------------------------------------------------------------
describe('Live Ping: Source 1 (external B2B supplier)', () => {
  const ping = (extra: Record<string, unknown> = {}) =>
    request(app)
      .post('/api/v1/checkout/live-ping')
      .send({ customer, hotelId: s.chain.hotelId, roomTypeId: s.chain.roomTypeId, ...stay(40), displayedTotalMinor: 2_500_000, ...extra });

  it('holds via supplier pre-book and books with the supplier after payment', async () => {
    setControl({ mode: 'normal', nightlyPrice: '12500.00', availableRooms: 3 });
    const r = await ping();
    expect(r.status).toBe(201);
    expect(r.body.source).toBe('EXTERNAL_B2B');
    const c = await request(app).post('/api/v1/payments/mock/confirm').send({ orderId: r.body.payment.orderId });
    expect(c.body.status).toBe('CONFIRMED');
    await processOutboxBatch(100);
    const ref = (await pool.query('SELECT supplier_booking_ref FROM inventory_holds WHERE pending_booking_token = $1', [r.body.pendingBookingToken])).rows[0];
    expect(ref.supplier_booking_ref).toMatch(/^SUP-/);
  });

  it('PRICE_CHANGED when the supplier re-prices', async () => {
    setControl({ mode: 'normal', nightlyPrice: '13000.00' });
    const r = await ping();
    expect(r.body.error.code).toBe('PRICE_CHANGED');
    expect(r.body.error.details.liveTotalMinor).toBe(2_600_000);
    setControl({ nightlyPrice: '12500.00' });
  });

  it('SOLD_OUT from the supplier', async () => {
    setControl({ mode: 'soldout' });
    expect((await ping()).body.error.code).toBe('SOLD_OUT');
  });

  it('times out fast and cleanly (SUPPLIER_TIMEOUT), no crash', async () => {
    setControl({ mode: 'slow' });
    const t0 = Date.now();
    const r = await ping();
    expect(r.status).toBe(504);
    expect(r.body.error).toMatchObject({ code: 'SUPPLIER_TIMEOUT', retryable: true });
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('malformed JSON or a different room echoed back = SUPPLIER_UNAVAILABLE', async () => {
    setControl({ mode: 'garbage' });
    expect((await ping()).body.error.code).toBe('SUPPLIER_UNAVAILABLE');
    setControl({ mode: 'wrongRoom' });
    expect((await ping()).body.error.code).toBe('SUPPLIER_UNAVAILABLE');
  });

  it('circuit breaker opens after repeated outages and fails instantly', async () => {
    setControl({ mode: 'error500' });
    for (let i = 0; i < 5; i++) await ping();
    const callsBefore = supplier.state.calls;
    const t0 = Date.now();
    const r = await ping();
    expect(r.body.error.code).toBe('SUPPLIER_UNAVAILABLE');
    expect(r.body.error.details.retryAfterMs).toBeGreaterThan(0);
    expect(supplier.state.calls).toBe(callsBefore); // supplier not even called
    expect(Date.now() - t0).toBeLessThan(500);
    setControl({ mode: 'normal' });
  });
});

// ---------------------------------------------------------------------------
describe('Availability read API', () => {
  it('returns live per-room availability for an internal hotel', async () => {
    const d = stay(45);
    const r = await request(app).get(`/api/v1/hotels/${s.houseboat.hotelId}/availability`).query(d);
    expect(r.status).toBe(200);
    expect(r.body.roomTypes[0]).toMatchObject({ available: true, availableRooms: 3, totalPriceMinor: NIGHTLY * 2 });
  });

  it('validates dates', async () => {
    const r = await request(app).get(`/api/v1/hotels/${s.houseboat.hotelId}/availability`).query({ checkIn: '2020-01-01', checkOut: '2020-01-03' });
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });
});
