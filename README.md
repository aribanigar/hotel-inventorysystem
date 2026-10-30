# Hotel Inventory System

Live hotel inventory hub for Kashmir hotels (and anywhere else). It routes every room
to its real source of truth, and re-verifies it with a **Live Ping** the moment a guest
clicks "Proceed to Pay", so nobody pays for a room that no longer exists or a price that
has changed.

Research and design notes:
- [docs/RESEARCH.md](docs/RESEARCH.md): SiteMinder, STAAH, AxisRooms, RateGain and Profitroom, and our architecture.
- [docs/QLOAPPS_STUDY.md](docs/QLOAPPS_STUDY.md): the open-source QloApps PMS, read from source, and what we took from it.
- [docs/QLOAPPS_CHANNEL_MANAGER.md](docs/QLOAPPS_CHANNEL_MANAGER.md): how the QloApps Channel Manager connects to Booking.com, Expedia, MakeMyTrip/Goibibo, Agoda and others, and how we could plug into it.

**Stack:** Node.js 20+ / TypeScript, Express 5, PostgreSQL 14+ (row locking via
`SELECT ... FOR UPDATE`), zod validation, pino logs. It runs as a standalone service next
to your existing OTA backend: the frontend (or the existing backend) calls its REST API,
and `hotels.external_ref` links each hotel to its listing in your current database.

## The three inventory sources

| Source | Hotels | How live data arrives | Checkout check |
|---|---|---|---|
| `EXTERNAL_B2B` | Chains via TBO / Tripjack | We **pull** from the supplier API | Supplier pre-book (block) call: [src/inventory/external.ts](src/inventory/external.ts) |
| `CHANNEL_MANAGER` | Mid-tier hotels on STAAH / AxisRooms | The CM **pushes** to our webhook | Row-locked DB check: [src/inventory/internal.ts](src/inventory/internal.ts) |
| `EXTRANET` | Houseboats, boutique stays | Owner edits in our extranet | Same row-locked DB check |

## Quick start

```bash
cp .env.example .env            # set DATABASE_URL
npm install
npm run migrate
npx tsx src/dev/seed.ts         # sample hotels for all 3 sources; prints ids + a CM API key
npm run dev:mock-supplier       # fake TBO-style supplier on :4100 (separate terminal)
npm run dev                     # API on :4000, jobs run in-process
```

Give a hotelier a login, then open http://localhost:4000/extranet:

```bash
HOTEL_USER_PASSWORD='choose-a-strong-one-1' npx tsx src/dev/createHotelUser.ts owner@hotel.com "Owner Name" <hotelId> owner
```

Tests run against a real Postgres (they drop and recreate the `public` schema, so point
them at a throwaway database):

```bash
TEST_DATABASE_URL=postgres://postgres@localhost:5432/hotel_inventory_test npm test
```

The 39 tests cover, for checkout and channels: webhook auth (key + HMAC), upsert insert/update, stale and duplicate
pushes, atomic rejection of unmapped codes, holds and decrements, price changes,
restrictions, **10 buyers racing for the last room (exactly one wins)**, double-click
idempotency, expiry, customer release, payment confirmation and CM notification, wrong
amount, late payment after expiry, supplier timeout, malformed supplier JSON, wrong room
echoed back, and the circuit breaker. For the extranet: sign-in, lockout, CSRF header,
per-hotel access, role limits, offline sales and their outbox events, sold-out refusals,
cancel, no-show and early check-out giving nights back exactly once, channel-manager
hotels redirected to their CM, and **a walk-in racing 5 online buyers for the last room
(exactly one wins)**.

## Hotelier extranet (`/extranet`)

A mobile-first web app for hotel staff, served by this same server (no build step).

- **Calendar:** each room type and date shows rooms left, price, sold offline and
  online, rooms in someone's checkout right now, and closed days. Tap a day to change
  rooms, price, minimum stay, closing, or no check-in / check-out, for one day or a range.
- **Offline booking:** for walk-in, phone, WhatsApp, travel agent or other OTA sales.
  The rooms are taken under the same row locks as online checkout, so a walk-in and an
  online buyer can never both get the last room. Every subscribed channel is notified
  in the same transaction.
