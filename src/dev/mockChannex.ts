/**
 * Local stand-in for the Channex API so the extranet's Channex panel can be tried
 * without an account. NOT for production. Logs every ARI call it receives.
 *
 *   npm run dev:mock-channex          (port 4194, API key "dev-channex-key")
 *   CHANNEX_BASE_URL=http://localhost:4194 CHANNEX_API_KEY=dev-channex-key npm run dev
 *
 *   POST /__booking  { roomIndex?, checkIn, checkOut, status?, bookingId? }  queue an OTA booking
 *   GET  /__state                                                       what it has received
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY = process.env.MOCK_CHANNEX_KEY ?? 'dev-channex-key';
const state = {
  properties: new Map<string, { title: string; currency: string }>(),
  roomTypes: [] as Array<{ id: string; property_id: string; title: string }>,
  ratePlans: [] as Array<{ id: string; property_id: string; room_type_id: string; title: string }>,
  ari: [] as Array<{ at: string; path: string; values: number }>,
  feed: [] as Array<{ id: string; attributes: Record<string, unknown> }>,
  acked: new Set<string>(),
};

export function startMockChannex(port = 4194) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const p = url.pathname;
      const body = raw ? JSON.parse(raw) : {};
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (p === '/__state') {
        return send(200, { ...state, properties: [...state.properties], acked: [...state.acked] });
      }
      if (p === '/__booking' && req.method === 'POST') {
        const room = state.roomTypes[Number(body.roomIndex ?? 0)];
        if (!room) return send(400, { error: 'create room types first' });
        const rate = state.ratePlans.find((r) => r.room_type_id === room.id);
        const id = randomUUID();
        state.feed.push({
          id,
          attributes: {
            booking_id: body.bookingId ?? randomUUID(), property_id: room.property_id, status: body.status ?? 'new',
            ota_name: body.ota ?? 'Booking.com', ota_reservation_code: String(Date.now()).slice(-9), amount: body.amount ?? '9000.00', currency: 'INR',
            customer: { name: 'Mock', surname: 'Guest', mail: 'guest@example.com' },
            rooms: [{ room_type_id: room.id, rate_plan_id: rate?.id, checkin_date: body.checkIn, checkout_date: body.checkOut, occupancy: { adults: 2 } }],
          },
        });
        return send(201, { revisionId: id });
      }
      if (req.headers['user-api-key'] !== KEY) return send(401, { errors: { code: 'unauthorized', title: 'Unauthorized' } });

      if (req.method === 'POST' && p === '/api/v1/properties') {
        const id = randomUUID();
        state.properties.set(id, { title: body.property?.title, currency: body.property?.currency });
        return send(201, { data: { type: 'property', id, attributes: body.property } });
      }
      const prop = p.match(/^\/api\/v1\/properties\/([0-9a-f-]+)$/);
      if (req.method === 'GET' && prop) {
        const found = state.properties.get(prop[1]!);
        return found ? send(200, { data: { id: prop[1], attributes: found } }) : send(404, { errors: { code: 'not_found', title: 'Not found' } });
      }
      const pid = url.searchParams.get('filter[property_id]');
      if (p === '/api/v1/room_types') {
        if (req.method === 'POST') {
          const id = randomUUID();
          state.roomTypes.push({ id, property_id: body.room_type.property_id, title: body.room_type.title });
          return send(201, { data: { id, attributes: body.room_type } });
        }
        return send(200, { data: state.roomTypes.filter((r) => r.property_id === pid).map((r) => ({ id: r.id, attributes: { title: r.title } })) });
      }
      if (p === '/api/v1/rate_plans') {
        if (req.method === 'POST') {
          const id = randomUUID();
          state.ratePlans.push({ id, property_id: body.rate_plan.property_id, room_type_id: body.rate_plan.room_type_id, title: body.rate_plan.title });
          return send(201, { data: { id, attributes: body.rate_plan } });
        }
        return send(200, {
          data: state.ratePlans.filter((r) => r.property_id === pid).map((r) => ({ id: r.id, attributes: { title: r.title, room_type_id: r.room_type_id } })),
        });
      }
      if (req.method === 'POST' && (p === '/api/v1/availability' || p === '/api/v1/restrictions')) {
        state.ari.push({ at: new Date().toISOString(), path: p, values: body.values?.length ?? 0 });
        console.log(`[mock-channex] ${p} with ${body.values?.length ?? 0} range(s)`);
        return send(200, { data: [{ id: randomUUID(), type: 'task' }], meta: { message: 'Success', warnings: [] } });
      }
      if (p === '/api/v1/booking_revisions/feed') return send(200, { data: state.feed.filter((f) => !state.acked.has(f.id)).slice(0, 100) });
      const ack = p.match(/^\/api\/v1\/booking_revisions\/([0-9a-f-]+)\/ack$/);
      if (req.method === 'POST' && ack) {
        state.acked.add(ack[1]!);
        return send(200, { meta: { message: 'Success' } });
      }
      if (req.method === 'POST' && p === '/api/v1/auth/one_time_token') return send(200, { data: { token: randomUUID() } });
      if (p === '/auth/exchange') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<!doctype html><title>Mock Channex</title><p>Mock Channex channel screen. In real Channex you connect Booking.com, Expedia, Agoda, MakeMyTrip... here.</p>');
      }
      send(404, { errors: { code: 'not_found', title: 'Not found' } });
    });
  });
  server.listen(port, () => console.log(`[mock-channex] listening on http://localhost:${port} (api key "${KEY}")`));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) startMockChannex(Number(process.env.PORT ?? 4194));
