# QloApps Channel Manager: how it connects hotels to the OTAs

Sources: the Webkul store page for the "QloApps PMS & Channel Manager Connector", the
connector's source code (`modules/qlocmconnector`, v7.0.0, in the QloApps zip), and a
screenshot of the hosted QloApps Channel Manager (trial account). Studied 2026-10-30.

> The API contract in section 4 is **read from the connector's code**, not from a
> published spec. Webkul can change it. Confirm with Webkul that a non-QloApps PMS may
> connect before building on it.

## 1. The three pieces

```
 Hotel's PMS (QloApps)          QloApps Channel Manager             OTAs / portals
 ---------------------          (hosted SaaS by Webkul)             --------------
 qlocmconnector module  ──push ARI──▶ channels.qloapps.com  ──ARI──▶ Booking.com, Expedia,
   (free download)      ◀─bookings── (paid plan; trial in    ◀─res.── MakeMyTrip/Goibibo, Agoda,
                                      the screenshot)                Airbnb, Yatra, Trip.com ...
```

- **The connector (free)** is only the PMS-side plug. It never talks to an OTA.
- **The hosted channel manager (paid subscription, trial available)** holds the OTA
  certifications and mappings. Hotels pick channels under *Channels > Add channel*.
- **Portals offered** (from the screenshot): Booking.com, Expedia, Goibibo and
  MakeMyTrip (one connection), Agoda, Bakuun, Yatra, Airbnb, Hostelworld, HyperGuest,
  Trip.com/Ctrip, Despegar. Bakuun and HyperGuest are B2B distribution networks
  that resell to many more agents.
- **Menus** in the CM: Hotels, Channels, Room types, Price & inventory, PMS, Bookings,
  Revenue Management, Configurations, Logs.

## 2. Setup (store page, matches the code)

1. Install the connector module in QloApps.
2. QloApps *Webservices*: enable the API key with `cm_api` permissions (GET/POST/PUT...).
3. In the hosted CM: *Account settings* > generate API **Client ID + Client Secret**.
4. Paste them into the connector. It fetches an OAuth2 token from the CM.
5. Add a **cron job every minute** (`qlochannelmanagerapicron.php?token=...`).
6. In the CM: connect the PMS (it calls back into QloApps with the webservice key),
   import hotels and room types, then map each room type to each channel.

Store page facts: module $0.00, "single application" licence, support replies within one
business day, FAQ empty. It markets "real-time" sync, but it is **cron-paced (every minute)**.

## 3. Data flow

**PMS to CM (availability and price):**
1. Any change in QloApps (booking, cancellation, refund, room disabled, room added,
   price rule, LOS rule, settings) fires a hook. The hook marks `(hotel, room type, date)`
   rows as dirty in `qlo_ari_updates`, coalescing repeated edits to the same date.
2. The cron job reads the dirty rows and **recomputes availability at push time**
   (physical rooms minus booked minus disabled). It merges consecutive identical days into
   ranges and POSTs per hotel to `push_ari`. Success deletes the rows; failure resets
   them for the next minute.

**CM to PMS (bookings):** when a guest books on an OTA, the CM calls
`POST /api/cm_api/booking_notification` on the PMS with `booking_status` set to
`new`, `modified`, `cancelled` or `refunded`. It is de-duplicated by
`id_channel_manager_booking`, and the CM sends one request per room type with the same id.

**CM to PMS (reads):** the CM pulls `properties`, `room_types`, `ari` and `bookings` for
the initial import and for reconciliation.

## 4. The contract (from the code)

### Outbound: PMS to CM

| Call | Detail |
|---|---|
| Token | `POST https://channels.qloapps.com/oauth/token`, form body `grant_type=client_credentials&client_id=..&client_secret=..` returns `access_token`. On a 401 from `push_ari`, the cron fetches a new token and retries once. |
| Push ARI | `POST https://channels.qloapps.com/api/v1/push_ari`, headers `Authorization: Bearer <token>`, `X-PMS-REQUEST: true`, JSON body below, one hotel per request |

