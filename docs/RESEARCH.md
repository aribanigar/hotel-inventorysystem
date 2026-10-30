# How hotel inventory connectivity works (and how we do it better)

Research date: 2026-10-30. Sources are listed at the end. Vendor numbers are
vendor-stated marketing claims unless marked otherwise.

## 1. The five platforms at a glance

| Platform | What it really is | Scale (claimed) | Connectivity style |
|---|---|---|---|
| **SiteMinder** (AU) | Channel manager + booking engine + "Platform" app store. Market leader. | Largest ecosystem globally | Open, documented APIs on OTA 2010A XML over SOAP: **pmsXchange** (PMS side) and **SiteConnect** (channel side). |
| **STAAH** (NZ/IN) | Channel manager, booking engine, "ChannelConnect" API for channels | 5,000 to 12,000+ properties, 200 to 1,000+ channels (sources disagree) | Specs shared only after an integration request + agreement. Partners (Mews, Cloudbeds) describe the same pattern: ARI out, reservations in. |
| **AxisRooms** (IN) | Channel manager, booking engine, RMS, rate shopper, PMS, OTA extranet | 3,200+ hotels, 120+ OTAs, 20+ PMS, 30+ payment gateways, 4 GDS | Direct XML/API per OTA (first CM with a Goibibo XML API). Strong on Indian OTAs. No public API docs. |
| **RateGain** (IN, listed) | Enterprise distribution: **RezGain** channel manager + **Enterprise Connectivity** (formerly DHISCO switch) + rate intelligence | Switch connectivity to 500+ hotel chains | Push ARI to OTAs, OTAs push reservations back ("Direct Connect - Demand (Push)"). DHISCO modes: seamless, ARI push, shop-to-push, shop-to-cache. |
| **Profitroom** (PL) | Direct-booking suite: booking engine, CRM, upsell, websites, channel manager | 4,500+ hotels, 55 countries | Booking.com Premier Partner. Connects to PMS via a "connection token". Mews notes it does **not** support CTA, CTD or max-LOS. |

## 2. How they all actually work (the common mechanism)

Every one of them is built on the same three primitives, standardised by the
OpenTravel Alliance (OTA) message set:

1. **ARI push (Availability, Rates, Inventory).** The hotel (or its PMS)
   changes something. The channel manager computes the *delta* and pushes it to
   every connected channel.
   - `OTA_HotelAvailNotifRQ`: room-level availability (`BookingLimit` = rooms
     left to sell) plus restrictions (stop-sell, CTA, CTD, min/max stay).
     All rate plans of a room type **share one availability pool**.
   - `OTA_HotelRateAmountNotifRQ`: per-day or occupancy-based prices per rate plan.
   - Ranges, not single days: one message covers a start/end date span.
2. **Reservation push.** The channel (OTA) that sells a room pushes the booking
   back (`OTA_HotelResNotifRQ`: new, modify, cancel). The channel manager then
   decrements inventory and re-pushes the new ARI to all other channels.
3. **Mapping.** Each property, room type and rate plan has a code per channel.
   Mapping is done once at onboarding. Changing a HotelCode breaks the link.

### Hard numbers from SiteMinder's published requirements (the de facto bar)

- Transport: SOAP 1.1, TLS 1.2+, WS-Security username/password, optional IP allow-list.
- Every message carries a unique `EchoToken` (UUID) echoed in the response, used for de-duplication.
- Response time: ideal < 1 s, acceptable 1-2 s, hard timeout 20 s. **Acknowledge immediately and process asynchronously.**
- Delta-only updates are enforced. Full "flushes" are frowned on.
- Initial load up to **750 days**. Ongoing horizon at least 365 days.
- Failed deliveries: persistent queue, de-dup, exponential backoff **immediate, 5 s, 15 s, 30 s, 60 s**, then alert a human.
- Times are in the hotel's local time zone.
- Reservation IDs are unique forever and never reused. Modifications keep the same ID.

### How B2B wholesalers (TBO, Tripjack, ETG, Travelgate) do the checkout check

Wholesalers do not push ARI. You **pull**: search, then a **pre-book / block /
quote** call that re-checks the exact rate and returns a short-lived booking
key, then book.

- TBO-style `BlockRoom` returns `IsPriceChanged`, `IsHotelPolicyChanged` and the updated price.
- ETG `prebook` supports `price_increase_percent` (a price tolerance) and returns new hashes if the rate changed. Search hashes expire.
- Travelgate: search, then **Quote** (re-check), then **Book** using the `optionId` from Quote.
- Spotnana's price-check returns a booking-key timeout in seconds, which is the supplier's hold window.

Exact TBO/Tripjack field names come from their partner docs (shared after
signing). Our adapter isolates them in one file.

## 3. Where they fall short (our opening)

1. **Built for hotels, not for websites.** Their customers are hotels. A travel
   website that wants live inventory has to become a certified "channel" per
   vendor (SOAP/XML, months of certification). There is no simple, modern
   "give me live rooms" API for sellers.
2. **SOAP/XML, batch-era transport.** Heavy envelopes, 20 s timeouts, and
   "eventually consistent" pushes. Every OTA keeps its own cached copy, so
   overbookings still happen in the gap between a sale and the re-push.
3. **No checkout-time truth.** The OTA sells from its cached copy. Nobody
   re-verifies against the source at the moment of payment, except wholesalers
   with their pre-book step.
4. **Uneven restriction support** (e.g. Profitroom without CTA/CTD/max-LOS via Mews).
5. **Offline inventory is invisible.** Kashmir houseboats and boutique stays
   have no PMS or channel manager, so they are not on any of these networks.
