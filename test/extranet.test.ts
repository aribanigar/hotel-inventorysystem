/**
 * Hotelier extranet: auth, per-hotel access, offline sales, status lifecycle,
 * audit trail, and offline-vs-online races for the last room.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { createHotelUser } from '../src/dev/createHotelUser.js';
import { seed, type SeedResult } from '../src/dev/seed.js';
import { createApp } from '../src/http/app.js';
import { addDays, todayIn } from '../src/lib/dates.js';

const app = createApp();
const NIGHTLY = 850000;
const PW = 'Kashmir-2026-houseboat';
let s: SeedResult;

const day = (offset: number) => addDays(todayIn('Asia/Kolkata'), offset);
const inv = async (roomTypeId: string, date: string) =>
  (await pool.query('SELECT allotment, held, available FROM daily_inventory WHERE room_type_id = $1 AND stay_date = $2', [roomTypeId, date])).rows[0];

/** Logged-in agent (keeps the session cookie) that sends the CSRF header. */
async function signIn(email: string, password = PW) {
  const agent = request.agent(app);
  const r = await agent.post('/api/v1/hotelier/session').set('x-extranet', '1').send({ email, password });
  expect(r.status).toBe(200);
  return agent;
}
const H = { 'x-extranet': '1' };

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  s = await seed({ days: 60, allotment: 3, nightlyMinor: NIGHTLY });
  await createHotelUser('owner@houseboat.test', 'Houseboat Owner', s.houseboat.hotelId, 'owner', PW);
  await createHotelUser('desk@houseboat.test', 'Front Desk', s.houseboat.hotelId, 'frontdesk', PW);
  await createHotelUser('gm@gulmarg.test', 'Gulmarg GM', s.cmHotel.hotelId, 'manager', PW);
  await createHotelUser('lockme@houseboat.test', 'Lock Me', s.houseboat.hotelId, 'frontdesk', PW);
});

afterAll(async () => {
  await pool.end();
});

