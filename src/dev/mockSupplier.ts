/**
 * Dev/test stand-in for a B2B wholesaler (TBO / Tripjack style). NOT for production.
 *
 *   POST /v1/hotels/availability-check   live price + availability (+ block when block=true)
 *   POST /v1/bookings                    turn a booking key into a booking
 *   POST /__control                      change behaviour: { mode, nightlyPrice, availableRooms }
 *
 * Modes let you rehearse every failure the Live Ping must survive:
 *   normal | soldout | slow (sleeps 30 s) | error500 | garbage (invalid JSON) | wrongRoom
 */
import express from 'express';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

type Mode = 'normal' | 'soldout' | 'slow' | 'error500' | 'garbage' | 'wrongRoom';

export interface MockSupplierState {
  mode: Mode;
  nightlyPrice: string;
  availableRooms: number;
  keyTtlSeconds: number;
  bookings: Map<string, string>;
  calls: number;
}

export function createMockSupplier(initial: Partial<MockSupplierState> = {}) {
  const state: MockSupplierState = {
    mode: 'normal',
    nightlyPrice: '12500.00',
    availableRooms: 3,
    keyTtlSeconds: 900,
    bookings: new Map(),
    calls: 0,
    ...initial,
  };
  const app = express();
  app.use(express.json());

  app.post('/__control', (req, res) => {
    Object.assign(state, req.body ?? {});
    res.json({ ok: true, mode: state.mode });
  });

  app.post('/v1/hotels/availability-check', async (req, res) => {
    state.calls++;
    const { hotelCode, roomCode, checkIn, checkOut, rooms = 1 } = req.body ?? {};
    if (state.mode === 'slow') await new Promise((r) => setTimeout(r, 30_000));
    if (state.mode === 'error500') return void res.status(500).json({ error: 'internal' });
    if (state.mode === 'garbage') return void res.type('application/json').send('{"status": "AVAIL');

    const nights = Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000);
    const nightly = Number(state.nightlyPrice);
    const soldOut = state.mode === 'soldout' || state.availableRooms < rooms;
    res.json({
      status: soldOut ? 'SOLD_OUT' : 'AVAILABLE',
      hotelCode,
      roomCode: state.mode === 'wrongRoom' ? 'SOMETHING_ELSE' : roomCode,
      availableRooms: soldOut ? 0 : state.availableRooms,
      currency: 'INR',
      totalPrice: soldOut ? null : (nightly * nights * rooms).toFixed(2),
      nightlyPrices: Array.from({ length: nights }, (_, i) => ({
        date: new Date(Date.parse(checkIn) + i * 86_400_000).toISOString().slice(0, 10),
        amount: state.nightlyPrice,
      })),
      bookingKey: soldOut ? null : `bk_${crypto.randomUUID()}`,
      bookingKeyExpiresInSeconds: soldOut ? null : state.keyTtlSeconds,
    });
  });

  app.post('/v1/bookings', (req, res) => {
    const { bookingKey, clientReference } = req.body ?? {};
    if (!bookingKey) return void res.status(400).json({ status: 'FAILED', message: 'missing bookingKey' });
    // Idempotent on clientReference, like a real supplier should be.
    let ref = state.bookings.get(clientReference);
    if (!ref) state.bookings.set(clientReference, (ref = `SUP-${Math.floor(Math.random() * 1e8)}`));
    res.json({ status: 'CONFIRMED', supplierReference: ref });
  });

  return {
    app,
    state,
    listen(port: number): Promise<Server> {
      return new Promise((resolve) => {
        const s = app.listen(port, () => resolve(s));
      });
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.MOCK_SUPPLIER_PORT ?? 4100);
  createMockSupplier()
    .listen(port)
    .then(() => console.log(`mock supplier on http://localhost:${port}`));
}