```json
{
  "id_property": "",
  "id_pms_property": "12",
  "ari_info": [
    {
      "id_room_type": "",
      "id_pms_room_type": "34",
      "date_from": "2026-12-20",
      "date_to": "2026-12-24",
      "weekdays": ["sun","mon","tue","wed","thu","fri","sat"],
      "closed": 0,
      "availability": 3,
      "rates": ["{\"id_rate_plan\":\"0\",\"id_pms_rate_plan\":\"0\",\"price_with_tax\":8925,\"price_without_tax\":8500,\"tax\":425,\"occupancy_based_price\":\"[]\",\"min_los_arrival\":0,\"max_los_arrival\":0,\"min_los_stay\":1,\"max_los_stay\":30,\"stop_sell\":0,\"close_to_arrival\":0,\"close_to_departure\":0,\"min_advanced_booking_offset\":0,\"max_advanced_booking_offset\":365}"]
    }
  ]
}
```

Notes: each `rates` entry is a **JSON string inside JSON**. The connector always sends
**one rate plan ("0")** and hard-codes `stop_sell`, `close_to_arrival` and
`close_to_departure` to 0, so multiple rate plans (EP/CP/MAP/AP), CTA, CTD and stop-sell
are **not** sent by this connector, even though the payload has fields for them.

### Inbound: CM to PMS (QloApps webservice `cm_api`, auth = webservice key)

| Method + path | Returns / does |
|---|---|
| `GET /api/cm_api/test_connection` | `{success, QLO_VERSION}` |
| `GET /api/cm_api/properties` | Hotels: id, name, email, phone, currency, country_code, state, city, address1, zip_code, latitude, longitude, timezone |
| `GET /api/cm_api/room_types?filter[id_property]=` | id, name, total_rooms, base_occupancy, max_adults, max_children, max_infants |
| `GET /api/cm_api/ari?filter[id_property]=...` | Current ARI (pull, used for full sync) |
| `GET /api/cm_api/bookings?filter[id_property]=...` | Booking list |
| `POST /api/cm_api/booking_notification` | Create, modify or cancel a booking |

`booking_notification` body, main fields: `id_property`, `id_channel_manager_booking`,
`id_booking` (PMS id, for modify/cancel), `booking_status`, `currency`, `source` /
`business_source` (OTA name), `booking_date`, `guest_detail` {firstname, lastname, email,
phone, address, city, zip, country_code, state_code}, `room_bookings[]` {id_room_type,
check_in_date, check_out_date, number_of_rooms, rooms[] {occupancy {adults, children,
children_ages}, price_details {unit_price_without_tax, total_price_with_tax, total_tax},
services[]}}, `price_details`, `payment_detail` {payment_type: online | remote | pay at
hotel, payment_status: paid | unpaid | partial}, `cart_rules`, `remark`.

## 5. Strengths and weaknesses

**Strong:**
- Wide OTA list including the Indian ones (MakeMyTrip/Goibibo, Yatra), with no
  certification work for the hotel.
- Booking de-duplication by CM id. Modify and cancel are handled. Room-type merging.

**Weak:**
- Cron-paced: up to about a minute of lag on every change, which is an overbooking window.
- No transaction around the dirty-row write; no backoff or dead-letter queue.
- One rate plan per room type; stop-sell, CTA and CTD are not sent.
- An OTA booking for a room already gone becomes an "overbooked" order (back order),
  resolved by hand.
- Trust is partly by IP allow-list (two Webkul IPs skip LOS rules).
- The contract is unpublished and tied to the QloApps webservice framework.

## 6. What this means for us

**Option A: plug our system into the QloApps Channel Manager as its PMS.**
Our backend already has the right parts. A "QloApps CM adapter" would be:
1. **Outbound:** a new outbox event type that turns our `ARI_CHANGED` events into
   `push_ari` payloads (our ids as `id_pms_*`, our real prices), with the OAuth token
   cached and refreshed on 401. Our outbox delivers it in seconds with retries,
   **faster than their one-minute cron**.
