-- LoadLine schema. Plain SQL, portable across Postgres 14+ and PGlite.
--
-- The whole file is replayed by migrate() in src/lib/db.ts on every boot, on a
-- fresh database and on one that already holds v1 data. Every statement must
-- therefore be safe to run twice: CREATE ... IF NOT EXISTS, ALTER ... ADD
-- COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS before ADD CONSTRAINT.
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
  role          text NOT NULL DEFAULT 'driver'
                CHECK (role IN ('driver', 'poster', 'admin')),
  company       text,
  -- legacy "my current location" default; the viewer location now lives in the
  -- browser (src/lib/location.ts) and these columns are never written
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
  -- why a message produced no jobs: 'not_a_load', 'no_origin', 'unknown_format', 'no_geocode'
  skip_reason   text,
  error         text,
  attempts      integer NOT NULL DEFAULT 0,
  extractor     text,                     -- 'inventory-v1' (was 'heuristic' / 'claude:<model>')
  extracted     jsonb,                    -- ExtractionOutcome, kept for auditing
  processed_at  timestamptz,
  payload       jsonb                     -- original webhook envelope
);

CREATE INDEX IF NOT EXISTS raw_messages_status_idx ON raw_messages (status, id);
CREATE INDEX IF NOT EXISTS raw_messages_sent_at_idx ON raw_messages (sent_at DESC);
CREATE INDEX IF NOT EXISTS raw_messages_group_idx ON raw_messages (group_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS loads (
  id                bigserial PRIMARY KEY,
  -- SET NULL, not CASCADE: deleting a message must not silently take its jobs
  -- with it while other snapshots still sight them (see reconcile.ts).
  source_message_id bigint REFERENCES raw_messages(id) ON DELETE SET NULL,
  group_id          bigint REFERENCES whatsapp_groups(id) ON DELETE SET NULL,
  -- set when a poster posts directly through the website instead of via WhatsApp
  posted_by         bigint REFERENCES users(id) ON DELETE SET NULL,

  status            text NOT NULL DEFAULT 'available'
                    CHECK (status IN ('available', 'delisted', 'pending', 'taken', 'expired', 'cancelled')),

  pickup_label      text NOT NULL,        -- "Kearny, NJ 07032"
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

  pickup_date       date,                 -- = ready_date (legacy mirror; batch path writes both)
  pickup_time       time,                 -- legacy, never written by the batch path
  pickup_time_note  text,                 -- legacy, never written by the batch path
  delivery_date     date,                 -- legacy, unwritten

  load_type         text,                 -- legacy freight field, never written
  weight_lbs        integer,              -- legacy, never written by the batch path
  pallets           integer,              -- legacy freight field, never written
  pieces            integer,              -- legacy, never written
  rate_usd          numeric(10, 2),       -- COALESCE(price_flat, price_per_cf * cubic_feet)

  contact_name      text,
  contact_phone     text,
  contact_phone_raw text,
  notes             text,

  confidence        real NOT NULL DEFAULT 0,   -- 0..1, from the extractor
  needs_review      boolean NOT NULL DEFAULT false,

  -- Duplicate handling is legacy: supersession (sender snapshots) replaced
  -- repost-dedup. Every batch job is canonical; the columns stay for the
  -- admin cross-sender "twins" view.
  dup_group_id      text,
  is_canonical      boolean NOT NULL DEFAULT true,
  dup_of            bigint REFERENCES loads(id) ON DELETE SET NULL,
  dup_score         real,

  expires_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- The composite index that carries the default board query lives in the v2
-- block below (loads_board_idx). loads_active_idx is harmless and kept so an
-- existing database is not churned.
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
  kind       text NOT NULL,   -- created | status_changed | viewed_contact | merged | edited | sighted
  detail     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS load_events_load_idx ON load_events (load_id, created_at DESC);

-- Geocode cache. Keyed on the normalized query string so repeated WhatsApp
-- phrasings ("philly", "Philadelphia PA") collapse onto one paid lookup.
-- v2 also stores prefixed keys: zip:<5>, "city:<city>, <st>", q:<normalized>.
CREATE TABLE IF NOT EXISTS places (
  query      text PRIMARY KEY,
  label      text NOT NULL,
  city       text,
  state      text,
  zip        text,
  lat        double precision NOT NULL,
  lng        double precision NOT NULL,
  precision  text NOT NULL,
  -- gazetteer | alias | learned | here | zip-approx | context | state-centroid | geonames | coordinates
  source     text NOT NULL,
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

-- Road distance and drive time for the load's own lane, from the HERE truck
-- router. Cached because it never changes for a given pickup/delivery pair and
-- each lookup is a billable API call. NULL means "not looked up yet" -- it is
-- filled lazily the first time someone opens the load.
ALTER TABLE loads ADD COLUMN IF NOT EXISTS road_miles   double precision;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS road_minutes integer;

-- The road itself, from the SAME billable call that filled road_miles: adding
-- `polyline` to the router's `return` list costs nothing but response size. The
-- geometry arrives as HERE's flexible polyline (~67 KB for a cross-country
-- truck route), is decoded and thinned to ~500 points server-side, and is
-- stored here as a JSON array of [lng, lat] pairs -- roughly 9 KB, and the same
-- line at every zoom the board offers. NULL means "never routed"; the map fills
-- it the first time somebody opens the job.
ALTER TABLE loads ADD COLUMN IF NOT EXISTS road_path jsonb;

-- ---------------------------------------------------------------------------
-- Moving-industry pivot v2: sender inventories, supersession, unknown-pattern
-- queue. Additive only; safe to replay on every boot.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS senders (
  key text PRIMARY KEY, author_phone text, display_name text,
  contact_names text[] NOT NULL DEFAULT '{}', contact_phones text[] NOT NULL DEFAULT '{}',
  contact_mode text NOT NULL DEFAULT 'public' CHECK (contact_mode IN ('public','dm')),
  group_ids bigint[] NOT NULL DEFAULT '{}',
  merged_into text REFERENCES senders(key) ON DELETE SET NULL,
  default_origin jsonb, last_origin jsonb,
  first_snapshot_at timestamptz, last_snapshot_at timestamptz, last_full_at timestamptz,
  snapshot_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sender_snapshots (
  id bigserial PRIMARY KEY,
  sender_key text NOT NULL REFERENCES senders(key) ON DELETE CASCADE,
  message_id bigint NOT NULL UNIQUE REFERENCES raw_messages(id) ON DELETE CASCADE,
  group_id bigint REFERENCES whatsapp_groups(id) ON DELETE SET NULL,
  sent_at timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN ('full','partial','truncated')), kind_reason text,
  job_count integer NOT NULL, job_keys text[] NOT NULL, origin_keys text[] NOT NULL DEFAULT '{}',
  new_count integer NOT NULL DEFAULT 0, kept_count integer NOT NULL DEFAULT 0,
  revived_count integer NOT NULL DEFAULT 0, retired_count integer NOT NULL DEFAULT 0,
  needs_review boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sender_snapshots_sender_idx ON sender_snapshots (sender_key, sent_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS load_sightings (
  load_id bigint NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  snapshot_id bigint NOT NULL REFERENCES sender_snapshots(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL, line_no integer, line_text text,
  cubic_feet integer, price_per_cf numeric(6,2), price_flat numeric(10,2),
  ready_now boolean NOT NULL DEFAULT false, ready_date date,
  ready_source text CHECK (ready_source IN ('line','header','footer','title','assumed')),
  deliver_by date, tags text[] NOT NULL DEFAULT '{}', job_notes text, confidence real,
  PRIMARY KEY (load_id, snapshot_id)
);
CREATE INDEX IF NOT EXISTS load_sightings_snapshot_idx ON load_sightings (snapshot_id);
CREATE INDEX IF NOT EXISTS load_sightings_load_sent_idx ON load_sightings (load_id, sent_at DESC);

ALTER TABLE loads ADD COLUMN IF NOT EXISTS sender_key text REFERENCES senders(key) ON DELETE SET NULL;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS job_key text;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS origin_key text;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS dest_key text;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS ordinal integer NOT NULL DEFAULT 1;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS cubic_feet integer;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS price_per_cf numeric(6,2);
ALTER TABLE loads ADD COLUMN IF NOT EXISTS price_flat numeric(10,2);
ALTER TABLE loads ADD COLUMN IF NOT EXISTS ready_now boolean NOT NULL DEFAULT false;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS ready_date date;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS ready_source text CHECK (ready_source IN ('line','header','footer','title','assumed'));
ALTER TABLE loads ADD COLUMN IF NOT EXISTS deliver_by date;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE loads ADD COLUMN IF NOT EXISTS flags text[] NOT NULL DEFAULT '{}';
ALTER TABLE loads ADD COLUMN IF NOT EXISTS job_notes text;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS line_text text;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS requirements text;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS contact_mode text NOT NULL DEFAULT 'public' CHECK (contact_mode IN ('public','dm'));
ALTER TABLE loads ADD COLUMN IF NOT EXISTS first_seen_at timestamptz;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS seen_count integer NOT NULL DEFAULT 0;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS relist_count integer NOT NULL DEFAULT 0;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS delisted_at timestamptz;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS snapshot_message_id bigint REFERENCES raw_messages(id) ON DELETE SET NULL;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS status_source text NOT NULL DEFAULT 'derived' CHECK (status_source IN ('derived','manual'));
ALTER TABLE loads DROP CONSTRAINT IF EXISTS loads_status_check;
ALTER TABLE loads ADD CONSTRAINT loads_status_check CHECK (status IN ('available','delisted','pending','taken','expired','cancelled'));
ALTER TABLE loads DROP CONSTRAINT IF EXISTS loads_source_message_id_fkey;
ALTER TABLE loads ADD CONSTRAINT loads_source_message_id_fkey FOREIGN KEY (source_message_id) REFERENCES raw_messages(id) ON DELETE SET NULL;
-- NOT partial: Postgres can only infer a partial unique index for ON CONFLICT
-- when the conflict target repeats the predicate, and
-- `ON CONFLICT (sender_key, job_key) DO NOTHING` against a
-- `WHERE sender_key IS NOT NULL` index raises "no unique or exclusion
-- constraint matching the ON CONFLICT specification". NULL keys (website
-- posts) never collide in a unique index, so the predicate bought nothing.
CREATE UNIQUE INDEX IF NOT EXISTS loads_sender_job_idx ON loads (sender_key, job_key);
CREATE INDEX IF NOT EXISTS loads_sender_status_idx ON loads (sender_key, status);
CREATE INDEX IF NOT EXISTS loads_board_idx ON loads (status, is_canonical, ready_now, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS loads_ready_date_idx ON loads (ready_date) WHERE ready_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS loads_deliver_by_idx ON loads (deliver_by) WHERE deliver_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS loads_cf_idx ON loads (cubic_feet);

ALTER TABLE raw_messages ADD COLUMN IF NOT EXISTS flags text[] NOT NULL DEFAULT '{}';
ALTER TABLE raw_messages ADD COLUMN IF NOT EXISTS attention text;
ALTER TABLE raw_messages ADD COLUMN IF NOT EXISTS parse_status text CHECK (parse_status IN ('clean','partial','unknown'));
ALTER TABLE raw_messages ADD COLUMN IF NOT EXISTS format_signature text;
ALTER TABLE raw_messages ADD COLUMN IF NOT EXISTS sender_key text;
CREATE INDEX IF NOT EXISTS raw_messages_attention_idx ON raw_messages (attention) WHERE attention IS NOT NULL;
CREATE INDEX IF NOT EXISTS raw_messages_sender_idx ON raw_messages (sender_key, sent_at DESC);

-- Unknown-pattern workflow: solve once, keep forever.
CREATE TABLE IF NOT EXISTS extraction_rules (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('place','ignore_line','keyword','line_template','sender_format','note_word')),
  scope text NOT NULL DEFAULT 'global',          -- 'global' | 'sender:<sender_key>'
  key text NOT NULL,                             -- normalized header text | line text | word | template id | sender_key
  value jsonb NOT NULL,                          -- place:{city,state,zip,lat,lng,precision,label} keyword:{as} ignore_line:{as} line_template:{template,kind} sender_format:{default_origin,price_mode,bare_number_is,state_from_zip_only}
  source_message_id bigint,                      -- soft reference to raw_messages(id); NO FK: the message may be gone (reset/TRUNCATE) and the rule must survive it
  created_by bigint,                             -- soft reference to users(id); NO FK for the same reason
  note text, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, scope, key)
);
CREATE TABLE IF NOT EXISTS extraction_issues (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,                            -- unknown_line | unknown_format | origin_unresolved | incomplete_destination | two_places | no_origin | state_header_ambiguous | new_format | zip_state_mismatch
  line_hash text NOT NULL,                       -- sha1(kind|normalized line text)
  sample_line text, message_id bigint REFERENCES raw_messages(id) ON DELETE SET NULL,
  sender_key text, occurrences integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','ignored')),
  resolution jsonb,
  UNIQUE (kind, line_hash)
);
CREATE TABLE IF NOT EXISTS pattern_cases (
  id bigserial PRIMARY KEY,
  message_id bigint,                             -- soft reference to raw_messages(id); NO FK (accepted cases outlive the message)
  body text NOT NULL, author text, author_phone text, sent_at timestamptz,
  expected jsonb NOT NULL,                       -- ExpectedJob[]
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS format_signatures (
  signature text PRIMARY KEY,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','known')),
  example_message_id bigint, first_seen timestamptz NOT NULL DEFAULT now(), last_seen timestamptz, messages integer NOT NULL DEFAULT 1
);

-- Access model v2: public browsing; accounts for drivers (contact reveal), posters and admins.
-- Order matters: the old CHECK (carrier, broker, admin) must be dropped BEFORE the UPDATEs on an existing .pgdata.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
UPDATE users SET role = 'driver' WHERE role = 'carrier';
UPDATE users SET role = 'poster' WHERE role = 'broker';
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('driver', 'poster', 'admin'));
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'driver';
-- Demo account identities follow the rename (no-op when the old rows do not exist).
UPDATE users SET email = 'driver@example.com', name = 'Dan Driver'
 WHERE email = 'carrier@example.com' AND NOT EXISTS (SELECT 1 FROM users WHERE email = 'driver@example.com');
UPDATE users SET email = 'poster@example.com', name = 'Rosa Poster', company = 'Sunshine Movers'
 WHERE email = 'broker@example.com' AND NOT EXISTS (SELECT 1 FROM users WHERE email = 'poster@example.com');

-- ---------------------------------------------------------------------------
-- Reachability v1: reaching the sender when the post carried no number.
-- Additive only; safe to replay.
-- ---------------------------------------------------------------------------

-- A group's WhatsApp invite link (https://chat.whatsapp.com/<code>), or the
-- wa.me line of a dispatcher whose "group" is really a DM. It cannot be derived
-- -- somebody with admin rights in the group has to produce it -- so an admin
-- stores it here. Shape-validated on write by src/lib/loads/groupLink.ts.
--
-- GATED, not public. An invite code is harmless on its own, but a wa.me link
-- IS a phone number, and the point of the gate is that reaching the sender
-- takes an account. So the link travels in exactly one payload -- POST
-- /api/loads/:id/contact -- and nothing selects it into a board or detail row.
ALTER TABLE whatsapp_groups ADD COLUMN IF NOT EXISTS invite_url text;

-- Where this row's contact_phone came from: 'post' (the message carried one) or
-- 'sender' (rebuildSender copied the sender's known number onto a row that had
-- none). NULL means "not computed yet". rebuildSender rewrites both markers on
-- every pass -- it clears its own backfill first -- so a stale marker cannot
-- survive a reprocess. The reveal reads it to tell the driver whether they are
-- calling the number in this post or the sender's usual line.
ALTER TABLE loads ADD COLUMN IF NOT EXISTS contact_phone_source text;
ALTER TABLE loads DROP CONSTRAINT IF EXISTS loads_contact_phone_source_check;
ALTER TABLE loads ADD CONSTRAINT loads_contact_phone_source_check
  CHECK (contact_phone_source IS NULL OR contact_phone_source IN ('post', 'sender'));

-- ---------------------------------------------------------------------------
-- Authorization v3: a demo marker, and posting as a capability.
-- Additive only; safe to replay.
-- ---------------------------------------------------------------------------

-- Is this one of the seeded demo identities?
--
-- The demo signs a stranger in as an admin in one click, and that much is the
-- point: the pipeline, the needs-attention queue and the consoles are what
-- there is to show. What it must NOT hand over is the power to destroy the
-- board. Before this column `requireRole("admin")` compared a role string and
-- nothing else, so POST /api/test/reset -- a TRUNCATE over ten tables,
-- including the warmed geocode cache -- was two clicks from the public URL.
--
-- The marker sits on the ROW, not on the session, so it holds however the
-- person signed in: one-click demo, or the ordinary e-mail form with the demo
-- password. A real admin is a row where this is false, which only somebody with
-- database access (or scripts/grant-admin.ts) can produce.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
UPDATE users SET is_demo = true
 WHERE is_demo = false
   AND email IN ('driver@example.com', 'poster@example.com', 'admin@example.com');

-- May this account publish a job from the website?
--
-- Posting used to BE the `poster` role, which made it exclusive: a company that
-- both hauls and posts needed two accounts, and a driver who later wanted to
-- post had to start over. It was never a security boundary either -- anyone can
-- pick "poster" on the registration form in ten seconds -- so the role bought
-- friction and nothing else. Posting is now a capability every account has by
-- default and an admin can withdraw from one that abuses it. `role` keeps admin
-- separate; for everyone else it only records which door they came in through.
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_post boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------------
-- Site settings v1: the five real-world facts only the operator knows.
-- Additive only; safe to replay. Self-contained -- nothing above depends on it.
-- ---------------------------------------------------------------------------

-- Company legal name, support mailbox, registered address, governing law and
-- the legal pages' effective date. Six public pages need all five, and none of
-- them can be derived from anything else in this database, so before this table
-- each one was a `[[PLACEHOLDER]]` compiled into the JSX. An admin fills them in
-- at /admin/settings; src/lib/settings.ts holds the vocabulary and the
-- validation, and is the only module that reads or writes this table.
--
-- ABSENT MEANS UNSET, AND UNSET IS VISIBLE. There is no seeded row and no
-- default here on purpose: a key with no row renders on the public page as the
-- same bracketed token it always did. `value` is NOT NULL and the writer stores
-- no empty strings -- clearing a field DELETES its row -- so "" can never become
-- a company name silently missing from the middle of a Terms sentence.
--
-- `key` is the primary key rather than a serial id: there are five of these,
-- they are named in code, and a settings table wants exactly one row per name.
CREATE TABLE IF NOT EXISTS site_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Who last changed it. ON DELETE SET NULL: removing an account must not take
  -- the company's registered address off the Terms page with it.
  updated_by bigint REFERENCES users(id) ON DELETE SET NULL
);
