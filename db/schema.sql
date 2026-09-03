-- Load Marketplace schema. Plain SQL, portable across Postgres 14+ and PGlite.
--
-- GEO NOTE: pickup/delivery coordinates are stored as plain double precision
-- columns and distance is computed with haversine in SQL (see src/lib/loads/query.ts).
-- Every radius/route query is bounding-box prefiltered on the (lat, lng) btree
-- indexes below, which keeps it fast well past the volume a WhatsApp-fed board
-- produces. If you later add PostGIS, see db/postgis.sql for the drop-in upgrade.

CREATE TABLE IF NOT EXISTS users (
  id            bigserial PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name          text NOT NULL,
  phone         text,
  role          text NOT NULL DEFAULT 'carrier'
                CHECK (role IN ('carrier', 'broker', 'admin')),
  company       text,
  -- "my current location" default for radius search
  home_label    text,
  home_lat      double precision,
  home_lng      double precision,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_groups (
  id           bigserial PRIMARY KEY,
  wa_group_id  text UNIQUE,               -- Cloud API group/chat identifier
  name         text NOT NULL,
  description  text,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Immutable log of everything WhatsApp handed us. Loads are derived from this,
-- never the other way around, so the pipeline can always be re-run.
CREATE TABLE IF NOT EXISTS raw_messages (
  id            bigserial PRIMARY KEY,
  group_id      bigint REFERENCES whatsapp_groups(id) ON DELETE SET NULL,
  wa_message_id text UNIQUE,              -- dedupes webhook redelivery
  author_name   text,
  author_phone  text,
  body          text NOT NULL,
  sent_at       timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'processing', 'done', 'skipped', 'error')),
  -- why a message produced no loads: 'not_a_load', 'no_route', 'no_geocode', ...
  skip_reason   text,
  error         text,
  attempts      integer NOT NULL DEFAULT 0,
  extractor     text,                     -- 'claude:<model>' | 'heuristic'
  extracted     jsonb,                    -- raw model output, kept for auditing
  processed_at  timestamptz,
  payload       jsonb                     -- original webhook envelope
);

CREATE INDEX IF NOT EXISTS raw_messages_status_idx ON raw_messages (status, id);
CREATE INDEX IF NOT EXISTS raw_messages_sent_at_idx ON raw_messages (sent_at DESC);
CREATE INDEX IF NOT EXISTS raw_messages_group_idx ON raw_messages (group_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS loads (
  id                bigserial PRIMARY KEY,
  source_message_id bigint REFERENCES raw_messages(id) ON DELETE CASCADE,
  group_id          bigint REFERENCES whatsapp_groups(id) ON DELETE SET NULL,
  -- set when a broker posts directly through the UI instead of via WhatsApp
  posted_by         bigint REFERENCES users(id) ON DELETE SET NULL,

  status            text NOT NULL DEFAULT 'available'
                    CHECK (status IN ('available', 'pending', 'taken', 'expired', 'cancelled')),

  pickup_label      text NOT NULL,        -- "Newark, NJ 07102"
  pickup_address    text,
  pickup_city       text,
  pickup_state      text,
  pickup_zip        text,
  pickup_lat        double precision,
  pickup_lng        double precision,
  pickup_precision  text CHECK (pickup_precision IN ('address', 'zip', 'city', 'region', 'state')),

  delivery_label     text NOT NULL,
  delivery_address   text,
  delivery_city      text,
  delivery_state     text,
  delivery_zip       text,
  delivery_lat       double precision,
  delivery_lng       double precision,
  delivery_precision text CHECK (delivery_precision IN ('address', 'zip', 'city', 'region', 'state')),

  -- straight-line trip length, cached so route/sort queries stay cheap
  trip_miles        double precision,

  pickup_date       date,
  pickup_time       time,
  pickup_time_note  text,                 -- "around 10", "after 2pm", "flexible"
  delivery_date     date,

  load_type         text,                 -- dry van, reefer, flatbed, box truck, ...
  weight_lbs        integer,
  pallets           integer,
  pieces            integer,
  rate_usd          numeric(10, 2),

  contact_name      text,
  contact_phone     text,
  contact_phone_raw text,
  notes             text,

  confidence        real NOT NULL DEFAULT 0,   -- 0..1, from the extractor
  needs_review      boolean NOT NULL DEFAULT false,

  -- Duplicate handling: every load in a duplicate cluster shares dup_group_id,
  -- exactly one of them has is_canonical = true and that is the one users see.
  dup_group_id      text,
  is_canonical      boolean NOT NULL DEFAULT true,
  dup_of            bigint REFERENCES loads(id) ON DELETE SET NULL,
  dup_score         real,

  expires_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- The composite index that carries the default board query.
CREATE INDEX IF NOT EXISTS loads_active_idx
  ON loads (status, is_canonical, pickup_date, id DESC);
CREATE INDEX IF NOT EXISTS loads_pickup_geo_idx ON loads (pickup_lat, pickup_lng);
CREATE INDEX IF NOT EXISTS loads_delivery_geo_idx ON loads (delivery_lat, delivery_lng);
CREATE INDEX IF NOT EXISTS loads_pickup_state_idx ON loads (pickup_state, pickup_date);
CREATE INDEX IF NOT EXISTS loads_delivery_state_idx ON loads (delivery_state, pickup_date);
CREATE INDEX IF NOT EXISTS loads_dup_group_idx ON loads (dup_group_id);
CREATE INDEX IF NOT EXISTS loads_created_idx ON loads (created_at DESC);
CREATE INDEX IF NOT EXISTS loads_expires_idx ON loads (expires_at) WHERE status = 'available';

CREATE TABLE IF NOT EXISTS load_events (
  id         bigserial PRIMARY KEY,
  load_id    bigint NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  actor_id   bigint REFERENCES users(id) ON DELETE SET NULL,
  kind       text NOT NULL,   -- created | status_changed | viewed_contact | merged | edited
  detail     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS load_events_load_idx ON load_events (load_id, created_at DESC);

-- Geocode cache. Keyed on the normalized query string so repeated WhatsApp
-- phrasings ("philly", "Philadelphia PA") collapse onto one paid lookup.
CREATE TABLE IF NOT EXISTS places (
  query      text PRIMARY KEY,
  label      text NOT NULL,
  city       text,
  state      text,
  zip        text,
  lat        double precision NOT NULL,
  lng        double precision NOT NULL,
  precision  text NOT NULL,
  source     text NOT NULL,   -- gazetteer | alias | census | mapbox
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saved_searches (
  id           bigserial PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  params       jsonb NOT NULL,
  notify       boolean NOT NULL DEFAULT false,
  last_run_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
