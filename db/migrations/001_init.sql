-- =============================================================================
-- Live hotel inventory hub: core schema
-- Postgres 14+ (gen_random_uuid() is built in from PG 13).
-- =============================================================================

-- Where a hotel's live truth comes from.
--   EXTERNAL_B2B    : chains sold through a wholesaler API (TBO, Tripjack). We pull.
--   CHANNEL_MANAGER : mid-tier hotels whose CM (STAAH, AxisRooms) pushes ARI to us.
--   EXTRANET        : offline houseboats / boutique stays managed in our own extranet.
CREATE TYPE inventory_source AS ENUM ('EXTERNAL_B2B', 'CHANNEL_MANAGER', 'EXTRANET');

CREATE TYPE hold_status AS ENUM (
  'ACTIVE',        -- room is held, waiting for payment
  'CONFIRMED',     -- paid, inventory permanently taken
  'RELEASED',      -- user cancelled or payment order failed; inventory returned
  'EXPIRED',       -- 10-minute timer ran out; inventory returned
  'NEEDS_REFUND'   -- money arrived but the room could not be secured; ops must refund
);

-- -----------------------------------------------------------------------------
-- Channel managers allowed to push to us (STAAH, AxisRooms, ...)
-- -----------------------------------------------------------------------------
CREATE TABLE channel_partners (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL UNIQUE,              -- 'STAAH', 'AXISROOMS'
  name              text NOT NULL,
  api_key_id        text NOT NULL UNIQUE,              -- public half of the key
  api_key_hash      text NOT NULL,                     -- sha256 hex of the secret half
  signing_secret    text,                              -- HMAC secret (encrypt at rest in prod)
  require_signature boolean NOT NULL DEFAULT false,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Hotels, room types, rate plans
-- -----------------------------------------------------------------------------
CREATE TABLE hotels (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref        text UNIQUE,                     -- id of the listing in the OTA frontend DB
  name                text NOT NULL,
  inventory_source    inventory_source NOT NULL,
  timezone            text NOT NULL DEFAULT 'Asia/Kolkata',
  currency            char(3) NOT NULL DEFAULT 'INR',
  -- Source 1 mapping
  supplier_code       text,                            -- 'TBO', 'TRIPJACK'
  supplier_hotel_code text,
  -- Source 2 mapping
  channel_partner_id  uuid REFERENCES channel_partners(id),
  cm_hotel_code       text,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_partner_id, cm_hotel_code),
  -- Each source must carry its own mapping, so a misconfigured hotel can't go live.
  CONSTRAINT hotels_source_mapping CHECK (
    (inventory_source = 'EXTERNAL_B2B'    AND supplier_code IS NOT NULL AND supplier_hotel_code IS NOT NULL) OR
    (inventory_source = 'CHANNEL_MANAGER' AND channel_partner_id IS NOT NULL AND cm_hotel_code IS NOT NULL) OR
    (inventory_source = 'EXTRANET')
  )
);

CREATE TABLE room_types (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id           uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  code               text NOT NULL,
  name               text NOT NULL,
  max_occupancy      smallint NOT NULL DEFAULT 2 CHECK (max_occupancy > 0),
  cm_room_code       text,                             -- code used by the channel manager
  supplier_room_code text,                             -- code used by the B2B supplier
  is_active          boolean NOT NULL DEFAULT true,
  UNIQUE (hotel_id, code),
  UNIQUE (hotel_id, cm_room_code)
);

CREATE TABLE rate_plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_type_id uuid NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
  code         text NOT NULL,
  name         text NOT NULL,
  meal_plan    text NOT NULL DEFAULT 'EP' CHECK (meal_plan IN ('EP', 'CP', 'MAP', 'AP')),
  cm_rate_code text,
  is_default   boolean NOT NULL DEFAULT false,
  is_active    boolean NOT NULL DEFAULT true,
  UNIQUE (room_type_id, code),
  UNIQUE (room_type_id, cm_rate_code)
);
-- At most one default rate plan per room type.
CREATE UNIQUE INDEX rate_plans_one_default ON rate_plans (room_type_id) WHERE is_default;

-- -----------------------------------------------------------------------------
-- Daily inventory: one row per room type per night (shared pool for all rate plans,
-- exactly like OTA_HotelAvailNotif BookingLimit).
--   allotment : rooms the source says we may sell (CM push or extranet value)
--   held      : rooms locked by ACTIVE checkout holds (never known to the CM)
--   available : what we can sell right now
-- -----------------------------------------------------------------------------
CREATE TABLE daily_inventory (
  room_type_id      uuid NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
  stay_date         date NOT NULL,
  allotment         integer NOT NULL DEFAULT 0 CHECK (allotment >= 0),
  held              integer NOT NULL DEFAULT 0 CHECK (held >= 0),
  stop_sell         boolean NOT NULL DEFAULT false,
  -- GREATEST: a CM may push an allotment lower than our current holds; never go negative.
  available         integer GENERATED ALWAYS AS (GREATEST(allotment - held, 0)) STORED,
  -- Timestamp from the source system. Older pushes never overwrite newer data.
  source_updated_at timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_type_id, stay_date)
);