6. **Opaque onboarding.** STAAH and AxisRooms publish no API docs, and
   RateGain/DerbySoft-class connectivity starts around USD 900-1,000 per month.

## 4. Our design: one inventory brain, three sources, one checkout truth

```
                  +-----------------------------------+
  Websites / apps | Public API (JSON/REST)            |
  (ours + others) |  GET  /availability   (fast read) |
                  |  POST /checkout/live-ping (lock)  |
                  +----------------+------------------+
                                   |
                          +--------v---------+
                          |  Live Ping engine |  <- the gatekeeper at "Proceed to Pay"
                          +---+-----+-----+---+
             Source 1         |     |     |        Source 2 + 3
   +--------------------------+     |     +---------------------------+
   | External B2B adapter     |     |     | Postgres: daily_inventory |
   | (TBO/Tripjack style)     |     |     |   + daily_rates           |
   | timeout, retry, breaker  |     |     | SELECT ... FOR UPDATE     |
   +--------------------------+     |     +-------------^-------------+
                                    |                   |
                          +---------v--------+   +------+-------------------+
                          | inventory_holds  |   | Inbound CM webhook       |
                          | 10-min TTL       |   | (STAAH, AxisRooms...)    |
                          | sweeper releases |   | + Extranet (houseboats)  |
                          +---------+--------+   +--------------------------+
                                    |
                          +---------v--------+
                          | ari_outbox       |  -> push changes to other OTAs / CMs
                          | (transactional)  |     immediate, 5s, 15s, 30s, 60s backoff
                          +------------------+
```

### Where it is better than the incumbents

| Problem | Incumbent behaviour | This system |
|---|---|---|
| Overbooking at checkout | OTA sells from cached ARI | **Live Ping** re-verifies at the source under a row lock before payment |
| Concurrent buyers for the last room | Race, then a manual cancel | `SELECT ... FOR UPDATE` in a consistent date order: exactly one wins |
| Abandoned payments holding stock | Varies | 10-minute hold, automatic release by a `SKIP LOCKED` sweeper |
| Duplicate/out-of-order pushes | EchoToken de-dup only | De-dup on `requestId` **and** per-row `source_updated_at`, so stale pushes never overwrite newer data |
| Lost pushes to other channels | Retry queue | **Transactional outbox**: the inventory change and the "tell other OTAs" event commit together or not at all |
| Partner onboarding | SOAP certification | JSON over HTTPS, HMAC-signed, OpenAPI-style payload modelled on OTA semantics so CMs can map easily |
| Offline houseboats | Not connected | First-class Extranet source on the same tables and the same lock |
| Prices | Floats in XML | Integer paise end to end (no rounding drift) |

### Known trade-off (same as every CM)

For channel-manager hotels the CM is the source of truth. When we confirm a
sale we decrement locally right away and send the reservation to the CM through
the outbox. If the CM pushes an availability number computed *before* it saw
our reservation, we briefly show one room more than reality. Mitigations: the
`source_updated_at` guard, short CM round trips, and the Live Ping for every
checkout. Payment is captured only after a successful hold. If the CM later
rejects the reservation, the booking is flagged for refund, never silently kept.

## Sources

- SiteMinder SiteConnect integration requirements: https://developer.siteminder.com/siteconnect-api/guides/integration-requirements.md
- SiteMinder SiteConnect API overview: https://developer.siteminder.com/siteconnect-api/guides/api-overview.md
- SiteMinder pmsXchange availability/restrictions: https://developer.siteminder.com/pmsxchange-api/reference/restrictions/pms-to-sm.md
- RateGain Direct Connect (Demand Push): https://developer.rategain.com/direct-connect-demand-push/introduction
- RateGain + DHISCO switch connectivity: https://www.prnewswire.co.uk/news-releases/didatravel-partners-with-rategain-for-switch-connectivity-and-channel-management-874718131
- HotelTechReport DerbySoft vs RezGain: https://hoteltechreport.com/compare/derbysoft-vs-rezgain-channel-manager
- STAAH ChannelConnect request form: https://docs.google.com/forms/d/e/1FAIpQLSeyj5_bYPIHEU6JBA8W0wcPCmjk83DOlNK5h2RWBdzBSUWwNQ/viewform
- STAAH on Vervotech: https://www.vervotech.com/hub/integrations/staah-api/
- STAAH for Mews: https://help.mews.com/s/article/staah-for-mews-operations
- STAAH for Cloudbeds: https://myfrontdesk.cloudbeds.com/hc//articles/37599717212571-Connect-STAAH-Channel-Manager-to-Cloudbeds-PMS
- AxisRooms home: https://www.axisrooms.com/
- AxisRooms blog on channel managers: https://blog.axisrooms.com/hotel-channel-managers/
- Profitroom home: https://profitroom.com/
- Profitroom Booking.com Premier Partner: https://www.profitroom.com/articles/profitroom-is-now-a-booking.com-premier-partner
- Profitroom for Mews: https://help.mews.com/s/article/profitroom-for-mews-operations
- ETG prebook: https://docs.emergingtravel.com/docs/affiliate-api/hotel-search/affiliate-v3-hotel-prebook
- BlockRoom (TBO-style) reference: https://adivaha.com/documentations/hotels-api/hotel-blockroom.html
- Travelgate booking flow: https://docs.travelgate.com/docs/apis/for-buyers/hotel-x-pull-buyers-api/booking-flow/overview
- Spotnana price check: https://developer.spotnana.com/openapi/hotelapi/hotel/hotelpricecheck.md
