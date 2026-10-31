-- =============================================================================
-- Full channel-manager feature set: room capacity, derived rate plans, the complete
-- OTA restriction set and extra-guest pricing.
-- =============================================================================

-- Room capacity. max_occupancy stays as the total guest cap (adults + children).
ALTER TABLE room_types
  ADD COLUMN total_rooms    integer  NOT NULL DEFAULT 0 CHECK (total_rooms >= 0),
  ADD COLUMN base_occupancy smallint NOT NULL DEFAULT 2 CHECK (base_occupancy >= 1),
  ADD COLUMN max_adults     smallint NOT NULL DEFAULT 2 CHECK (max_adults >= 1),
  ADD COLUMN max_children   smallint NOT NULL DEFAULT 0 CHECK (max_children >= 0),
  ADD COLUMN max_infants    smallint NOT NULL DEFAULT 0 CHECK (max_infants >= 0);

UPDATE room_types SET max_adults = max_occupancy, base_occupancy = LEAST(2, max_occupancy);

-- Derived rate plans: price follows a parent plan, adjusted by a percentage or amount.
--   derive_type PERCENT : derive_value in basis points (+1500 = +15%, -1000 = -10%)
--   derive_type AMOUNT  : derive_value in minor units (+50000 = +Rs 500)
ALTER TABLE rate_plans
  ADD COLUMN rate_mode           text NOT NULL DEFAULT 'MANUAL' CHECK (rate_mode IN ('MANUAL', 'DERIVED')),
  ADD COLUMN parent_rate_plan_id uuid REFERENCES rate_plans(id) ON DELETE RESTRICT,
  ADD COLUMN derive_type         text CHECK (derive_type IN ('PERCENT', 'AMOUNT')),
  ADD COLUMN derive_value        bigint,
  ADD COLUMN follow_parent_restrictions boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT rate_plans_derived_shape CHECK (
    (rate_mode = 'MANUAL'  AND parent_rate_plan_id IS NULL) OR
    (rate_mode = 'DERIVED' AND parent_rate_plan_id IS NOT NULL AND derive_type IS NOT NULL AND derive_value IS NOT NULL
                           AND parent_rate_plan_id <> id)
  );
CREATE INDEX rate_plans_parent ON rate_plans (parent_rate_plan_id) WHERE parent_rate_plan_id IS NOT NULL;

-- Complete restriction set + extra-guest prices.
--   min_los / max_los           : length of stay counted on the ARRIVAL day (existing)
--   min/max_stay_through        : length of stay checked on EVERY night of the stay
--   min/max_advance_days        : how many days before arrival a booking may be made
--   extra_adult/child_minor     : per extra adult beyond base occupancy / per child, per night
ALTER TABLE daily_rates
  ADD COLUMN min_stay_through  smallint NOT NULL DEFAULT 1 CHECK (min_stay_through >= 1),
  ADD COLUMN max_stay_through  smallint CHECK (max_stay_through IS NULL OR max_stay_through >= 1),
  ADD COLUMN min_advance_days  smallint NOT NULL DEFAULT 0 CHECK (min_advance_days >= 0),
  ADD COLUMN max_advance_days  smallint CHECK (max_advance_days IS NULL OR max_advance_days >= 0),
  ADD COLUMN extra_adult_minor bigint NOT NULL DEFAULT 0 CHECK (extra_adult_minor >= 0),
  ADD COLUMN extra_child_minor bigint NOT NULL DEFAULT 0 CHECK (extra_child_minor >= 0);