-- Daily price + restrictions per rate plan.
CREATE TABLE daily_rates (
  rate_plan_id      uuid NOT NULL REFERENCES rate_plans(id) ON DELETE CASCADE,
  stay_date         date NOT NULL,
  price_minor       bigint CHECK (price_minor IS NULL OR price_minor > 0),  -- paise; NULL = no sellable rate yet
  currency          char(3) NOT NULL DEFAULT 'INR',
  min_los           smallint NOT NULL DEFAULT 1 CHECK (min_los >= 1),
  max_los           smallint CHECK (max_los IS NULL OR max_los >= 1),
  closed_to_arrival   boolean NOT NULL DEFAULT false,
  closed_to_departure boolean NOT NULL DEFAULT false,
  stop_sell         boolean NOT NULL DEFAULT false,
  source_updated_at timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rate_plan_id, stay_date)
);

-- -----------------------------------------------------------------------------
-- Checkout holds (the 10-minute "Proceed to Pay" lock)
-- -----------------------------------------------------------------------------
CREATE TABLE inventory_holds (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pending_booking_token text NOT NULL UNIQUE,
  idempotency_key       text UNIQUE,
  hotel_id              uuid NOT NULL REFERENCES hotels(id),
  room_type_id          uuid NOT NULL REFERENCES room_types(id),
  rate_plan_id          uuid REFERENCES rate_plans(id),
  source                inventory_source NOT NULL,
  check_in              date NOT NULL,
  check_out             date NOT NULL,
  rooms                 smallint NOT NULL CHECK (rooms BETWEEN 1 AND 9),
  quoted_total_minor    bigint NOT NULL CHECK (quoted_total_minor > 0),
  currency              char(3) NOT NULL,
  customer              jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                hold_status NOT NULL DEFAULT 'ACTIVE',
  expires_at            timestamptz NOT NULL,
  supplier_booking_key  text,        -- Source 1: supplier pre-book / block key
  supplier_booking_ref  text,        -- Source 1: supplier confirmation number
  payment_provider      text,
  payment_order_id      text UNIQUE,
  payment_id            text,
  status_reason         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  confirmed_at          timestamptz,
  CHECK (check_out > check_in)
);
CREATE INDEX inventory_holds_expiry ON inventory_holds (expires_at) WHERE status = 'ACTIVE';
CREATE INDEX inventory_holds_needs_refund ON inventory_holds (created_at) WHERE status = 'NEEDS_REFUND';

-- -----------------------------------------------------------------------------
-- Inbound webhook log: de-duplicates retried pushes by the partner's requestId.
-- -----------------------------------------------------------------------------
CREATE TABLE webhook_events (
  id          bigserial PRIMARY KEY,
  partner_id  uuid NOT NULL REFERENCES channel_partners(id),
  request_id  text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload     jsonb NOT NULL,
  result      jsonb,
  UNIQUE (partner_id, request_id)
);

-- -----------------------------------------------------------------------------
-- Outbound connectivity: who else needs to hear about changes (other OTAs, the CM,
-- partner websites), and a transactional outbox so no change is ever lost.
-- -----------------------------------------------------------------------------
CREATE TABLE channel_subscriptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id       uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  channel_code   text NOT NULL,                  -- 'STAAH', 'PARTNER_SITE_X', ...
  endpoint_url   text NOT NULL CHECK (endpoint_url LIKE 'https://%' OR endpoint_url LIKE 'http://localhost%' OR endpoint_url LIKE 'http://127.0.0.1%'),
  signing_secret text NOT NULL,
  event_types    text[] NOT NULL DEFAULT ARRAY['ARI_CHANGED', 'RESERVATION_CREATED'],
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hotel_id, channel_code)
);

CREATE TABLE ari_outbox (
  id              bigserial PRIMARY KEY,
  event_type      text NOT NULL,                 -- ARI_CHANGED | RESERVATION_CREATED | SUPPLIER_BOOK
  hotel_id        uuid NOT NULL REFERENCES hotels(id),
  subscription_id uuid REFERENCES channel_subscriptions(id) ON DELETE CASCADE,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'IN_FLIGHT', 'DONE', 'DEAD')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz
);
CREATE INDEX ari_outbox_due ON ari_outbox (next_attempt_at) WHERE status IN ('PENDING', 'IN_FLIGHT');
