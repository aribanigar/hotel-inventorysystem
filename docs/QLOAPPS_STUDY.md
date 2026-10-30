# QloApps: deep study and what we take from it

Studied: `QloApps-develop.zip` (QloApps 1.8.x, PrestaShop-based), 2026-10-30.
Read directly from source; nothing was executed. File references are to that tree.

## 1. What it is

An open-source hotel website + booking engine + light PMS by Webkul.

- **Stack:** PHP 8.2+, MySQL/MariaDB, Smarty templates, jQuery. Built on PrestaShop 1.6:
  a room type is a PrestaShop *product*, a booking is a PrestaShop *order*, and the cart
  is the PrestaShop cart with hotel tables bolted on.
- **Shape:** 62 modules. The hotel brain is `modules/hotelreservationsystem` (about 21k
  lines). `HotelBookingDetail.php` alone is 4,883 lines.
- **Licence:** core OSL-3.0, modules AFL-3.0. OSL 3.0 has a network-use clause: if you
  run modified OSL code as a service, you must publish the source. **We take ideas only,
  no code**, so this does not touch our codebase.

## 2. Inventory model: physical rooms, not counts

This is the biggest difference from us.

| | QloApps | Our system |
|---|---|---|
| Unit of stock | Each physical room (`htl_room_information.room_num`, e.g. "101") | A count per room type per night (`daily_inventory.allotment`) |
| A booking occupies | One specific room id for a date range (`htl_booking_detail`) | N rooms of a type for each night |
| Availability | Computed on every search: all rooms of the type, **minus** rooms with an overlapping booking, minus disabled dates, minus LOS failures (`getSearchAvailableRooms`) | Read directly: `allotment - held` per night |
| Out of order | `htl_room_disable_dates` per room with a reason | Lower the allotment or stop-sell |
| Prices | Base product price plus "feature pricing" rules (date ranges, weekdays, % or fixed impact), computed per request | Stored price per rate plan per night (`daily_rates`) |
| Restrictions | Min/max LOS per room type, optionally per date range. No CTA/CTD | Min/max LOS, CTA, CTD, stop-sell per rate plan per night |

**Why it matters:**
- **Physical rooms are great for operations:** room assignment, check-in/out per room,
  housekeeping, swapping guests between rooms, and "room 104 is under repair Tue-Thu".
- **Counts are what distribution needs:** every OTA and channel manager speaks
  "N rooms left" (`BookingLimit`). QloApps has to recompute counts from room rows before
  every push (`QcmcAri::buildAriUpdatePayload`).
- **Our count model is right for selling.** A thin room-assignment layer can sit on top
  later for hotels that want per-room operations.

## 3. Booking flow and how it handles races

```
search (getBookingData)
  -> add to cart (htl_cart_booking_data: picks a specific free room)
  -> checkout (validateCartBookings: cleans cart, no stock lock)
  -> payment
  -> PaymentModule::validateOrder: RE-CHECKS availability
        room still free?          -> book it
        taken, other room free?   -> silently move guest to that room
        nothing free              -> book anyway, mark is_back_order = 1 ("overbooked"),
                                     order state OVERBOOKING_PAID
  -> later: refund/cancel frees a room -> resolveOverBookings() may clear the flag
```

What the code shows:

- **No database locking or transactions anywhere** in the booking path. A search for
  `FOR UPDATE`, `LOCK TABLES`, `GET_LOCK` and `START TRANSACTION` finds nothing in the
  hotel modules or the order core.
- **The cart does not hold stock.** `getSearchAvailableRooms` removes only the *current
  shopper's* cart rooms. Two shoppers can have the same last room in their carts at once.
- **Overbooking is the designed outcome of a race.** The second payer gets an
  "overbooked" order **after their money is taken**. It's resolved by hand, or
  automatically if a cancellation frees a room (`PS_OVERBOOKING_AUTO_RESOLVE`).
- **The re-check runs after payment, not before.** There is no point where the guest is
  told "price changed / sold out" before paying.

**Our system is stronger here:** the Live Ping locks every night `FOR UPDATE` before
payment, holds stock for 10 minutes, returns `SOLD_OUT` / `PRICE_CHANGED` before money
moves, and only flags `NEEDS_REFUND` in the rare late-payment case.

