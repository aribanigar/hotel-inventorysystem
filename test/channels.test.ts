/**
 * Channel-manager feature set: room types, derived rate plans, weekday bulk updates,
 * full restriction set, extra-guest pricing, rolling horizon, availability reset,
 * CSV export, and the QloApps-Channel-Manager-compatible PMS API (both directions).
 */
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { createHotelUser } from '../src/dev/createHotelUser.js';
import { seed, type SeedResult } from '../src/dev/seed.js';
import { rollHorizon } from '../src/extranet/setup.js';
import { createApp } from '../src/http/app.js';
import { addDays, todayIn } from '../src/lib/dates.js';
import { processOutboxBatch } from '../src/outbox/worker.js';

const app = createApp();
const PW = 'Kashmir-2026-houseboat';
const H = { 'x-extranet': '1' };
const customer = { name: 'Test Guest', email: 'guest@example.com', phone: '+919999999999' };
let s: SeedResult;
let owner: ReturnType<typeof request.agent>;
let hotelId: string;
const day = (n: number) => addDays(todayIn('Asia/Kolkata'), n);

// ---- mock QloApps Channel Manager -------------------------------------------
const cm = { tokenSeq: 0, validToken: '', pushes: [] as Array<Record<string, unknown>>, tokenCalls: 0 };
let cmServer: Server;

async function signIn(email: string) {
  const a = request.agent(app);
  await a.post('/api/v1/hotelier/session').set(H).send({ email, password: PW }).expect(200);
  return a;
}
const inv = async (roomTypeId: string, date: string) =>
  (await pool.query('SELECT allotment, held, available FROM daily_inventory WHERE room_type_id = $1 AND stay_date = $2', [roomTypeId, date])).rows[0];
const rate = async (ratePlanId: string, date: string) =>
  (await pool.query('SELECT price_minor, min_los, stop_sell FROM daily_rates WHERE rate_plan_id = $1 AND stay_date = $2', [ratePlanId, date])).rows[0];

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  s = await seed({ days: 60, allotment: 3, nightlyMinor: 850000 });
  hotelId = s.houseboat.hotelId;
  await createHotelUser('owner@hb.test', 'HB Owner', hotelId, 'owner', PW);
  owner = await signIn('owner@hb.test');

  cmServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/oauth/token') {
        cm.tokenCalls++;
        cm.validToken = `tok${++cm.tokenSeq}`;
        return res.end(JSON.stringify({ access_token: cm.validToken, token_type: 'Bearer' }));
      }
      if (req.url === '/api/v1/push_ari') {
        if (req.headers.authorization !== `Bearer ${cm.validToken}`) {
          res.statusCode = 401;
          return res.end('{"success":false}');
        }
        cm.pushes.push(JSON.parse(body));
        return res.end('{"success":true}');
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => cmServer.listen(4196, r));
});

afterAll(async () => {
  cmServer.close();
  await pool.end();
});

