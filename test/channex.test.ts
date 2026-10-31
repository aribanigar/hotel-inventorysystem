/**
 * Direct Channex connection, against a mock Channex server:
 * connect, create + map, full sync (2 calls), true deltas, rate-limit backoff,
 * the booking feed (new / re-delivered / modified / cancelled / overbooked / unmapped),
 * webhook security and the OTA connection link.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pullChannexBookings } from '../src/channels/channex/bookings.js';
import { pushDueChannexProperties } from '../src/channels/channex/ari.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { createHotelUser } from '../src/dev/createHotelUser.js';
import { seed, type SeedResult } from '../src/dev/seed.js';
import { rollHorizon } from '../src/extranet/setup.js';
import { createApp } from '../src/http/app.js';
import { addDays, todayIn } from '../src/lib/dates.js';

const app = createApp();
const PW = 'Kashmir-2026-houseboat';
const H = { 'x-extranet': '1' };
const API_KEY = 'test-channex-api-key';
const WEBHOOK_SECRET = 'test-channex-webhook-secret-0123';
const HMAC_SECRET = 'test-channex-hmac-secret';
const day = (n: number) => addDays(todayIn('Asia/Kolkata'), n);

let s: SeedResult;
let owner: ReturnType<typeof request.agent>;
let hotelId: string;
let roomTypeId: string;
let ratePlanId: string;
let derivedPlanId: string;

// ---- mock Channex -------------------------------------------------------------
interface Call {
  method: string;
  path: string;
  body: any;
}
const cx = {
  calls: [] as Call[],
  propertyId: randomUUID(),
  roomTypes: [] as Array<{ id: string; title: string }>,
  ratePlans: [] as Array<{ id: string; title: string; room_type_id: string }>,
  feed: [] as Array<{ id: string; attributes: Record<string, unknown> }>,
  acked: [] as string[],
  failNext: 0 as number, // respond 429 to the next N ARI calls
  badKey: 0,
};
let server: Server;
const ariCalls = () => cx.calls.filter((c) => c.path === '/api/v1/availability' || c.path === '/api/v1/restrictions');

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  s = await seed({ days: 60, allotment: 3, nightlyMinor: 850000 });
  hotelId = s.houseboat.hotelId;
  roomTypeId = s.houseboat.roomTypeId;
  ratePlanId = s.houseboat.ratePlanId;
  await createHotelUser('owner@cx.test', 'CX Owner', hotelId, 'owner', PW);
  owner = request.agent(app);
  await owner.post('/api/v1/hotelier/session').set(H).send({ email: 'owner@cx.test', password: PW }).expect(200);

  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      const body = raw ? JSON.parse(raw) : null;
      cx.calls.push({ method: req.method!, path: url.pathname, body });
      res.setHeader('content-type', 'application/json');
      const send = (status: number, json: unknown) => {
        res.statusCode = status;
        res.end(JSON.stringify(json));
      };
      if (req.headers['user-api-key'] !== API_KEY) return send(401, { errors: { code: 'unauthorized', title: 'Unauthorized' } });
      const p = url.pathname;
      if (req.method === 'POST' && p === '/api/v1/properties') return send(201, { data: { type: 'property', id: cx.propertyId, attributes: { title: body.property.title } } });
      if (req.method === 'GET' && p === `/api/v1/properties/${cx.propertyId}`) return send(200, { data: { id: cx.propertyId, attributes: { currency: 'INR' } } });
      if (req.method === 'GET' && p.startsWith('/api/v1/properties/')) return send(404, { errors: { code: 'not_found', title: 'Not found' } });
      if (req.method === 'POST' && p === '/api/v1/room_types') {
        const id = randomUUID();
        cx.roomTypes.push({ id, title: body.room_type.title });
        return send(201, { data: { id, attributes: { title: body.room_type.title } } });
      }
      if (req.method === 'POST' && p === '/api/v1/rate_plans') {
        const id = randomUUID();
        cx.ratePlans.push({ id, title: body.rate_plan.title, room_type_id: body.rate_plan.room_type_id });
        return send(201, { data: { id, attributes: { title: body.rate_plan.title } } });
      }
      if (req.method === 'GET' && p === '/api/v1/room_types') return send(200, { data: cx.roomTypes.map((r) => ({ id: r.id, attributes: { title: r.title } })) });
      if (req.method === 'GET' && p === '/api/v1/rate_plans') return send(200, { data: cx.ratePlans.map((r) => ({ id: r.id, attributes: { title: r.title, room_type_id: r.room_type_id } })) });
      if (req.method === 'POST' && (p === '/api/v1/availability' || p === '/api/v1/restrictions')) {
        if (cx.failNext > 0) {
          cx.failNext--;
          return send(429, { errors: { code: 'http_too_many_requests', title: 'Too Many Requests' } });
        }
        return send(200, { data: [{ id: randomUUID(), type: 'task' }], meta: { message: 'Success', warnings: [] } });
      }
      if (req.method === 'GET' && p === '/api/v1/booking_revisions/feed') {
        return send(200, { data: cx.feed.filter((f) => !cx.acked.includes(f.id)).slice(0, 100), meta: { page: 1, limit: 100 } });
      }
      const ack = p.match(/^\/api\/v1\/booking_revisions\/([0-9a-f-]+)\/ack$/);
      if (req.method === 'POST' && ack) {
        cx.acked.push(ack[1]);
        return send(200, { meta: { message: 'Success' } });
      }
      if (req.method === 'POST' && p === '/api/v1/auth/one_time_token') return send(200, { data: { token: 'one-time-token-123' } });
      send(404, { errors: { code: 'not_found', title: 'Not found' } });
    });
  });
  await new Promise<void>((r) => server.listen(4197, '127.0.0.1', r));
});

afterAll(async () => {
  server.close();
  await pool.end();
});

beforeEach(() => {
  cx.calls = [];
});

const inv = async (rt: string, d: string) =>
  (await pool.query('SELECT allotment, available FROM daily_inventory WHERE room_type_id = $1 AND stay_date = $2', [rt, d])).rows[0];
/** Runs the push loop once with the throttle window open. */
async function push() {
  await pool.query('UPDATE channex_properties SET next_push_at = now() - interval \'1 second\'');
  return pushDueChannexProperties();
}
/** Expands Channex ranges into per-night values for one entity. */
function nights(values: Array<Record<string, any>>, key: 'room_type_id' | 'rate_plan_id', id: string) {
  const out = new Map<string, Record<string, any>>();
  for (const v of values.filter((x) => x[key] === id)) {
    for (let d = v.date_from; d <= v.date_to; d = addDays(d, 1)) out.set(d, v);
  }
  return out;
}