- **Bookings:** offline and paid online bookings in one list, with check in, check out,
  no-show and cancel. Cancel, no-show and early check-out put the unused nights back on
  sale, once.
- **Activity:** an audit trail of who changed what and when.
- **Roles per hotel:** `owner`, `manager` (rates and inventory), `frontdesk` (bookings
  only). Hotels whose rooms come from STAAH, AxisRooms or a supplier are view-only, with
  a note to record sales in their channel manager.
- **Security:** scrypt passwords, an account lock after 5 failed sign-ins, HttpOnly
  SameSite=Strict session cookies stored hashed, a CSRF header on every change, a strict
  CSP, and no server data rendered as HTML.

API: `/api/v1/hotelier/...` (see [src/http/routes/hotelier.ts](src/http/routes/hotelier.ts)).

## API

### `POST /api/v1/checkout/live-ping` ("Proceed to Pay")

```json
{
  "hotelId": "uuid", "roomTypeId": "uuid", "ratePlanId": "uuid (optional)",
  "checkIn": "2026-12-20", "checkOut": "2026-12-22",
  "rooms": 1, "adults": 2, "children": 0,
  "displayedTotalMinor": 1700000, "currency": "INR",
  "customer": { "name": "Guest Name", "email": "guest@example.com", "phone": "+919999999999" }
}
```

Send an `Idempotency-Key` header (one per checkout attempt) so a double click returns
the same hold instead of taking two rooms.

**201**: the room is held for 10 minutes:

```json
{
  "status": "HELD",
  "pendingBookingToken": "pbt_...",
  "expiresAt": "2026-12-01T10:10:00.000Z",
  "holdSeconds": 599,
  "amount": { "minor": 1700000, "currency": "INR" },
  "payment": { "provider": "razorpay", "orderId": "order_...", "checkout": { "key": "rzp_...", "order_id": "order_...", "amount": 1700000, "currency": "INR" } },
  "source": "EXTRANET",
  "verifiedAt": "..."
}
```

Pass `payment.checkout` straight to Razorpay Checkout.

**Errors**: `{ "error": { "code", "message", "retryable", "details" } }`. The frontend switches on `code`:

| code | HTTP | Show the user |
|---|---|---|
| `PRICE_CHANGED` | 409 | "Price updated to `details.liveTotalMinor`", with a button to continue at the new price |
| `SOLD_OUT` | 409 | "Just sold out", with alternatives |
| `RESTRICTED` | 409 | Uses `details.reason`: `MIN_LOS`, `MAX_LOS`, `CLOSED_TO_ARRIVAL`, `CLOSED_TO_DEPARTURE` or `STOP_SELL` |
| `INVENTORY_BUSY` | 409 | Retry automatically once (`retryable: true`) |
| `SUPPLIER_TIMEOUT` | 504 | "Hotel system slow", with a Try again button |
| `SUPPLIER_UNAVAILABLE` | 503 | Same as above |
| `VALIDATION_ERROR` | 400 | Fix the form |

### Other endpoints

| Method + path | Purpose |
|---|---|
| `GET /api/v1/checkout/holds/:token` | Countdown and status (`ACTIVE`, `CONFIRMED`, `EXPIRED`, `RELEASED`, `NEEDS_REFUND`) |
| `POST /api/v1/checkout/holds/:token/release` | Guest left checkout: free the room now |
| `POST /api/v1/payments/razorpay/verify` | Razorpay Checkout success callback (signature checked) |
| `POST /api/v1/payments/razorpay/webhook` | Razorpay `payment.captured` / `order.paid` (signature checked). **Configure this too**, because it is the only path that survives the guest's phone losing signal |
| `GET /api/v1/hotels/:hotelId/availability?checkIn&checkOut&rooms&roomTypeId` | Live availability for listing pages (no locks) |
| `POST /api/v1/webhooks/channel-manager` | Inbound ARI from STAAH / AxisRooms (see below) |
| `PUT /api/v1/extranet/hotels/:hotelId/ari` | Houseboat / boutique owner updates (Bearer `EXTRANET_ADMIN_TOKEN`) |
| `GET /healthz` | Liveness + DB check |