2. **Inbound:** implement the six `cm_api` endpoints above on our server. Then
   `booking_notification` runs through the **same row-locked path** as walk-ins and the
   Live Ping.
   - An OTA booking cannot be refused (the guest already booked on the OTA), so if
     the room is gone we still record it, mark it `OVERBOOKED` and raise an alert.
     QloApps does the same, but we would surface it instantly.
3. **Result:** houseboats and boutique stays managed in our extranet would reach
   Booking.com, Expedia, MakeMyTrip/Goibibo, Agoda, Airbnb, Yatra and the rest through a
   CM that is already certified.

**Before building it, confirm with Webkul:**
- Will they connect a non-QloApps PMS to their hosted CM? The PMS settings page in your
  trial account should show what URL and key it asks for.
- What is the subscription price per property after the trial (the trial ends 9 Nov 2026)?
- Can it receive multiple rate plans, stop-sell, CTA and CTD through `push_ari` (the
  fields exist) or `occupancy_based_price`?
- What are the rate limits, and is there a sandbox?

**Option B: STAAH / AxisRooms as the channel** (our existing Source 2 webhook). This is
better for hotels that already use them.

The two are not exclusive: Option A covers properties managed in our extranet, Option B
covers hotels that already run a channel manager.

## 7. The hosted CM, screen by screen (from the trial account), and our answer

| CM screen / feature | What it does | Ours before | Ours now |
|---|---|---|---|
| **Channels > Add channel** (Booking.com: Property id, Currency, Test connection) | Maps one hotel to one OTA account; test call before saving | Subscriptions table, no UI | **Channels tab**: every connected channel with live sync health (pending, failed, last success, last error) and **Retry failed** |
| **Room types** (name, total rooms, default occupancy, max adults/children/infants, colour) | Physical capacity + occupancy rules | `max_occupancy` only, no UI | **Setup tab**: create/edit room types with total rooms, base occupancy, max adults/children/infants. New room types open for sale automatically; changing total rooms shifts all future availability by the difference (sold rooms stay sold) |
| **Rate plans, "Derived" mode** | A plan whose price follows a parent (+/- % or amount) | One default plan, no UI | **Rate plans**: manual or derived (+/- % or +/- INR), optional "follow parent restrictions". Derived prices are recalculated in the same transaction as every parent change, so checkout always reads a stored price |
| **Price & inventory grid** with Rooms / Rate plan / Restrictions filters | One grid, switch what you see | One row per room type | Grid with a row per room type (rooms left) **and a row per rate plan** (price), plus a Restrictions view |
| **Bulk update** | Many rooms/plans/dates at once | Single range per room | **Bulk update**: several room types and rate plans, date range, **weekday picker** (e.g. only Fri+Sat), any mix of fields; blank = unchanged |
| **Full sync** | Re-push everything to all channels | Not available | **Sync all channels**: queues a full 365-day snapshot to every connected channel through the outbox |
| **Restrictions**: Price, Stop sell, CTA, CTD, Min/Max LOS arrival, Min/Max LOS stay, Min/Max booking offset, Additional guest rates | Full OTA restriction set | Price, stop sell, CTA, CTD, min/max LOS arrival | **All of them**: plus min/max stay-through (checked on every night), min/max days before arrival, and extra adult / extra child prices per night |
| Trial: "can not sync inventory and rates" | Paid plan needed to push | n/a | No such limit in our own system |

Two things the CM screens show that we copy only partly, on purpose:
- **Currency per channel:** we price in the hotel's currency (INR); converting per OTA is
  done by the channel or the CM.
- **Room type colour:** cosmetic, skipped.

### More screens: PMS link, bookings, revenue management, configuration