// ---------------------------------------------------------------------------
describe('room types + rate plans', () => {
  let suiteId: string;
  let suiteRate: string;
  let breakfastPlan: string;

  it('creating a room type opens it for sale with total rooms and a price', async () => {
    const r = await owner.post(`/api/v1/hotelier/hotels/${hotelId}/room-types`).set(H).send({
      name: 'Lake Suite', totalRooms: 2, baseOccupancy: 2, maxAdults: 3, maxChildren: 2, maxInfants: 1, mealPlan: 'EP', priceMinor: 1000000,
    });
    expect(r.status).toBe(201);
    suiteId = r.body.id;
    suiteRate = r.body.ratePlanId;
    expect(await inv(suiteId, day(0))).toMatchObject({ allotment: 2, available: 2 });
    expect(await inv(suiteId, day(364))).toMatchObject({ allotment: 2 });
    expect((await rate(suiteRate, day(10))).price_minor).toBe(1000000);
  });

  it('derived plan: +15% follows the parent, rounded to the rupee, and re-derives on change', async () => {
    const r = await owner.post(`/api/v1/hotelier/hotels/${hotelId}/rate-plans`).set(H).send({
      roomTypeId: suiteId, name: 'With breakfast', mealPlan: 'CP', rateMode: 'DERIVED', parentRatePlanId: suiteRate, deriveType: 'PERCENT', deriveValue: 15,
    });
    expect(r.status).toBe(201);
    breakfastPlan = r.body.id;
    expect((await rate(breakfastPlan, day(5))).price_minor).toBe(1150000);

    // Parent price change on Fri/Sat only (weekday filter) flows into the child.
    const from = day(14);
    const to = day(27);
    await owner.put(`/api/v1/hotelier/hotels/${hotelId}/ari`).set(H)
      .send({ updates: [{ roomTypeId: suiteId, ratePlanId: suiteRate, startDate: from, endDate: to, weekdays: [5, 6], priceMinor: 1234500 }] })
      .expect(200);
    for (let i = 14; i <= 27; i++) {
      const d = day(i);
      const dow = new Date(d + 'T00:00:00Z').getUTCDay();
      const parent = (await rate(suiteRate, d)).price_minor;
      const child = (await rate(breakfastPlan, d)).price_minor;
      expect(parent).toBe(dow === 5 || dow === 6 ? 1234500 : 1000000);
      expect(child).toBe(dow === 5 || dow === 6 ? 1419700 : 1150000); // 12345 * 1.15 = 14196.75 -> 14197
    }
  });

  it("a derived plan's price can't be edited directly", async () => {
    const r = await owner.put(`/api/v1/hotelier/hotels/${hotelId}/ari`).set(H)
      .send({ updates: [{ roomTypeId: suiteId, ratePlanId: breakfastPlan, startDate: day(3), endDate: day(3), priceMinor: 100 }] });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/derived/);
  });

  it('changing total rooms shifts future availability by the difference (sold stays sold)', async () => {
    const desk = owner;
    await desk.post(`/api/v1/hotelier/hotels/${hotelId}/reservations`).set(H)
      .send({ roomTypeId: suiteId, checkIn: day(8), checkOut: day(9), source: 'PHONE', guestName: 'Sold One' }).expect(201);
    expect(await inv(suiteId, day(8))).toMatchObject({ allotment: 1 });
    const r = await owner.put(`/api/v1/hotelier/hotels/${hotelId}/room-types/${suiteId}`).set(H)
      .send({ name: 'Lake Suite', totalRooms: 4, baseOccupancy: 2, maxAdults: 3, maxChildren: 2, maxInfants: 1 });
    expect(r.body.shiftedBy).toBe(2);
    expect(await inv(suiteId, day(8))).toMatchObject({ allotment: 3 }); // 4 total - 1 sold
    expect(await inv(suiteId, day(9))).toMatchObject({ allotment: 4 });
  });

  it('reset availability repairs drift from total rooms minus bookings', async () => {
    await pool.query('UPDATE daily_inventory SET allotment = 0 WHERE room_type_id = $1 AND stay_date BETWEEN $2 AND $3', [suiteId, day(8), day(12)]);
    const r = await owner.post(`/api/v1/hotelier/hotels/${hotelId}/reset-availability`).set(H).send({ roomTypeId: suiteId });
    expect(r.body.nightsCorrected).toBe(5);
    expect(await inv(suiteId, day(8))).toMatchObject({ allotment: 3 });
    expect(await inv(suiteId, day(10))).toMatchObject({ allotment: 4 });
  });

  it('rolling horizon fills missing future nights and carries rates forward', async () => {
    await pool.query('DELETE FROM daily_inventory WHERE room_type_id = $1 AND stay_date > $2', [suiteId, day(300)]);
    await pool.query('DELETE FROM daily_rates WHERE rate_plan_id = $1 AND stay_date > $2', [suiteRate, day(300)]);
    await pool.query('DELETE FROM daily_rates WHERE rate_plan_id = $1 AND stay_date > $2', [breakfastPlan, day(300)]);
    expect(await inv(suiteId, day(320))).toBeUndefined();
    const added = await rollHorizon(hotelId);
    expect(added).toBeGreaterThan(0);
    expect(await inv(suiteId, day(320))).toMatchObject({ allotment: 4 });
    expect((await rate(suiteRate, day(320))).price_minor).toBe(1000000);
    expect((await rate(breakfastPlan, day(320))).price_minor).toBe(1150000);
  });

  it('checkout applies extra-adult pricing, stay-through and booking-window rules', async () => {
    const ci = day(40);
    const co = day(42);
    await owner.put(`/api/v1/hotelier/hotels/${hotelId}/ari`).set(H)
      .send({ updates: [{ roomTypeId: suiteId, ratePlanId: suiteRate, startDate: ci, endDate: co, extraAdultMinor: 150000 }] }).expect(200);
    const ping = (b: Record<string, unknown>) =>
      request(app).post('/api/v1/checkout/live-ping').send({ hotelId, roomTypeId: suiteId, checkIn: ci, checkOut: co, customer, ...b });

    // 3 adults in one suite (base 2): 2 nights x (10,000 + 1,500) = 23,000.
    const wrong = await ping({ adults: 3, displayedTotalMinor: 2000000 });
    expect(wrong.body.error.code).toBe('PRICE_CHANGED');
    expect(wrong.body.error.details.liveTotalMinor).toBe(2300000);

    // Stay-through: the middle night needs a 3-night stay.
    await owner.put(`/api/v1/hotelier/hotels/${hotelId}/ari`).set(H)
      .send({ updates: [{ roomTypeId: suiteId, ratePlanId: suiteRate, startDate: day(41), endDate: day(41), minStayThrough: 3 }] }).expect(200);
    const through = await ping({ adults: 2, displayedTotalMinor: 2000000 });
    expect(through.body.error).toMatchObject({ code: 'RESTRICTED', details: { reason: 'MIN_LOS' } });

    // Booking window: must book at least 60 days ahead.
    await owner.put(`/api/v1/hotelier/hotels/${hotelId}/ari`).set(H)
      .send({ updates: [{ roomTypeId: suiteId, ratePlanId: suiteRate, startDate: day(45), endDate: day(45), minAdvanceDays: 60 }] }).expect(200);
    const early = await request(app).post('/api/v1/checkout/live-ping')
      .send({ hotelId, roomTypeId: suiteId, checkIn: day(45), checkOut: day(46), customer, displayedTotalMinor: 1000000 });
    expect(early.body.error).toMatchObject({ code: 'RESTRICTED', details: { reason: 'ADVANCE_PURCHASE' } });
  });

  it('CSV export neutralises spreadsheet formulas', async () => {
    await owner.post(`/api/v1/hotelier/hotels/${hotelId}/reservations`).set(H)
      .send({ roomTypeId: suiteId, checkIn: day(50), checkOut: day(51), source: 'WALK_IN', guestName: '=HYPERLINK("x")' }).expect(201);
    const r = await owner.get(`/api/v1/hotelier/hotels/${hotelId}/reservations.csv`).query({ from: day(0), to: day(60) });
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.text).toContain(`"'=HYPERLINK(""x"")"`);
    expect(r.text).not.toMatch(/,=HYPERLINK/);
  });
});