// ---------------------------------------------------------------------------
describe('connect + mapping', () => {
  it('rejects an unknown existing property and links a new one', async () => {
    const bad = await owner.post(`/api/v1/hotelier/hotels/${hotelId}/channels/channex`).set(H).send({ mode: 'link', propertyId: randomUUID() });
    expect(bad.status).toBe(404);
    const r = await owner.post(`/api/v1/hotelier/hotels/${hotelId}/channels/channex`).set(H).send({ mode: 'create' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ connected: true, propertyId: cx.propertyId });
    const created = cx.calls.find((c) => c.path === '/api/v1/properties');
    expect(created?.body.property).toMatchObject({ currency: 'INR', settings: { min_stay_type: 'both' } });

    const st = await owner.get(`/api/v1/hotelier/hotels/${hotelId}/channels/channex`).set(H);
    expect(st.body).toMatchObject({ configured: true, connected: true, unmapped: { rooms: 1, ratePlans: 1 } });
  });

  it('creates missing room types and rate plans in Channex and maps them (derived plans too)', async () => {
    const d = await owner.post(`/api/v1/hotelier/hotels/${hotelId}/rate-plans`).set(H).send({
      roomTypeId, name: 'Room only', mealPlan: 'EP', rateMode: 'DERIVED', parentRatePlanId: ratePlanId, deriveType: 'PERCENT', deriveValue: -10,
    });
    expect(d.status).toBe(201);
    derivedPlanId = d.body.id;

    const r = await owner.post(`/api/v1/hotelier/hotels/${hotelId}/channels/channex/create-missing`).set(H).send({});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ roomTypes: 1, ratePlans: 2 });
    const room = cx.calls.find((c) => c.path === '/api/v1/room_types')!.body.room_type;
    expect(room).toMatchObject({ property_id: cx.propertyId, count_of_rooms: 3, occ_adults: 3 });
    const plans = cx.calls.filter((c) => c.path === '/api/v1/rate_plans').map((c) => c.body.rate_plan);
    // We always send final prices, so Channex never re-derives: both plans are manual.
    expect(plans.every((p) => p.rate_mode === 'manual' && p.sell_mode === 'per_room')).toBe(true);
    expect(plans.map((p) => p.meal_type).sort()).toEqual(['half_board', 'room_only']);

    const st = await owner.get(`/api/v1/hotelier/hotels/${hotelId}/channels/channex`).set(H);
    expect(st.body.unmapped).toEqual({ rooms: 0, ratePlans: 0 });
    // Running it again creates nothing.
    const again = await owner.post(`/api/v1/hotelier/hotels/${hotelId}/channels/channex/create-missing`).set(H).send({});
    expect(again.body).toEqual({ roomTypes: 0, ratePlans: 0 });
  });

  it('refuses a mapping to a rate plan of another room type', async () => {
    const otherRoom = randomUUID();
    cx.roomTypes.push({ id: otherRoom, title: 'Other' });
    const otherRate = randomUUID();
    cx.ratePlans.push({ id: otherRate, title: 'Other rate', room_type_id: otherRoom });
    const r = await owner.put(`/api/v1/hotelier/hotels/${hotelId}/channels/channex/mapping`).set(H)
      .send({ ratePlans: [{ ratePlanId, channexRatePlanId: otherRate }] });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/different room type/);
  });
});