| CM screen | What it does | Ours |
|---|---|---|
| **PMS > General Settings**: Webservice key + URL + PMS timezone, Test Connection; "Properties / Rooms Mapping" tab | The CM calls the PMS to import hotels and room types | **Built**: `/api/cm_api/*` (test_connection, properties, room_types, ari, bookings, booking_notification). The owner gets the URL + key from Channels > Connect |
| **Bookings**: Booking id, Guest, Channel name, Room type, Duration, Status, Booking date, Synced, Export | OTA bookings and whether they reached the PMS | Bookings tab shows OTA name, status, **Overbooked** flag, and exports CSV; OTA bookings are stored the moment the CM sends them |
| **Revenue Management**: PriceLabs (prices, min stay, multi-unit, check-in/out restrictions) | Dynamic pricing pushes prices into the CM | Not built. Our bulk update API takes everything PriceLabs sets, so it could plug in later |
| **Configurations**: "Days to set inventory & rates data" (max 730), "Availability update mode outside range", **Reset availability**; "data checked once every 24 hours" | Rolling window and a repair button | **Built**: rolling selling window (hourly, not daily) and Reset availability (total rooms minus all bookings) |

## 8. What the QloApps Channel Manager uses to reach each OTA

Researched 2026-10-31 from QloApps' own per-channel setup guides (linked from
qloapps.com/qloapps-channel-manager), Channex's public docs and its integrations directory.

**Finding: QloApps Channel Manager does not hold its own OTA certifications for the big
OTAs. Its guides name Channex.io as the "connectivity partner" for Booking.com, Expedia and
Agoda.** Channex is a white-label channel manager API sold only to PMS vendors. The other
channels either show "QloApps" in the OTA's own extranet or need no extranet step, which
fits a white-label setup on Channex's certified links. Channex lists every one of them,
Bakuun included (it is in Channex's channel API examples).

```
 Hotel PMS ──push_ari──▶ channels.qloapps.com ──REST/JSON──▶ Channex ──certified XML/API──▶ OTA
 (QloApps)  ◀─cm_api─── (Webkul UI + billing) ◀─revisions── (holds the   ◀─reservations── extranet
                                                              OTA links)
```

### Per channel: what the hotel does at the OTA, and who the OTA sees

| Channel | Step in the OTA's extranet (from the QloApps guide) | Provider the OTA sees | Fields entered in QloApps CM |
|---|---|---|---|
| **Booking.com** | Account > Connectivity Provider > search **"Channex"** > accept the XML Service Agreement > wait for approval | **Channex** ("Channex is our connectivity partner for Booking.com Channel") | Property ID, currency, conversion factor |
| **Expedia** | Rooms and Rates > Connectivity Settings > choose **Channex** for both connectivity and booking | **Channex** | Property ID, min stay type (arrival or stay-through), currency |
| **Agoda** | Direct Agoda contract, then YCS > Settings > Property Settings > enable channel manager mode > pick **Channex** | **Channex** | Property ID, currency |
| **MakeMyTrip / Goibibo** (one connection, InGo-MMT) | Goibibo extranet > Property > Setting > pick **"QloApps"** as channel manager > copy the **access token** | **QloApps** | Property ID (Hotel code), bearer access token, currency, extra adult and child price per rate plan |
| **Trip.com / Ctrip** | Rates & Availability > Connectivity Settings > search **"QloApps"** > Connect | **QloApps** | Property ID, currency |
| **Despegar** | General Settings > My Connections > Create Integration > Channel Manager > pick **"QloApps"** > copy the activation code | **QloApps** | Activation code, property ID |
| **Airbnb** | None. OAuth: "Authorize with Airbnb Account", then accept Airbnb's terms | The CM's Airbnb app | Listing ID, min stay type |
| **Hostelworld** | Email Hostelworld support, receive an API password | n/a | Property ID, property password |
| **Yatra, Bakuun, HyperGuest** | None documented (account on the OTA only) | n/a | Property ID, currency |
| **PriceLabs** (pricing, not an OTA) | PriceLabs > Connect via PMS > pick "QloApps Channel Manager" | QloApps | PriceLabs email; hotel latitude, longitude, city, country |

### Why we think the CM itself is built on Channex

- The guides say so directly for Booking.com, Expedia and Agoda.
- The CM's rate plan form matches Channex's rate plan model field for field:
  - rate mode "auto, manual or derived" (Channex `rate_mode`: manual, derived, auto, cascade)
  - price model "occupancy-wise or room-wise" (Channex `sell_mode`: per_person, per_room)
  - children fee and infant fee (Channex `children_fee`, `infant_fee`)
  - per-channel "Min Stay Type: arrival or stay through" (Channex `min_stay_type`)
- Its restriction screen (stop sell, CTA, CTD, min/max stay on arrival and stay-through)
  is the same set as Channex's `POST /restrictions` fields.
- Channex's own MakeMyTrip guide asks for the same two fields (Hotel ID plus the access
  token MakeMyTrip gives the provider).
