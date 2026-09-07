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
-- Problem reports v1: "this job is wrong", from anybody.
-- Additive only; safe to replay.
-- ---------------------------------------------------------------------------

-- A viewer who spots a mis-parsed job had no way to say so. Everything on the
-- board is derived from a WhatsApp message by rules, so the people best placed
-- to notice a wrong ZIP or a job that is long gone are the drivers reading it --
-- and most of them are not signed in, because browsing never needs an account.
-- So this table takes reports from anonymous callers, and its SHAPE is what
-- makes that survivable.
--
-- ONE ROW PER (job, reason), not one row per POST -- that is the abuse story.
-- The number of rows this table can ever hold is bounded by the corpus times a
-- handful of reasons, not by the number of requests, so a flood raises
-- `occurrences` on rows that already exist instead of growing a queue an admin
-- has to wade through. Ten people reporting the same wrong pickup is also
-- better signal than ten rows each saying it once.
--
-- The reason vocabulary is deliberately NOT a CHECK: it is validated in
-- src/app/api/reports/route.ts against a list the admin console renders its
-- labels from, and it will change as we learn what people actually report.
-- `status` is CHECKed, because those three words are not going to change.
CREATE TABLE IF NOT EXISTS problem_reports (
  id            bigserial PRIMARY KEY,
  -- Soft reference, deliberately no FK: a report about a job that was since
  -- deleted or superseded is still the thing an admin needs to read, and it is
  -- often the report that explains why the row went.
  load_id       bigint NOT NULL,
  reason        text NOT NULL,
  -- Free text typed by a stranger. Trimmed, control characters stripped and cut
  -- to 500 characters on write; this CHECK is the second line of defence, for
  -- the day a new caller forgets to do that. NULL when they said nothing, which
  -- is the common case -- the reason is the part that carries the meaning.
  details       text CHECK (details IS NULL OR length(details) <= 500),
  -- users.id when the reporter happened to be signed in, NULL when not. No FK,
  -- and no IP address anywhere in this table: a report is about a job, and
  -- keeping less about the person who filed it is the whole of what we owe them.
  reported_by   bigint,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  occurrences   integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  -- Who closed it and when. Always a real admin: only requireWriteRole reaches
  -- PATCH /api/admin/reports/:id.
  resolved_at   timestamptz,
  resolved_by   bigint,
  UNIQUE (load_id, reason)
);

-- The queue's only read: open reports, most recently reported first.
CREATE INDEX IF NOT EXISTS problem_reports_status_idx
  ON problem_reports (status, last_seen_at DESC);

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

-- ---------------------------------------------------------------------------
-- Authorization v4: a demo account may post, but not onto the public board.
-- Additive only; safe to replay.
-- ---------------------------------------------------------------------------

-- Was this row published from a demo account?
--
-- `requirePosting()` still lets a demo account post, and that is still right:
-- filling the form, seeing the listing, opening it and marking it taken IS the
-- poster walkthrough, and a demo that cannot do it demonstrates nothing. What
-- was wrong was the sentence after it -- that refusing them "buys no protection,
-- because anyone can post by registering". Registering is not the same act. A
-- registered account has an address, a row of its own, and a `can_post` an admin
-- can withdraw from it alone; the demo identities are ONE SHARED ROW that
-- `POST /api/auth/demo` hands to any visitor with no credential at all. There is
-- nothing to attribute a bad listing to, and nothing to revoke that would not
-- also close the demo for everyone. With DEMO_MODE=on in production that left a
-- stranger two clicks from a listing every visitor to the live board could see.
--
-- So the demo keeps the whole flow, and what it posts stays private to the
-- account that posted it: src/lib/loads/query.ts admits such a row only to
-- `posted_by`, and to a real admin who explicitly asks for it.
--
-- A COLUMN ON THE ROW rather than a join to `users.is_demo`, for two reasons.
-- It records what was true when the row was written, so re-marking an account
-- cannot retroactively publish or hide what it already posted. And it survives
-- `posted_by` going NULL, which fails CLOSED: a row that is `is_demo` with no
-- owner is visible to nobody, where a join would have made it visible to all.
--
-- DEFAULT false is the load-bearing half. Every row that exists today, and
-- every row the WhatsApp pipeline will ever write, is public exactly as before;
-- src/lib/pipeline/web.ts is the only writer that ever sets it true.
ALTER TABLE loads ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

-- Partial, and keyed on the owner: the predicate every board query carries
-- (`is_demo = false`) matches almost every row and is not worth an index, while
-- the two reads that ARE selective -- this demo account's own listings, for its
-- own board and for the sweep in insertWebJob -- both start from `posted_by`.
CREATE INDEX IF NOT EXISTS loads_demo_owner_idx ON loads (posted_by) WHERE is_demo;