describe('sign in', () => {
  it('rejects a wrong password with a generic message, and requires the CSRF header', async () => {
    const bad = await request(app).post('/api/v1/hotelier/session').set(H).send({ email: 'owner@houseboat.test', password: 'nope-nope-1' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toBe('Email or password is incorrect');
    const unknown = await request(app).post('/api/v1/hotelier/session').set(H).send({ email: 'ghost@x.test', password: 'nope-nope-1' });
    expect(unknown.body.error.message).toBe('Email or password is incorrect');
    const noHeader = await request(app).post('/api/v1/hotelier/session').send({ email: 'owner@houseboat.test', password: PW });
    expect(noHeader.status).toBe(401);
  });

  it('sets an HttpOnly SameSite=Strict cookie and lists the hotels', async () => {
    const r = await request(app).post('/api/v1/hotelier/session').set(H).send({ email: 'OWNER@houseboat.test', password: PW });
    const cookie = String(r.headers['set-cookie']);
    expect(cookie).toMatch(/hx_session=hxs_/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const agent = await signIn('owner@houseboat.test');
    const me = await agent.get('/api/v1/hotelier/me');
    expect(me.body.hotels).toHaveLength(1);
    expect(me.body.hotels[0]).toMatchObject({ id: s.houseboat.hotelId, role: 'owner', source: 'EXTRANET' });
  });

  it('locks the account after 5 wrong passwords', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/v1/hotelier/session').set(H).send({ email: 'lockme@houseboat.test', password: 'wrong-pass-1' });
    }
    const r = await request(app).post('/api/v1/hotelier/session').set(H).send({ email: 'lockme@houseboat.test', password: PW });
    expect(r.status).toBe(429);
  });

  it('sign out kills the session server-side', async () => {
    const agent = await signIn('owner@houseboat.test');
    await agent.delete('/api/v1/hotelier/session');
    expect((await agent.get('/api/v1/hotelier/me')).status).toBe(401);
  });
});

describe('access control', () => {
  it("a user can't see another hotel (404, not 403, so ids can't be probed)", async () => {
    const gm = await signIn('gm@gulmarg.test');
    const r = await gm.get(`/api/v1/hotelier/hotels/${s.houseboat.hotelId}/calendar`).query({ from: day(0), days: 7 });
    expect(r.status).toBe(404);
  });

  it('front desk can sell rooms but cannot change rates or inventory', async () => {
    const desk = await signIn('desk@houseboat.test');
    const r = await desk
      .put(`/api/v1/hotelier/hotels/${s.houseboat.hotelId}/ari`)
      .set(H)
      .send({ updates: [{ roomTypeId: s.houseboat.roomTypeId, startDate: day(2), endDate: day(2), availability: 9 }] });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
  });

  it('mutations without the CSRF header are refused even with a valid session', async () => {
    const owner = await signIn('owner@houseboat.test');
    const r = await owner
      .post(`/api/v1/hotelier/hotels/${s.houseboat.hotelId}/reservations`)
      .send({ roomTypeId: s.houseboat.roomTypeId, checkIn: day(1), checkOut: day(2), source: 'WALK_IN', guestName: 'No Header' });
    expect(r.status).toBe(401);
  });
});

describe('offline sales (walk-in / phone / WhatsApp)', () => {
  it('takes rooms out of inventory, notifies channels, shows in calendar + audit', async () => {
    await pool.query(
      `INSERT INTO channel_subscriptions (hotel_id, channel_code, endpoint_url, signing_secret, event_types)
       VALUES ($1, 'PARTNER_SITE', 'http://127.0.0.1:4197/ari', 'x', ARRAY['ARI_CHANGED'])`,
      [s.houseboat.hotelId],
    );
    const desk = await signIn('desk@houseboat.test');
    const r = await desk.post(`/api/v1/hotelier/hotels/${s.houseboat.hotelId}/reservations`).set(H).send({
      roomTypeId: s.houseboat.roomTypeId,
      checkIn: day(5),
      checkOut: day(7),
      rooms: 2,
      source: 'WHATSAPP',
      guestName: 'Aamir Guest',
      guestPhone: '+91 99999 00000',
      amountMinor: 1600000,
    });
    expect(r.status).toBe(201);
    expect(r.body.reference).toMatch(/^HB-[A-Z2-9]{6}$/);
    expect(await inv(s.houseboat.roomTypeId, day(5))).toEqual({ allotment: 1, held: 0, available: 1 });
    expect(await inv(s.houseboat.roomTypeId, day(6))).toEqual({ allotment: 1, held: 0, available: 1 });
    expect((await inv(s.houseboat.roomTypeId, day(7))).available).toBe(3); // checkout day untouched

    const outbox = await pool.query(`SELECT payload FROM ari_outbox WHERE hotel_id = $1 AND payload->>'cause' = 'offline_sale'`, [s.houseboat.hotelId]);
    expect(outbox.rowCount).toBe(1);

    const owner = await signIn('owner@houseboat.test');
    const cal = await owner.get(`/api/v1/hotelier/hotels/${s.houseboat.hotelId}/calendar`).query({ from: day(5), days: 3 });
    expect(cal.body.roomTypes[0].days[0]).toMatchObject({ available: 1, soldOffline: 2, priceMinor: NIGHTLY });
    expect(cal.body.roomTypes[0].days[2]).toMatchObject({ available: 3, soldOffline: 0 });

    const act = await owner.get(`/api/v1/hotelier/hotels/${s.houseboat.hotelId}/activity`);
    expect(act.body.activity[0]).toMatchObject({ action: 'RESERVATION_CREATE', user_name: 'Front Desk' });

    const list = await owner.get(`/api/v1/hotelier/hotels/${s.houseboat.hotelId}/reservations`).query({ from: day(0), to: day(30) });
    expect(list.body.reservations.map((x: { guest_name: string }) => x.guest_name)).toContain('Aamir Guest');
  });

  it('refuses to sell more rooms than are left, naming the nights', async () => {
    const desk = await signIn('desk@houseboat.test');
    const r = await desk
      .post(`/api/v1/hotelier/hotels/${s.houseboat.hotelId}/reservations`)
      .set(H)
      .send({ roomTypeId: s.houseboat.roomTypeId, checkIn: day(5), checkOut: day(6), rooms: 2, source: 'PHONE', guestName: 'Too Many' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('SOLD_OUT');
    expect(r.body.error.details.nights[0]).toMatchObject({ date: day(5), available: 1 });
  });

  it('cancel gives the nights back exactly once; terminal statuses cannot change', async () => {
    const desk = await signIn('desk@houseboat.test');
    const created = await desk
      .post(`/api/v1/hotelier/hotels/${s.houseboat.hotelId}/reservations`)
      .set(H)
      .send({ roomTypeId: s.houseboat.roomTypeId, checkIn: day(10), checkOut: day(12), source: 'PHONE', guestName: 'Will Cancel' });
    expect((await inv(s.houseboat.roomTypeId, day(10))).available).toBe(2);

    const url = `/api/v1/hotelier/hotels/${s.houseboat.hotelId}/reservations/${created.body.id}/status`;
    const c = await desk.post(url).set(H).send({ status: 'CANCELLED', remark: 'guest called' });
    expect(c.body.status).toBe('CANCELLED');
    expect((await inv(s.houseboat.roomTypeId, day(10))).available).toBe(3);
    expect((await inv(s.houseboat.roomTypeId, day(11))).available).toBe(3);

    const again = await desk.post(url).set(H).send({ status: 'CHECKED_IN' });
    expect(again.status).toBe(409);
    expect((await inv(s.houseboat.roomTypeId, day(10))).available).toBe(3);
  });

  it('early check-out gives the unused nights back', async () => {
    const desk = await signIn('desk@houseboat.test');
    const created = await desk
      .post(`/api/v1/hotelier/hotels/${s.houseboat.hotelId}/reservations`)
      .set(H)
      .send({ roomTypeId: s.houseboat.roomTypeId, checkIn: day(0), checkOut: day(3), source: 'WALK_IN', guestName: 'Leaves Early' });
    expect(created.status).toBe(201);
    expect((await inv(s.houseboat.roomTypeId, day(1))).available).toBe(2);
    const url = `/api/v1/hotelier/hotels/${s.houseboat.hotelId}/reservations/${created.body.id}/status`;
    await desk.post(url).set(H).send({ status: 'CHECKED_IN' }).expect(200);
    // Guest leaves on day 0 instead of day 3: nights 0, 1 and 2 go back on sale.
    const out = await desk.post(url).set(H).send({ status: 'CHECKED_OUT' });
    expect(out.body).toMatchObject({ status: 'CHECKED_OUT', releasedFrom: day(0) });
    for (const d of [0, 1, 2]) expect((await inv(s.houseboat.roomTypeId, day(d))).available).toBe(3);
  });

  it('a walk-in for a date with no inventory loaded is refused, not oversold', async () => {
    const desk = await signIn('desk@houseboat.test');
    const r = await desk
      .post(`/api/v1/hotelier/hotels/${s.houseboat.hotelId}/reservations`)
      .set(H)
      .send({ roomTypeId: s.houseboat.roomTypeId, checkIn: day(-1), checkOut: day(0), source: 'WALK_IN', guestName: 'No Rows' });
    expect(r.body.error.code).toBe('SOLD_OUT');
    expect(r.body.error.details.nights[0]).toMatchObject({ loaded: false });
  });

  it('channel-manager hotels are told to record offline sales in their CM', async () => {
    const gm = await signIn('gm@gulmarg.test');
    const r = await gm
      .post(`/api/v1/hotelier/hotels/${s.cmHotel.hotelId}/reservations`)
      .set(H)
      .send({ roomTypeId: s.cmHotel.roomTypeId, checkIn: day(3), checkOut: day(4), source: 'WALK_IN', guestName: 'Walk In' });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/managed by STAAH/);
  });

  it('last room: 1 walk-in and 5 online buyers at the same instant = exactly one booking', async () => {
    const owner = await signIn('owner@houseboat.test');
    const ci = day(20);
    const co = day(21);
    await owner
      .put(`/api/v1/hotelier/hotels/${s.houseboat.hotelId}/ari`)
      .set(H)
      .send({ updates: [{ roomTypeId: s.houseboat.roomTypeId, startDate: ci, endDate: ci, availability: 1 }] })
      .expect(200);

    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM daily_inventory WHERE room_type_id = $1 AND stay_date = $2 FOR UPDATE', [s.houseboat.roomTypeId, ci]);

    const desk = await signIn('desk@houseboat.test');
    const offline = desk
      .post(`/api/v1/hotelier/hotels/${s.houseboat.hotelId}/reservations`)
      .set(H)
      .send({ roomTypeId: s.houseboat.roomTypeId, checkIn: ci, checkOut: co, source: 'WALK_IN', guestName: 'Racer' })
      .then((r) => r);
    const online = Array.from({ length: 5 }, () =>
      request(app)
        .post('/api/v1/checkout/live-ping')
        .send({
          hotelId: s.houseboat.hotelId,
          roomTypeId: s.houseboat.roomTypeId,
          checkIn: ci,
          checkOut: co,
          displayedTotalMinor: NIGHTLY,
          customer: { name: 'Online Buyer', email: 'b@example.com', phone: '+919999999999' },
        })
        .then((r) => r),
    );
    const racing = Promise.all([offline, ...online]);
    await new Promise((r) => setTimeout(r, 600));
    await blocker.query('COMMIT');
    blocker.release();
    const results = await racing;

    const wins = results.filter((r) => r.status === 201);
    expect(wins).toHaveLength(1);
    expect(await inv(s.houseboat.roomTypeId, ci)).toMatchObject({ available: 0 });
  });

  it('owner bulk-edits a date range and it is audited', async () => {
    const owner = await signIn('owner@houseboat.test');
    const r = await owner
      .put(`/api/v1/hotelier/hotels/${s.houseboat.hotelId}/ari`)
      .set(H)
      .send({
        updates: [
          { roomTypeId: s.houseboat.roomTypeId, ratePlanId: s.houseboat.ratePlanId, startDate: day(30), endDate: day(36), priceMinor: 990000, minLos: 2 },
          { roomTypeId: s.houseboat.roomTypeId, startDate: day(33), endDate: day(33), stopSell: true },
        ],
      });
    expect(r.status).toBe(200);
    const cal = await owner.get(`/api/v1/hotelier/hotels/${s.houseboat.hotelId}/calendar`).query({ from: day(32), days: 3 });
    expect(cal.body.roomTypes[0].days.map((d: { priceMinor: number; stopSell: boolean }) => [d.priceMinor, d.stopSell])).toEqual([
      [990000, false],
      [990000, true],
      [990000, false],
    ]);
    const act = await owner.get(`/api/v1/hotelier/hotels/${s.houseboat.hotelId}/activity`);
    expect(act.body.activity[0]).toMatchObject({ action: 'ARI_UPDATE', user_name: 'Houseboat Owner' });
    expect(act.body.activity[0].summary).toMatch(/price 9900.00/);
  });
});