- Channex's channel list covers all of QloApps' portals, including MakeMyTrip, Yatra,
  Despegar, HyperGuest, Bakuun, Trip.com, Hostelworld, Airbnb and Google Hotels.

**Not confirmed:**
- whether "QloApps" in the MakeMyTrip, Trip.com and Despegar extranets is a Channex
  white-label listing or a direct Webkul certification.

### What this means for us

| Route | Hops | Cost (public list prices) | Notes |
|---|---|---|---|
| **Our system > QloApps CM > Channex > OTA** (built, `src/channels/qloappsCm.ts`) | 3 | QloApps CM plan per property (third-party listings say about $30 per month; check with Webkul) | Webkul must allow a non-QloApps PMS. Its contract is read from code, not published. |
| **Our system > Channex > OTA** (built, `src/channels/channex/`) | 2 | WhiteLabel: $130 per month platform fee + $7 per hotel per month ($4 at 2,000+ hotels); no setup fee | Public REST API and docs, staging sandbox, certification test for PMS partners. Same OTA list. We can show our own brand. |
| **Our system > OTA directly** | 1 | Free API, but each OTA needs its own certification | Booking.com, Expedia and Agoda now take new connectivity partners slowly. Only worth it later for one or two key OTAs (MakeMyTrip for India). |

Channex API pieces a direct connector would use:
- **ARI:** `POST /api/v1/availability` (rooms left per room type per date) and
  `POST /api/v1/restrictions` (rate, stop_sell, closed_to_arrival, closed_to_departure,
  min_stay_arrival, min_stay_through, max_stay).
  - Both take date ranges and a `days` weekday filter, so our outbox deltas map almost
    one to one.
  - Channex has no max-advance restriction; we keep enforcing that on our own website only.
- **Bookings:** the `GET /api/v1/booking_revisions/feed` poll, plus a webhook. Each
  revision is `new`, `modified` or `cancelled`. We store it, then
  `POST /api/v1/booking_revisions/:id/ack`. Channex advises keeping the feed poll every
  15 to 20 minutes as a backup to webhooks.
- **Derived plans:** Channex supports parent plans with percent or amount rules and
  `inherit_*` restriction flags, which match our derived rate plans.

Channex limits: 10 restriction calls and 10 availability calls per minute per property;
full sync = 2 calls for 500 days; certification rejects full syncs on a timer and per-date
calls; it requires a queue, 429/5xx backoff, webhook + acknowledgement and a mapping layer.
Channex also lowers availability itself when a booking arrives (cannot be turned off), so
we always push our own figure after applying the booking.

**Recommendation (now built):** connect to Channex directly as a white-label PMS partner. It removes
one hop and one subscription, uses a published API instead of one read from code, and
reaches the same OTAs (Booking.com, Expedia, Agoda, MakeMyTrip/Goibibo, Airbnb, Trip.com
and the rest). Keep the QloApps CM connector for hotels that already pay for it.

Sources: qloapps.com setup guides for Booking.com, Expedia, Agoda, Goibibo & MakeMyTrip,
Trip.com and Ctrip, Despegar, Airbnb, Hostelworld, HyperGuest, Bakuun, Yatra and PriceLabs;
docs.channex.io (rate plans, ARI, bookings, MakeMyTrip mapping guide);
channex.io/integrations; channex.io/pricing.