-- ---------------------------------------------------------------------------
-- Available Truck Space v1.
--
-- A capacity listing is NOT a shipment. It has its own table because:
--   * loads' id-addressed reads (getLoad, revealContact, setManualStatus,
--     roadDistance, /api/reports) carry NO status or kind predicate, so a
--     discriminator would make an unreviewed row reachable by incrementing a
--     bigserial;
--   * rebuildSender() is `UPDATE loads ... WHERE sender_key = $1` and delists
--     whatever a sender's newest full post omits. A truck is not inventory.
--     It must be UNREACHABLE by that statement, not merely unmatched by it;
--   * free_cf is a hole in the air and loads.cubic_feet is freight on a floor.
--     They must never meet in one sum().
--
-- Every numeric column here is deliberately named differently from its job
-- counterpart so that `summary.totalCf + summary.totalFreeCf` is something you
-- have to type on purpose.
--
-- Additive only and safe to replay. Nothing above is renamed, edited or dropped.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trucks (
  id                 bigserial PRIMARY KEY,

  -- provenance
  source_message_id  bigint REFERENCES raw_messages(id) ON DELETE SET NULL,
  group_id           bigint REFERENCES whatsapp_groups(id) ON DELETE SET NULL,
  posted_by          bigint REFERENCES users(id) ON DELETE SET NULL,
  sender_key         text REFERENCES senders(key) ON DELETE SET NULL,
  truck_key          text,

  -- IS IT STILL ON OFFER?  Vocabulary deliberately disjoint from loads.status:
  -- a truck is never 'delisted', a job is never 'departed', so a status word
  -- can never be read against the wrong kind of row.
  status             text NOT NULL DEFAULT 'available'
                     CHECK (status IN ('available','booked','departed','expired','cancelled')),
  status_source      text NOT NULL DEFAULT 'derived'
                     CHECK (status_source IN ('derived','manual')),

  -- DO WE BELIEVE IT ENOUGH TO SHOW IT?  A SEPARATE AXIS FROM status, ON
  -- PURPOSE.  `status` is a public filter dimension on the job board
  -- (api/loads/route.ts does not strip it), so a review state expressed as a
  -- status would be an anonymously enumerable queue of machine-invented rows.
  -- `visibility` is never a query key: parseTruckSearchParams has no such key
  -- and 400s on it, and searchTrucks pins it in SQL rather than defaulting it.
  visibility         text NOT NULL DEFAULT 'public'
                     CHECK (visibility IN ('public','pending','rejected','hidden')),
  review_note        text,
  reviewed_by        bigint REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at        timestamptz,

  -- WHERE IT WILL BE EMPTY.  Required, and required to be placeable: a truck
  -- the map cannot draw and the matcher cannot place is not a listing.
  origin_label       text NOT NULL,
  origin_city        text,
  origin_state       text,
  origin_zip         text,
  origin_lat         double precision NOT NULL,
  origin_lng         double precision NOT NULL,
  origin_precision   text CHECK (origin_precision IN ('address','zip','city','region','state')),

  -- WHERE IT IS HEADED.  All-NULL means the post did not say. That is a fact we
  -- print ("No destination stated"), never a fact we fill in. There is no
  -- centroid fallback and no "Anywhere" label.
  dest_label         text,
  dest_city          text,
  dest_state         text,
  dest_zip           text,
  dest_lat           double precision,
  dest_lng           double precision,
  dest_precision     text CHECK (dest_precision IN ('address','zip','city','region','state')),

  leg_miles          double precision,   -- straight line, NULL when no destination
  road_miles         double precision,
  road_minutes       integer,
  road_path          jsonb,

  -- SPACE.  free_cf is what is on offer. truck_cf is the whole vehicle when a
  -- number was stated. truck_text is the words ("26 ft box truck") and is NEVER
  -- converted into cubic feet by anything, ever.
  free_cf            integer CHECK (free_cf  IS NULL OR free_cf  BETWEEN 1 AND 20000),
  truck_cf           integer CHECK (truck_cf IS NULL OR truck_cf BETWEEN 1 AND 20000),
  free_source        text CHECK (free_source IN ('stated','empty_phrase','form')),
  truck_text         text,

  -- WHEN.  avail_now is true ONLY when a phrase resolving to today was stated.
  -- It is never inferred from tense, from a present-tense verb, or from silence.
  avail_now          boolean NOT NULL DEFAULT false,
  avail_from         date,
  avail_to           date,
  avail_source       text CHECK (avail_source IN ('line','header','form')),

  -- The only matcher knob a human sets. One select box.
  corridor_miles     integer NOT NULL DEFAULT 60 CHECK (corridor_miles BETWEEN 10 AND 300),

  -- Self-reported and UNVERIFIED. Never consulted by evaluateMatch().
  has_dot_mc         boolean,
  has_hhg_authority  boolean,
  has_coi            boolean,
  equipment          text[] NOT NULL DEFAULT '{}',
  cannot             text[] NOT NULL DEFAULT '{}',
  equipment_notes    text,
  requirements       text,
  notes              text,

  -- CONTACT.  Same gate, same log, same masking module as a job's.
  contact_name       text,
  contact_phone      text,
  contact_phone_raw  text,
  contact_mode       text NOT NULL DEFAULT 'public' CHECK (contact_mode IN ('public','dm')),
  contact_phone_source text CHECK (contact_phone_source IS NULL
                                   OR contact_phone_source IN ('post','sender')),

  -- PARSE PROVENANCE
  line_text          text,
  supply_phrase      text,        -- which phrase fired; shown in the admin queue
  shape              text,        -- C1..C5, or 'form'
  confidence         real NOT NULL DEFAULT 1,
  needs_review       boolean NOT NULL DEFAULT false,
  flags              text[] NOT NULL DEFAULT '{}',

  first_seen_at      timestamptz,
  last_seen_at       timestamptz,
  seen_count         integer NOT NULL DEFAULT 0,
  expires_at         timestamptz,
  closed_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- A truck never carries a price in v1. There is no price column, so a "cheapest
-- truck" sort cannot be built on nothing, and no truck can pollute the board's
-- median $/cf or "N priced".

-- Posted from a demo account, and therefore visible only to the account that
-- posted it -- the same rule, the same fail-closed reasoning and the same
-- DEFAULT false as `loads.is_demo` above.
--
-- This column is NOT in the specification's DDL, because the demo-visibility
-- work landed after that DDL was written and its open question about demo
-- posting was answered by the tree rather than by the document. Leaving it out
-- would put a stranger two clicks from a truck on the public board the moment
-- stage 2 ships the form. src/lib/loads/truckQuery.ts admits such a row only to
-- `posted_by` and to a real admin who explicitly asks for it, and
-- npm run check:demo asserts trucks and loads answer every audience alike.
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

-- Non-partial for the same ON CONFLICT inference reason as loads_sender_job_idx.
-- sender_key IS NULL (website posts) never collides, because NULLs are distinct.
CREATE UNIQUE INDEX IF NOT EXISTS trucks_sender_key_idx  ON trucks (sender_key, truck_key);
CREATE INDEX IF NOT EXISTS trucks_board_idx   ON trucks (visibility, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS trucks_origin_idx  ON trucks (origin_lat, origin_lng);
CREATE INDEX IF NOT EXISTS trucks_dest_idx    ON trucks (dest_lat, dest_lng);
CREATE INDEX IF NOT EXISTS trucks_state_idx   ON trucks (origin_state, avail_from);
CREATE INDEX IF NOT EXISTS trucks_owner_idx   ON trucks (posted_by, status);
CREATE INDEX IF NOT EXISTS trucks_expires_idx ON trucks (expires_at) WHERE status = 'available';
CREATE INDEX IF NOT EXISTS trucks_pending_idx ON trucks (created_at DESC) WHERE visibility = 'pending';
-- Partial and keyed on the owner, exactly as loads_demo_owner_idx: the board's
-- `is_demo = false` matches almost every row, while "this demo account's own
-- trucks" is the selective read.
CREATE INDEX IF NOT EXISTS trucks_demo_owner_idx ON trucks (posted_by) WHERE is_demo;

-- Why a truck's history is its own table rather than rows in load_events:
-- load_events.load_id is `REFERENCES loads(id)`, so a truck's reveal could not
-- be written there without either dropping that foreign key or pointing it at a
-- row that is not the listing. The admin data-quality view reads the two
-- separately and never sums them.
CREATE TABLE IF NOT EXISTS truck_events (
  id         bigserial PRIMARY KEY,
  truck_id   bigint NOT NULL REFERENCES trucks(id) ON DELETE CASCADE,
  actor_id   bigint REFERENCES users(id) ON DELETE SET NULL,
  -- created | status_changed | edited | viewed_contact | sighted | published | rejected
  kind       text NOT NULL,
  detail     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS truck_events_truck_idx ON truck_events (truck_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Notifications v1 (stage 5). SPEC 3.2, 3.3, 12.
--
-- In-app now, e-mail as a switch and not a rebuild. Three tables and four user
-- columns, appended and replayable like everything above.
--
-- The load-bearing idea is in `truck_matches`: match RESULTS are computed on
-- request and never served from a cache -- a stale score is a lie with a
-- timestamp -- so this table answers exactly one question, "have we already
-- told somebody about this pairing, and at what tier?".
-- ---------------------------------------------------------------------------

-- Why the primary key is enough to defeat the daily repost: a reposted job maps
-- back to the SAME loads.id (loads_sender_job_idx (sender_key, job_key) and
-- pairCfRevisions guarantee it). A repost bumps last_seen_at and seen_count and
-- changes nothing the pairing depends on. Reposting is structurally not news.
CREATE TABLE IF NOT EXISTS truck_matches (
  truck_id        bigint NOT NULL REFERENCES trucks(id) ON DELETE CASCADE,
  load_id         bigint NOT NULL REFERENCES loads(id)  ON DELETE CASCADE,
  tier            text NOT NULL CHECK (tier IN ('strong','possible')),
  score           real NOT NULL,
  detour_miles    integer,
  off_route_miles integer,
  first_matched_at timestamptz NOT NULL DEFAULT now(),
  last_matched_at  timestamptz NOT NULL DEFAULT now(),
  -- stamped when a re-evaluation stops finding the pairing; cleared when it returns
  unmatched_at    timestamptz,
  notified_at     timestamptz,
  notified_tier   text CHECK (notified_tier IN ('strong','possible')),
  dismissed_at    timestamptz,
  dismissed_by    bigint REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (truck_id, load_id)
);
CREATE INDEX IF NOT EXISTS truck_matches_truck_idx ON truck_matches (truck_id, tier, score DESC);
CREATE INDEX IF NOT EXISTS truck_matches_load_idx  ON truck_matches (load_id);

-- ONE PAIRING, TWO AUDIENCES.  These two columns are NOT in the specification's
-- DDL, and the feature does not work without them.  SPEC 3.2 gives a single
-- `notified_at`, and SPEC 12.2's sweep stamps it in the TRUCK loop -- but SPEC
-- 18 N2 requires "exactly one notification for EACH owner" of a matched
-- truck/job pair, and one column cannot record two independent "have we told
-- them" facts.  With only `notified_at`, notifying the truck's owner marks the
-- row notified and the mirror loop then finds nothing new for the job's owner,
-- silently.  `notified_at` / `notified_tier` keep the specification's names and
-- the specification's meaning (the truck owner's memory); these two are the
-- mirror's, written only by the job loop.
ALTER TABLE truck_matches ADD COLUMN IF NOT EXISTS notified_job_at   timestamptz;
ALTER TABLE truck_matches ADD COLUMN IF NOT EXISTS notified_job_tier text;
ALTER TABLE truck_matches DROP CONSTRAINT IF EXISTS truck_matches_notified_job_tier_check;
ALTER TABLE truck_matches ADD CONSTRAINT truck_matches_notified_job_tier_check
  CHECK (notified_job_tier IS NULL OR notified_job_tier IN ('strong','possible'));

-- An owner editing a departure date can flip dozens of pairings at once. The
-- edit stamps this ten minutes out; the sweep skips the truck until it passes
-- and then emits ONE digest instead of one alert per flipped pairing (12.1.3).
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS quiet_until timestamptz;

CREATE TABLE IF NOT EXISTS notifications (
  id           bigserial PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('new_matches_for_truck','new_matches_for_job')),
  subject_kind text NOT NULL CHECK (subject_kind IN ('truck','load')),
  subject_id   bigint NOT NULL,
  -- { count, tiers: {strong,possible}, top: [{id, tier, lane, reasons}] }
  -- Enough to render the row without a join, because the subject may be gone by
  -- the time it is read, and enough to be an e-mail body later. It carries no
  -- phone and no sender key: npm run check:redact reads every row of it.
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  read_at      timestamptz
);
CREATE INDEX IF NOT EXISTS notifications_user_idx   ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- What makes SPEC 12.2's `ON CONFLICT DO NOTHING` mean something.
--
-- Nothing in SPEC 3.3 is UNIQUE, so that clause would be decoration: with no
-- constraint there is no conflict to do nothing about, and two cron runs that
-- overlap -- a scheduler firing while the previous minute is still going -- both
-- read "no notification in the last 12 h" and both insert. The hour bucket is
-- the coarsest grain that cannot false-positive inside a real 12-hour cap and
-- still catches every overlapping run. AT TIME ZONE 'UTC' is what makes the
-- expression immutable enough to index.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_subject_hour_idx
  ON notifications (user_id, subject_kind, subject_id, date_trunc('hour', created_at AT TIME ZONE 'UTC'));

-- The e-mail switch, shipped now and used later. A NOTIFICATION always exists;
-- a DELIVERY is an attempt against it. Turning e-mail on adds rows here and one
-- writer. It needs no schema change and no backfill -- and, critically, no
-- "WHERE sent_at IS NULL" query that would mail months of accumulated backlog on
-- its first run.
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id              bigserial PRIMARY KEY,
  notification_id bigint NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('inapp','email')),
  status          text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed','skipped')),
  detail          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notification_deliveries_notif_idx
  ON notification_deliveries (notification_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_inapp boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_email boolean NOT NULL DEFAULT false;
-- Shipped now: retrofitting an unsubscribe token onto live accounts the day SES
-- is switched on is exactly the step that gets skipped under deadline. A column
-- that is NULL on every row IS that step being skipped, so it carries a DEFAULT
-- for accounts made from here on and is backfilled once for the ones already
-- here. md5-of-random rather than an extension: an unsubscribe link is not a
-- credential, and pgcrypto is not guaranteed present on both backends.
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_token text;
ALTER TABLE users ALTER COLUMN notify_token SET DEFAULT (md5(random()::text) || md5(random()::text));
UPDATE users SET notify_token = md5(random()::text) || md5(random()::text)
 WHERE notify_token IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_notify_token_idx ON users (notify_token);
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_email_since timestamptz;

-- Watermark for the match sweep, so the sweep is a function of listing rows and
-- not of a WhatsApp processing run. POST /api/cron/process drains raw_messages
-- only; hanging matching off it would mean a truck or a job created through the
-- form never notified anybody -- the most likely shipping configuration, and one
-- where the bell renders a permanent zero as if it worked.
CREATE TABLE IF NOT EXISTS match_runs (
  id         bigserial PRIMARY KEY,
  ran_at     timestamptz NOT NULL DEFAULT now(),
  watermark  timestamptz NOT NULL,
  trucks_scanned integer NOT NULL DEFAULT 0,
  pairs_written  integer NOT NULL DEFAULT 0,
  notifications_written integer NOT NULL DEFAULT 0
);
-- The sweep opens with `SELECT max(watermark)`, which is the whole of its state.
CREATE INDEX IF NOT EXISTS match_runs_watermark_idx ON match_runs (watermark DESC);

-- What the scheduler actually did, readable without CloudWatch.
--
-- The three sweeps run IN-PROCESS (src/lib/cron/, started from
-- src/instrumentation.ts) rather than from EventBridge, so their only other
-- witness is a container log line an admin cannot reach. This table is the one
-- they can: /admin opens with a strip saying when each sweep last finished and
-- what it did.
--
-- A row is INSERTed with status 'running' BEFORE the sweep starts and UPDATEd
-- when it ends, in that order and never the other way round. A run that never
-- finishes -- a task killed mid-sweep, a query that hangs -- then leaves a
-- 'running' row behind, which is exactly the state the readout has to be able
-- to show. A row written only at the end would make a hung sweep and a sweep
-- that never started look identical, and those are different emergencies.
--
-- 'skipped' is a first-class outcome, not an error: it is what a task writes
-- when another task holds the advisory lock, and under `desired_count > 1` it
-- is the normal case for every task but one. Folding it into 'error' would
-- paint correct behaviour red.
CREATE TABLE IF NOT EXISTS cron_runs (
  id          bigserial PRIMARY KEY,
  sweep       text NOT NULL,
  status      text NOT NULL DEFAULT 'running'
              CHECK (status IN ('running','ok','error','skipped')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  -- The error message, or the reason the run was skipped. NULL on an 'ok' run:
  -- there is nothing to say about one beyond its counts.
  detail      text,
  -- Per-sweep counters, whatever that sweep counts. Deliberately shapeless: the
  -- expiry sweep's three numbers and the match sweep's eight are not the same
  -- quantity and must never be added, so there is no column here that could
  -- hold "the total".
  counts      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Which process wrote it. Meaningless at desired_count = 1 and the whole
  -- point the day it is 2: "skipped, lock held" is only legible beside who was
  -- holding it.
  runner      text
);
CREATE INDEX IF NOT EXISTS cron_runs_sweep_started_idx ON cron_runs (sweep, started_at DESC);
-- The readout's real question is "when did this sweep last COMPLETE", which is
-- not "when did it last start" on a board where skips are normal.
CREATE INDEX IF NOT EXISTS cron_runs_sweep_ok_idx
  ON cron_runs (sweep, finished_at DESC) WHERE status = 'ok';
