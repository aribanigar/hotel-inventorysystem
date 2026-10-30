-- =============================================================================
-- Hotelier extranet: staff logins, per-hotel access, offline reservations,
-- status history and an audit trail.
-- =============================================================================

CREATE TABLE hotel_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,                 -- scrypt$N$r$p$salt$hash
  is_active     boolean NOT NULL DEFAULT true,
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX hotel_users_email ON hotel_users (lower(email));

-- Which hotels a user may manage, and how much.
--   owner     : everything, incl. rates and staff
--   manager   : inventory, rates, reservations
--   frontdesk : reservations and check-in/out only (no rate or inventory edits)
CREATE TABLE hotel_user_access (
  user_id  uuid NOT NULL REFERENCES hotel_users(id) ON DELETE CASCADE,
  hotel_id uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  role     text NOT NULL CHECK (role IN ('owner', 'manager', 'frontdesk')),
  PRIMARY KEY (user_id, hotel_id)
);

CREATE TABLE extranet_sessions (
  token_hash  text PRIMARY KEY,                -- sha256 of the cookie value; raw token never stored
  user_id     uuid NOT NULL REFERENCES hotel_users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  ip          text,
  user_agent  text
);
CREATE INDEX extranet_sessions_user ON extranet_sessions (user_id);

-- -----------------------------------------------------------------------------
-- Offline reservations: walk-ins, phone, WhatsApp, travel agents, other OTAs.
-- A real booking with a guest, not a bare number edit.
-- -----------------------------------------------------------------------------
CREATE TYPE reservation_status AS ENUM ('CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW');

CREATE TABLE reservations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference      text NOT NULL UNIQUE,              -- short human code, e.g. HB-7K3Q9P
  hotel_id       uuid NOT NULL REFERENCES hotels(id),
  room_type_id   uuid NOT NULL REFERENCES room_types(id),
  rate_plan_id   uuid REFERENCES rate_plans(id),
  source         text NOT NULL CHECK (source IN ('WALK_IN', 'PHONE', 'WHATSAPP', 'TRAVEL_AGENT', 'OTHER_OTA', 'OTHER')),
  source_detail  text,                              -- agent name, OTA name, ...
  check_in       date NOT NULL,
  check_out      date NOT NULL,
  rooms          smallint NOT NULL CHECK (rooms BETWEEN 1 AND 20),
  adults         smallint NOT NULL DEFAULT 2 CHECK (adults >= 1),
  children       smallint NOT NULL DEFAULT 0 CHECK (children >= 0),
  guest_name     text NOT NULL,
  guest_phone    text,
  guest_email    text,
  amount_minor   bigint CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency       char(3) NOT NULL DEFAULT 'INR',
  notes          text,
  status         reservation_status NOT NULL DEFAULT 'CONFIRMED',
  -- Nights already given back to inventory (cancel / no-show / early checkout).
  -- Prevents a second status change from releasing the same nights twice.
  released_from  date,
  created_by     uuid REFERENCES hotel_users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (check_out > check_in)
);
CREATE INDEX reservations_hotel_dates ON reservations (hotel_id, check_in);

CREATE TABLE reservation_events (
  id             bigserial PRIMARY KEY,
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  from_status    reservation_status,
  to_status      reservation_status NOT NULL,
  user_id        uuid REFERENCES hotel_users(id),
  remark         text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Audit trail of every extranet change: who, what, when.
-- -----------------------------------------------------------------------------
CREATE TABLE extranet_audit (
  id         bigserial PRIMARY KEY,
  hotel_id   uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES hotel_users(id),
  action     text NOT NULL,                   -- ARI_UPDATE | RESERVATION_CREATE | RESERVATION_STATUS | LOGIN
  summary    text NOT NULL,
  details    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX extranet_audit_hotel ON extranet_audit (hotel_id, created_at DESC);
