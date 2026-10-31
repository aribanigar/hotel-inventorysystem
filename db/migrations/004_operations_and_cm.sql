-- =============================================================================
-- Operations + channel-manager connectivity:
--   rolling inventory horizon, QloApps-Channel-Manager-compatible PMS link,
--   OTA bookings arriving through a channel manager.
-- =============================================================================

-- Integer ids for external systems that expect them (the QloApps CM uses ints).
ALTER TABLE hotels     ADD COLUMN pms_id integer GENERATED ALWAYS AS IDENTITY UNIQUE;
ALTER TABLE room_types ADD COLUMN pms_id integer GENERATED ALWAYS AS IDENTITY UNIQUE;
ALTER TABLE rate_plans ADD COLUMN pms_id integer GENERATED ALWAYS AS IDENTITY UNIQUE;

-- Keep inventory and rates open for this many days ahead, rolled forward daily
-- (like the CM's "Days to set inventory & rates data"). 0 = off, max 730.
ALTER TABLE hotels ADD COLUMN open_horizon_days smallint NOT NULL DEFAULT 365
  CHECK (open_horizon_days BETWEEN 0 AND 730);

-- A hosted channel manager account (QloApps Channel Manager today) that this system
-- acts as the PMS for. One account can carry several of an owner's hotels.
CREATE TABLE cm_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text NOT NULL DEFAULT 'QLOAPPS_CM' CHECK (provider IN ('QLOAPPS_CM')),
  name           text NOT NULL,
  base_url       text NOT NULL DEFAULT 'https://channels.qloapps.com',
  ws_key_hash    text NOT NULL UNIQUE,      -- sha256 of the webservice key the CM uses to call us
  client_id      text,                      -- OAuth client id for pushing ARI to the CM
  client_secret  text,                      -- encrypt at rest in production
  access_token   text,
  push_enabled   boolean NOT NULL DEFAULT true,
  owner_user_id  uuid REFERENCES hotel_users(id),
  last_push_at   timestamptz,
  last_push_error text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE hotels ADD COLUMN cm_account_id uuid REFERENCES cm_accounts(id) ON DELETE SET NULL;

-- OTA bookings that arrive through a channel manager are reservations too.
ALTER TABLE reservations DROP CONSTRAINT reservations_source_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_source_check
  CHECK (source IN ('WALK_IN', 'PHONE', 'WHATSAPP', 'TRAVEL_AGENT', 'OTHER_OTA', 'OTHER', 'CHANNEL_MANAGER'));
ALTER TABLE reservations
  ADD COLUMN pms_id integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  ADD COLUMN cm_account_id uuid REFERENCES cm_accounts(id),
  ADD COLUMN cm_booking_id text,             -- the channel manager's booking id
  -- An OTA booking can't be refused (the guest already booked on the OTA). If the room
  -- was gone, it is still recorded, flagged, and an ALERT is logged for the desk.
  ADD COLUMN overbooked boolean NOT NULL DEFAULT false,
  ADD COLUMN external_payload jsonb;
CREATE INDEX reservations_cm_booking ON reservations (cm_account_id, cm_booking_id) WHERE cm_booking_id IS NOT NULL;
CREATE INDEX reservations_overbooked ON reservations (hotel_id) WHERE overbooked AND status = 'CONFIRMED';
