-- =============================================================================
-- Direct Channex.io connection (white-label channel manager API).
-- Channex holds the certified links to Booking.com, Expedia, Agoda, MakeMyTrip/Goibibo,
-- Airbnb, Trip.com, Despegar, Yatra, Hostelworld, HyperGuest, Bakuun and ~70 more.
--
-- Push design (what Channex certification asks for):
--   * every ARI change marks the changed dates "dirty" in the same transaction
--     (channex_dirty), so nothing is lost if the process dies;
--   * a worker sends at most one availability call and one restrictions call per
--     property per push, and at most one push every few seconds per property
--     (Channex limit: 10 + 10 calls per minute per property);
--   * we remember exactly what Channex last accepted per night (channex_sent_*) and
--     send only nights whose values differ: true deltas, never a timed full sync.
-- =============================================================================

CREATE TABLE channex_properties (
  hotel_id             uuid PRIMARY KEY REFERENCES hotels(id) ON DELETE CASCADE,
  channex_property_id  uuid NOT NULL UNIQUE,
  push_enabled         boolean NOT NULL DEFAULT true,
  next_push_at         timestamptz NOT NULL DEFAULT now(),   -- throttle + backoff
  locked_until         timestamptz,                          -- worker lease
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_push_at         timestamptz,
  last_push_error      text,
  last_warnings        jsonb,                                -- values Channex rejected (200 + warnings)
  last_task_ids        text[],                               -- Channex task ids of the last push
  last_full_sync_at    timestamptz,
  connected_by         uuid REFERENCES hotel_users(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Mapping layer: our ids <-> Channex UUIDs.
CREATE TABLE channex_room_map (
  room_type_id         uuid PRIMARY KEY REFERENCES room_types(id) ON DELETE CASCADE,
  hotel_id             uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  channex_room_type_id uuid NOT NULL,
  UNIQUE (hotel_id, channex_room_type_id)
);
CREATE TABLE channex_rate_map (
  rate_plan_id         uuid PRIMARY KEY REFERENCES rate_plans(id) ON DELETE CASCADE,
  hotel_id             uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  channex_rate_plan_id uuid NOT NULL,
  UNIQUE (hotel_id, channex_rate_plan_id)
);

-- Changed ranges waiting to be pushed. NULL room type = every room type of the hotel;
-- NULL rate plan = availability + every rate plan of the room type.
CREATE TABLE channex_dirty (
  id           bigserial PRIMARY KEY,
  hotel_id     uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  room_type_id uuid,
  rate_plan_id uuid,
  date_from    date NOT NULL,
  date_to      date NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channex_dirty_hotel ON channex_dirty (hotel_id, id);

-- What Channex last accepted, per night. Diffing against this makes every push a delta.
CREATE TABLE channex_sent_availability (
  room_type_id uuid NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
  stay_date    date NOT NULL,
  availability integer NOT NULL,
  PRIMARY KEY (room_type_id, stay_date)
);
CREATE TABLE channex_sent_restrictions (
  rate_plan_id uuid NOT NULL REFERENCES rate_plans(id) ON DELETE CASCADE,
  stay_date    date NOT NULL,
  sig          text NOT NULL,        -- canonical JSON of the values sent
  PRIMARY KEY (rate_plan_id, stay_date)
);

-- Every booking revision pulled from Channex. APPLIED rows are acknowledged to Channex;
-- FAILED rows (e.g. unmapped room) stay unacknowledged, so Channex keeps them in the
-- feed and alerts, and we retry after the mapping is fixed.
CREATE TABLE channex_booking_revisions (
  revision_id  uuid PRIMARY KEY,
  booking_id   uuid NOT NULL,
  hotel_id     uuid REFERENCES hotels(id) ON DELETE CASCADE,
  status       text NOT NULL,                  -- new | modified | cancelled
  state        text NOT NULL CHECK (state IN ('APPLIED', 'FAILED')),
  result       text,                           -- booked | cancelled | not_found | unchanged
  error        text,
  attempts     integer NOT NULL DEFAULT 1,
  ota_name     text,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  applied_at   timestamptz,
  acked_at     timestamptz
);
CREATE INDEX channex_revisions_unacked ON channex_booking_revisions (hotel_id) WHERE acked_at IS NULL;

ALTER TABLE reservations ADD COLUMN channex_booking_id uuid;
CREATE INDEX reservations_channex_booking ON reservations (channex_booking_id) WHERE channex_booking_id IS NOT NULL;