## Onboarding a channel manager (STAAH, AxisRooms)

1. Insert a `channel_partners` row with a fresh key: store `sha256(secret)` in
   `api_key_hash`, and give the partner `X-Api-Key: <api_key_id>.<secret>`.
   Turn on `require_signature` and share `signing_secret` if they support HMAC.
2. For each hotel, set `inventory_source = 'CHANNEL_MANAGER'`, `channel_partner_id` and
   `cm_hotel_code`. Map `room_types.cm_room_code` and `rate_plans.cm_rate_code`.
3. Give them the payload contract documented at the top of
   [src/http/routes/webhooks.ts](src/http/routes/webhooks.ts). It follows
   OTA_HotelAvailNotif / RateAmountNotif semantics (date ranges, delta fields, shared
   room availability, `requestId` as EchoToken), so mapping their existing ARI feed is
   straightforward.
4. Add a `channel_subscriptions` row pointing at their reservation endpoint. Our sales
   reach them through the outbox (`RESERVATION_CREATED`, signed the same way).

## How the Live Ping stays correct

- **Locks:** for Sources 2 and 3, every night of the stay is locked `FOR UPDATE` in date
  order (a consistent order prevents deadlocks). The capacity check, decrement and hold
  insert happen in one transaction. The `UPDATE` also re-checks `allotment - held >= rooms`,
  so even a future code path that forgets the lock cannot oversell. The test suite shows
  that removing both protections sells the last room 10 times.
- **No locks across the network:** supplier calls (Source 1) and Razorpay order creation
  happen outside any DB transaction. If order creation fails, the hold is released at once.
- **Bounded waits:** `lock_timeout` 3 s and `statement_timeout` 8 s on checkout, a supplier
  timeout of 8 s (configurable), and a circuit breaker so an outage fails in ~0 ms
  instead of making every guest wait.
- **The 10-minute timer lives in the database** (`expires_at`), with a sweeper every 15 s.
  It survives restarts and deploys, and works across multiple instances.
- **Late payment:** if money arrives after expiry, the system tries to re-take the room
  under lock. If someone else bought it, the hold is marked `NEEDS_REFUND` and an
  `ALERT` line is logged. It never overbooks.
- **Money:** integer paise everywhere. Supplier decimals are parsed without floats.
- **Outbox:** every inventory change and reservation that other channels must hear about
  is written in the same transaction as the change itself. It is delivered with retries
  at 5 s, 15 s, 30 s and 60 s, then dead-lettered with an `ALERT`.

## Production checklist

- [ ] Set `PAYMENT_PROVIDER=razorpay` plus all three `RAZORPAY_*` vars (boot fails without them in production).
- [ ] Set `RUN_JOBS_IN_PROCESS=false` on API instances and run `npm run start:worker` as its own process (one is enough; several are safe).
- [ ] Replace the mock supplier contract in `external.ts` with the real TBO / Tripjack field mapping once their partner API docs are signed. Only that file changes.
- [ ] Encrypt `channel_partners.signing_secret` and `channel_subscriptions.signing_secret` at rest (KMS / pgcrypto).
- [ ] Put a shared rate limiter (CDN/WAF or Redis) in front if you run more than one API instance. The built-in limiter is per process.
- [ ] Alert on log lines containing `ALERT:` (refunds needed, dead-lettered deliveries) and on `inventory_holds.status = 'NEEDS_REFUND'`.
- [ ] Keep `EXTRANET_ADMIN_TOKEN` for ops scripts only; hotel staff sign in with their own accounts.
- [ ] Serve over HTTPS so the session cookie gets the `Secure` flag (automatic with `NODE_ENV=production`).

## Not built yet

- OTA connections for extranet hotels. The fastest route is an adapter for the hosted
  QloApps Channel Manager (see docs/QLOAPPS_CHANNEL_MANAGER.md). Direct OTA connectors
  each need partner certification.
- Automated Razorpay refunds for `NEEDS_REFUND` (currently flagged for ops).
- Admin UI for creating hotels, room types and channel mappings (done via SQL or seed today).
- Physical room numbers, room assignment and housekeeping status.
- Booking modifications and cancellations after confirmation.