// ---------------------------------------------------------------------------
describe('QloApps Channel Manager compatible PMS API', () => {
  let wsKey: string;
  let hotelPms: number;
  let roomPms: number;
  const api = (path: string) => request(app).get(`/api/cm_api/${path}`).auth(wsKey, '');

  it('owner connects the hotel and gets a webservice key once', async () => {
    const r = await owner.post(`/api/v1/hotelier/hotels/${hotelId}/channels/qloapps`).set(H)
      .send({ clientId: 'client-abc', clientSecret: 'secret-1234567', baseUrl: 'http://127.0.0.1:4196' });
    expect(r.status).toBe(200);
    expect(r.body.webserviceKey).toMatch(/^[0-9A-F]{32}$/);
    wsKey = r.body.webserviceKey;
    const again = await owner.post(`/api/v1/hotelier/hotels/${hotelId}/channels/qloapps`).set(H)
      .send({ clientId: 'client-abc', clientSecret: 'secret-1234567', baseUrl: 'http://127.0.0.1:4196' });
    expect(again.body.webserviceKey).toBeNull(); // never shown twice
  });

  it('rejects bad keys; test_connection, properties and room_types match the CM shape', async () => {
    expect((await request(app).get('/api/cm_api/properties').auth('WRONG', '')).status).toBe(401);
    expect((await api('test_connection')).body).toMatchObject({ success: true, QLO_VERSION: '1.7.0.0' });
    const props = await request(app).get('/api/cm_api/properties').query({ ws_key: wsKey });
    expect(props.body.data).toHaveLength(1);
    hotelPms = props.body.data[0].id;
    expect(props.body.data[0]).toMatchObject({ name: 'Sample Houseboat Dal Lake', currency: 'INR', timezone: 'Asia/Kolkata' });
    const rooms = await api(`room_types?filter[id_property]=${hotelPms}`);
    const deluxe = rooms.body.data.find((x: { name: string }) => x.name === 'Deluxe Bedroom');
    roomPms = deluxe.id;
    expect(deluxe).toMatchObject({ total_rooms: 3, max_adults: 3, base_occupancy: 2 });
  });

  it('GET ari returns merged ranges with real restrictions', async () => {
    const r = await api(`ari?filter[id_property]=${hotelPms}&filter[id_room_type]=${roomPms}&filter[date_from]=${day(0)}&filter[date_to]=${day(9)}`);
    const info = r.body.data[0].ari_info;
    expect(info[0]).toMatchObject({ id_pms_room_type: String(roomPms), date_from: day(0), date_to: day(9), availability: 3 });
    expect(JSON.parse(info[0].rates[0])).toMatchObject({ price_with_tax: 8500, min_los_arrival: 1, stop_sell: 0 });
  });

  it('booking_notification new: takes rooms, records the OTA, de-duplicates retries', async () => {
    const body = {
      id_property: hotelPms,
      id_channel_manager_booking: 'BDC-778899',
      booking_status: 'new',
      currency: 'INR',
      source: 'Booking.com',
      guest_detail: { firstname: 'Asha', lastname: 'Mir', email: 'asha@example.com', phone: '+919000000000' },
      price_details: { total_price_with_tax: '17000.00' },
      room_bookings: [{ id_room_type: roomPms, check_in_date: day(20), check_out_date: day(22), number_of_rooms: 1, rooms: [{ occupancy: { adults: 2, children: 0 } }] }],
    };
    const post = () => request(app).post('/api/cm_api/booking_notification').auth(wsKey, '').set('content-type', 'text/plain').send(JSON.stringify(body));
    const r = await post();
    expect(r.body.data).toMatchObject({ id_channel_manager_booking: 'BDC-778899', id_property: hotelPms, source: 'Booking.com', overbooked: false });
    expect(await inv(s.houseboat.roomTypeId, day(20))).toMatchObject({ allotment: 2 });
    await post(); // CM retry
    expect(await inv(s.houseboat.roomTypeId, day(20))).toMatchObject({ allotment: 2 });
    const live = await pool.query(`SELECT count(*)::int AS n FROM reservations WHERE cm_booking_id = 'BDC-778899' AND status = 'CONFIRMED'`);
    expect(live.rows[0].n).toBe(1);
  });

  it('modified moves the stay; cancelled gives the rooms back', async () => {
    const base = {
      id_property: hotelPms, id_channel_manager_booking: 'BDC-778899', currency: 'INR', source: 'Booking.com',
      guest_detail: { firstname: 'Asha', lastname: 'Mir', email: 'asha@example.com' },
    };
    await request(app).post('/api/cm_api/booking_notification').auth(wsKey, '')
      .send({ ...base, booking_status: 'modified', room_bookings: [{ id_room_type: roomPms, check_in_date: day(25), check_out_date: day(26), number_of_rooms: 2 }] })
      .expect(200);
    expect(await inv(s.houseboat.roomTypeId, day(20))).toMatchObject({ allotment: 3 }); // old dates released
    expect(await inv(s.houseboat.roomTypeId, day(25))).toMatchObject({ allotment: 1 }); // 2 rooms taken
    await request(app).post('/api/cm_api/booking_notification').auth(wsKey, '').send({ ...base, booking_status: 'cancelled' }).expect(200);
    expect(await inv(s.houseboat.roomTypeId, day(25))).toMatchObject({ allotment: 3 });
  });

  it('an OTA booking for a sold-out night is recorded and flagged, never lost', async () => {
    await pool.query('UPDATE daily_inventory SET allotment = 0 WHERE room_type_id = $1 AND stay_date = $2', [s.houseboat.roomTypeId, day(30)]);
    const r = await request(app).post('/api/cm_api/booking_notification').auth(wsKey, '').send({
      id_property: hotelPms, id_channel_manager_booking: 'AGODA-1', booking_status: 'new', currency: 'INR', source: 'Agoda',
      guest_detail: { firstname: 'Late', lastname: 'Guest', email: 'l@example.com' },
      room_bookings: [{ id_room_type: roomPms, check_in_date: day(30), check_out_date: day(31), number_of_rooms: 1 }],
    });
    expect(r.body.data.overbooked).toBe(true);
    expect(await inv(s.houseboat.roomTypeId, day(30))).toMatchObject({ allotment: 0 });
  });

  it('pushes ARI to the CM from the outbox, refreshing an expired OAuth token', async () => {
    cm.validToken = 'rotated-on-server'; // whatever token we cached is now stale
    cm.pushes.length = 0;
    await owner.put(`/api/v1/hotelier/hotels/${hotelId}/ari`).set(H)
      .send({ updates: [{ roomTypeId: s.houseboat.roomTypeId, ratePlanId: s.houseboat.ratePlanId, startDate: day(33), endDate: day(34), priceMinor: 990000, closedToArrival: true }] })
      .expect(200);
    for (let i = 0; i < 5 && !cm.pushes.length; i++) await processOutboxBatch(100);
    expect(cm.pushes.length).toBeGreaterThan(0);
    const all = cm.pushes.flatMap((p) => (p as { ari_info: Array<{ date_from: string; rates: string[] }> }).ari_info);
    const hit = all.find((a) => a.date_from === day(33));
    expect(hit).toBeDefined();
    expect(JSON.parse(hit!.rates[0])).toMatchObject({ price_with_tax: 9900, close_to_arrival: 1 });
    const acct = (await pool.query('SELECT last_push_error, last_push_at FROM cm_accounts')).rows[0];
    expect(acct.last_push_error).toBeNull();
    expect(acct.last_push_at).not.toBeNull();
  });

  it('channel health lists the CM link with no failures', async () => {
    const r = await owner.get(`/api/v1/hotelier/hotels/${hotelId}/channels`);
    expect(r.body.qloappsChannelManager).toMatchObject({ pushEnabled: true, failed: 0 });
  });
});