describe('ARI push', () => {
  it('full sync = exactly 2 calls covering 500 days, merged into ranges', async () => {
    await rollHorizon(hotelId); // open the hotel's 365-day selling window
    await owner.post(`/api/v1/hotelier/hotels/${hotelId}/channels/channex/full-sync`).set(H).send({}).expect(200);
    const n = await push();
    expect(n).toBe(2);
    const [avail, restr] = [ariCalls().find((c) => c.path.endsWith('availability'))!, ariCalls().find((c) => c.path.endsWith('restrictions'))!];
    const cxRoom = (await pool.query('SELECT channex_room_type_id FROM channex_room_map WHERE room_type_id = $1', [roomTypeId])).rows[0].channex_room_type_id;
    const cxRate = (await pool.query('SELECT channex_rate_plan_id FROM channex_rate_map WHERE rate_plan_id = $1', [ratePlanId])).rows[0].channex_rate_plan_id;
    const cxDerived = (await pool.query('SELECT channex_rate_plan_id FROM channex_rate_map WHERE rate_plan_id = $1', [derivedPlanId])).rows[0].channex_rate_plan_id;

    const a = nights(avail.body.values, 'room_type_id', cxRoom);
    expect(a.size).toBe(500);
    expect(a.get(day(0))!.availability).toBe(3);
    expect(avail.body.values.length).toBeLessThan(10); // identical nights merged

    const r = nights(restr.body.values, 'rate_plan_id', cxRate);
    expect(r.size).toBe(500);
    expect(r.get(day(1))).toMatchObject({ rate: 850000, min_stay_arrival: 1, stop_sell: false, closed_to_arrival: false });
    expect(nights(restr.body.values, 'rate_plan_id', cxDerived).get(day(1))!.rate).toBe(765000); // -10%
    // Beyond the loaded rates: not sellable, so stop-sell, no rate sent.
    expect(r.get(day(450))).toMatchObject({ stop_sell: true });
    expect(r.get(day(450))!.rate).toBeUndefined();

    // Nothing changed since: the next push sends nothing.
    await pool.query(`INSERT INTO channex_dirty (hotel_id, date_from, date_to) VALUES ($1, $2, $3)`, [hotelId, day(0), day(30)]);
    cx.calls = [];
    expect(await push()).toBe(0);
    expect(ariCalls()).toHaveLength(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM channex_dirty')).rows[0].n).toBe(0);
  });

  it('a weekend price change sends one restrictions call with only those nights (parent + derived)', async () => {
    await owner.put(`/api/v1/hotelier/hotels/${hotelId}/ari`).set(H)
      .send({ updates: [{ roomTypeId, ratePlanId, startDate: day(7), endDate: day(20), weekdays: [5, 6], priceMinor: 990000, minLos: 2 }] })
      .expect(200);
    expect(await push()).toBe(1);
    const calls = ariCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/v1/restrictions');
    const sent = new Set<string>();
    for (const v of calls[0].body.values) for (let d = v.date_from; d <= v.date_to; d = addDays(d, 1)) sent.add(d);
    for (const d of sent) expect([5, 6]).toContain(new Date(d + 'T00:00:00Z').getUTCDay());
    expect(sent.size).toBe(4); // 2 weekends x 2 nights
    // Parent at the new price, the derived plan follows at -10%, on the same nights.
    const cxRate = (await pool.query('SELECT channex_rate_plan_id FROM channex_rate_map WHERE rate_plan_id = $1', [ratePlanId])).rows[0].channex_rate_plan_id;
    const parent = nights(calls[0].body.values, 'rate_plan_id', cxRate);
    const child = [...sent].filter((d) => !parent.has(d));
    expect(parent.size).toBe(4);
    expect(child).toHaveLength(0);
    for (const v of calls[0].body.values) {
      if (v.rate_plan_id === cxRate) expect(v).toMatchObject({ rate: 990000, min_stay_arrival: 2 });
      else expect(v.rate).toBe(891000);
    }
  });

  it('a walk-in sale sends one availability call for exactly the sold nights', async () => {
    await owner.post(`/api/v1/hotelier/hotels/${hotelId}/reservations`).set(H)
      .send({ roomTypeId, checkIn: day(3), checkOut: day(5), source: 'WALK_IN', guestName: 'Walk In' }).expect(201);
    expect(await push()).toBe(1);
    const calls = ariCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/v1/availability');
    expect(calls[0].body.values).toEqual([expect.objectContaining({ date_from: day(3), date_to: day(4), availability: 2 })]);
  });

  it('backs off on 429 and keeps the change until it is delivered', async () => {
    await owner.put(`/api/v1/hotelier/hotels/${hotelId}/ari`).set(H)
      .send({ updates: [{ roomTypeId, startDate: day(10), endDate: day(10), availability: 1 }] }).expect(200);
    cx.failNext = 1;
    expect(await push()).toBe(0);
    const p = (await pool.query(`SELECT consecutive_failures, next_push_at > now() + interval '50 seconds' AS paused, last_push_error FROM channex_properties`)).rows[0];
    expect(p).toMatchObject({ consecutive_failures: 1, paused: true });
    expect(p.last_push_error).toMatch(/rate limit/);
    // Paused: the loop does not touch it.
    expect(await pushDueChannexProperties()).toBe(0);
    // After the pause, the same change goes out.
    cx.calls = [];
    expect(await push()).toBe(1);
    expect(ariCalls()[0].body.values).toEqual([expect.objectContaining({ date_from: day(10), date_to: day(10), availability: 1 })]);
    expect((await pool.query('SELECT consecutive_failures FROM channex_properties')).rows[0].consecutive_failures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('bookings from Channex', () => {
  let cxRoom: string;
  let cxRate: string;
  const bookingId = randomUUID();
  const revision = (status: string, rooms: Array<{ ci: string; co: string }>, extra: Record<string, unknown> = {}, bid = bookingId) => ({
    id: randomUUID(),
    attributes: {
      booking_id: bid, property_id: cx.propertyId, status, ota_name: 'Booking.com', ota_reservation_code: '4711000123',
      amount: '17000.00', currency: 'INR', customer: { name: 'Riya', surname: 'Kaul', mail: 'riya@example.com', phone: '+91 90000 00000' },
      rooms: rooms.map((r) => ({ room_type_id: cxRoom, rate_plan_id: cxRate, checkin_date: r.ci, checkout_date: r.co, occupancy: { adults: 2, children: 0, infants: 0 } })),
      ...extra,
    },
  });
  const live = async (bid = bookingId) =>
    (await pool.query(`SELECT * FROM reservations WHERE channex_booking_id = $1 AND status = 'CONFIRMED' ORDER BY check_in`, [bid])).rows;

  beforeAll(async () => {
    cxRoom = (await pool.query('SELECT channex_room_type_id FROM channex_room_map WHERE room_type_id = $1', [roomTypeId])).rows[0].channex_room_type_id;
    cxRate = (await pool.query('SELECT channex_rate_plan_id FROM channex_rate_map WHERE rate_plan_id = $1', [ratePlanId])).rows[0].channex_rate_plan_id;
  });

  it('new booking: rooms taken, saved, then acknowledged; availability goes back out', async () => {
    const before = (await inv(roomTypeId, day(20))).available;
    const rev = revision('new', [{ ci: day(20), co: day(22) }, { ci: day(20), co: day(22) }]);
    cx.feed.push(rev);
    expect(await pullChannexBookings()).toBe(1);
    const rows = await live();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rooms: 2, adults: 4, source: 'CHANNEL_MANAGER', source_detail: 'Booking.com', guest_name: 'Riya Kaul', amount_minor: 1700000 });
    expect(rows[0].reference).toMatch(/^CX-4711000123-/);
    expect((await inv(roomTypeId, day(20))).available).toBe(before - 2);
    expect(cx.acked).toContain(rev.id);

    expect(await push()).toBe(1);
    expect(ariCalls()[0].body.values).toEqual([expect.objectContaining({ date_from: day(20), date_to: day(21), availability: before - 2 })]);
  });

  it('a revision seen again (ack was lost) is acknowledged without booking twice', async () => {
    const rev = cx.feed[cx.feed.length - 1];
    cx.acked = cx.acked.filter((id) => id !== rev.id);
    expect(await pullChannexBookings()).toBe(0);
    expect(await live()).toHaveLength(1);
    expect(cx.acked).toContain(rev.id);
  });

  it('modified moves the nights; cancelled gives them back', async () => {
    const a20 = (await inv(roomTypeId, day(20))).available;
    const a25 = (await inv(roomTypeId, day(25))).available;
    cx.feed.push(revision('modified', [{ ci: day(25), co: day(26) }]));
    await pullChannexBookings();
    const rows = await live();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rooms: 1 });
    expect((await inv(roomTypeId, day(20))).available).toBe(a20 + 2);
    expect((await inv(roomTypeId, day(25))).available).toBe(a25 - 1);

    cx.feed.push(revision('cancelled', []));
    await pullChannexBookings();
    expect(await live()).toHaveLength(0);
    expect((await inv(roomTypeId, day(25))).available).toBe(a25);
  });

  it('an OTA booking for a sold-out night is still recorded, flagged overbooked, never negative', async () => {
    await owner.put(`/api/v1/hotelier/hotels/${hotelId}/ari`).set(H)
      .send({ updates: [{ roomTypeId, startDate: day(30), endDate: day(30), availability: 0 }] }).expect(200);
    const bid = randomUUID();
    cx.feed.push(revision('new', [{ ci: day(30), co: day(31) }], {}, bid));
    await pullChannexBookings();
    const rows = await live(bid);
    expect(rows).toHaveLength(1);
    expect(rows[0].overbooked).toBe(true);
    expect(await inv(roomTypeId, day(30))).toMatchObject({ allotment: 0, available: 0 });
  });

  it('an unmapped room is not applied or acknowledged, and later revisions of it wait', async () => {
    const bid = randomUUID();
    const bad = revision('new', [{ ci: day(40), co: day(41) }], {}, bid);
    (bad.attributes.rooms as any)[0].room_type_id = randomUUID();
    cx.feed.push(bad);
    const cancel = revision('cancelled', [], {}, bid);
    cx.feed.push(cancel);
    await pullChannexBookings();
    expect(cx.acked).not.toContain(bad.id);
    expect(cx.acked).not.toContain(cancel.id);
    const st = await owner.get(`/api/v1/hotelier/hotels/${hotelId}/channels/channex`).set(H);
    expect(st.body.failedBookings.map((f: any) => f.revision_id)).toEqual(expect.arrayContaining([bad.id, cancel.id]));
    expect(st.body.failedBookings.find((f: any) => f.revision_id === bad.id).error).toMatch(/not mapped/);
    // Clean up so later tests see an empty feed.
    cx.feed = cx.feed.filter((f) => f.id !== bad.id && f.id !== cancel.id);
    await pool.query(`DELETE FROM channex_booking_revisions WHERE booking_id = $1`, [bid]);
  });
});

// ---------------------------------------------------------------------------
describe('webhook + OTA link', () => {
  const sign = (raw: string, ts = Math.floor(Date.now() / 1000)) => ({
    'x-hmac-timestamp': String(ts),
    'x-hmac-signature-256': createHmac('sha256', HMAC_SECRET).update(`${ts}.${raw}`).digest('hex'),
  });

  it('refuses a wrong secret or a bad signature', async () => {
    const raw = JSON.stringify({ event: 'booking', property_id: cx.propertyId });
    const noSecret = await request(app).post('/api/v1/channex/webhook').set('content-type', 'application/json').set(sign(raw)).send(raw);
    expect(noSecret.status).toBe(401);
    const badSig = await request(app).post('/api/v1/channex/webhook').set('content-type', 'application/json')
      .set('x-channex-webhook-secret', WEBHOOK_SECRET).set(sign(raw + ' ')).send(raw);
    expect(badSig.status).toBe(401);
    const old = await request(app).post('/api/v1/channex/webhook').set('content-type', 'application/json')
      .set('x-channex-webhook-secret', WEBHOOK_SECRET).set(sign(raw, Math.floor(Date.now() / 1000) - 3600)).send(raw);
    expect(old.status).toBe(401);
  });

  it('a signed booking event pulls the feed at once', async () => {
    const bid = randomUUID();
    const cxRoom = (await pool.query('SELECT channex_room_type_id FROM channex_room_map WHERE room_type_id = $1', [roomTypeId])).rows[0].channex_room_type_id;
    const revId = randomUUID();
    cx.feed.push({
      id: revId,
      attributes: { booking_id: bid, property_id: cx.propertyId, status: 'new', ota_name: 'Agoda', arrival_date: day(45), departure_date: day(46),
        rooms: [{ room_type_id: cxRoom, occupancy: { adults: 1 } }] },
    });
    const raw = JSON.stringify({ event: 'booking', property_id: cx.propertyId, payload: { booking_id: bid, revision_id: revId } });
    const r = await request(app).post('/api/v1/channex/webhook').set('content-type', 'application/json')
      .set('x-channex-webhook-secret', WEBHOOK_SECRET).set(sign(raw)).send(raw);
    expect(r.status).toBe(200);
    await pullChannexBookings(); // joins the in-flight pull started by the webhook
    const rows = (await pool.query(`SELECT source_detail, rate_plan_id FROM reservations WHERE channex_booking_id = $1`, [bid])).rows;
    expect(rows).toEqual([{ source_detail: 'Agoda', rate_plan_id: ratePlanId }]); // no rate in revision: default plan
    expect(cx.acked).toContain(revId);
  });

  it('gives the owner a one-time link to connect OTAs in Channex', async () => {
    const r = await owner.post(`/api/v1/hotelier/hotels/${hotelId}/channels/channex/ota-link`).set(H).send({});
    expect(r.status).toBe(200);
    const u = new URL(r.body.url);
    expect(u.pathname).toBe('/auth/exchange');
    expect(u.searchParams.get('oauth_session_key')).toBe('one-time-token-123');
    expect(u.searchParams.get('property_id')).toBe(cx.propertyId);
    expect(u.searchParams.get('redirect_to')).toBe('/channels');
  });

  it('disconnect stops pushes and clears the mapping', async () => {
    await owner.delete(`/api/v1/hotelier/hotels/${hotelId}/channels/channex`).set(H).expect(200);
    await owner.put(`/api/v1/hotelier/hotels/${hotelId}/ari`).set(H)
      .send({ updates: [{ roomTypeId, startDate: day(12), endDate: day(12), availability: 2 }] }).expect(200);
    expect((await pool.query('SELECT count(*)::int AS n FROM channex_dirty')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM channex_room_map')).rows[0].n).toBe(0);
  });
});

void s;