## 4. Channel sync (how a manual sale reaches the OTAs)

Module `qlocmconnector` (Webkul's paid "PMS & Channel Manager Connector", v7.0.0):

1. **Model hooks mark dates as dirty.** About 25 hooks fire on every relevant change:
   booking added/updated/deleted, room disabled, room added or removed, price rule
   changed, LOS changed, room-type settings changed. Each hook calls
   `QcmcAriUpdates::saveAriUpdateRow(hotel, roomType, from, to)`, which writes one row
   per date into `ari_updates` (status = pending).
   - **Coalescing:** an existing pending row for the same hotel/room type/date is
     updated instead of duplicated, so 20 edits to one date = 1 push.
   - Back-office "Book Now" (walk-in) bookings are ordinary orders, so they trigger the
     same hooks. **That's how a manual sale updates the OTAs.**
2. **A cron job pushes.** `qlochannelmanagerapicron.php` (token-protected URL) loads
   pending rows, **recomputes the current availability and price at push time**, groups
   them per hotel, and POSTs JSON to `https://channels.qloapps.com/api/v1/push_ari`
   with an OAuth2 client-credentials bearer token. Success deletes the rows; failure
   resets them to pending.
3. **That endpoint is Webkul's hosted channel manager.** It talks to the OTAs. **QloApps
   itself has no direct OTA connections either.**
4. **Inbound bookings:** the CM calls the `cm_api` webservice (PrestaShop API key) to
   create, modify and cancel orders (`WebserviceSpecificManagementCmApi`, 5,200 lines).
   Requests from two hard-coded Webkul IPs skip LOS checks.

Weak spots seen in the code:
- The dirty-row write is not in the same transaction as the booking (MySQL autocommit),
  so a crash between them can lose an update until something else touches that date.
- Pushes are cron-paced (typically every minute or more), not real time.
- Two cron runs could overlap. The rows are marked "processing" with a plain UPDATE,
  not a claim with `SKIP LOCKED` or a lease.
- No retry backoff and no dead-letter queue. A failing row simply retries on every run.

## 5. Back office (the hotelier side)

Useful product ideas, all in `hotelreservationsystem`:

- **Book Now calendar** (`AdminHotelRoomsBookingController`): staff search dates, see
  available / partially available / booked / unavailable rooms with stats, and add rooms
  to an admin cart for walk-in or phone bookings.
- **Booking statuses** per room: Assigned, Checked in, Checked out, No show, Cancelled,
  with **full status history** (`htl_booking_status_history`: from, to, employee, remark).
- **Room operations:** reallocate (move to another room or room type, with price
  difference) and swap two bookings' rooms.
- **Booking sources:** each order records where it came from (walk-in, OTA name,
  business source); the CM connector auto-creates sources from channel names.
- **Per-hotel staff access** (`htl_access`): an employee profile is granted specific
  hotels only.
- **Other features:** refund rules by days before arrival, advance-payment percentages,
  extras/services per room type, a guest registration card with ID and travel fields,
  min booking offset (how many days ahead) and max checkout offset.

## 6. What we adopt, what we avoid

**Adopt (in the extranet we are building now):**
1. Offline bookings as **real reservations** with a **source** (walk-in, phone,
   WhatsApp, travel agent, other), not a raw number edit.
2. **Status lifecycle with history:** confirmed, checked in, checked out, cancelled,
   no-show. Cancel and no-show give unused future nights back.
3. **Per-hotel staff access** with roles.
4. **An audit trail** of every inventory and booking change (who, what, when).
5. **A calendar view** of availability, sold, held and price per room type per date.
6. **Coalescing ARI pushes** per room type and date, as a later outbox improvement.

**Avoid:**
- Overbooking as the normal result of a race, and checking stock only after payment.
- Stock that isn't held during checkout.
- Channel updates written outside the booking transaction.
- Cron-paced pushes with no backoff or dead-letter queue.
- IP allow-lists as the trust boundary.

**Later, optional:** a physical-room layer (room numbers, assignment, housekeeping
status, out-of-order dates per room) for hotels that run operations in our system.
