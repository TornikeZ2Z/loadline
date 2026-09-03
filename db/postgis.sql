-- OPTIONAL upgrade path, not required by the app.
--
-- The prototype's radius and route queries run on plain lat/lng columns with a
-- bounding-box prefilter plus haversine, which needs no extensions and works on
-- embedded PGlite. Once you are on managed Postgres and load volume justifies
-- it, this migration adds real spatial indexes without touching application
-- code beyond swapping the SQL fragments noted at the bottom.

CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE loads
  ADD COLUMN IF NOT EXISTS pickup_geog   geography(Point, 4326),
  ADD COLUMN IF NOT EXISTS delivery_geog geography(Point, 4326);

UPDATE loads SET
  pickup_geog   = CASE WHEN pickup_lng   IS NOT NULL
                       THEN ST_SetSRID(ST_MakePoint(pickup_lng, pickup_lat), 4326)::geography END,
  delivery_geog = CASE WHEN delivery_lng IS NOT NULL
                       THEN ST_SetSRID(ST_MakePoint(delivery_lng, delivery_lat), 4326)::geography END;

CREATE INDEX IF NOT EXISTS loads_pickup_geog_idx   ON loads USING GIST (pickup_geog);
CREATE INDEX IF NOT EXISTS loads_delivery_geog_idx ON loads USING GIST (delivery_geog);

CREATE OR REPLACE FUNCTION loads_sync_geog() RETURNS trigger AS $fn$
BEGIN
  NEW.pickup_geog := CASE WHEN NEW.pickup_lng IS NOT NULL
    THEN ST_SetSRID(ST_MakePoint(NEW.pickup_lng, NEW.pickup_lat), 4326)::geography END;
  NEW.delivery_geog := CASE WHEN NEW.delivery_lng IS NOT NULL
    THEN ST_SetSRID(ST_MakePoint(NEW.delivery_lng, NEW.delivery_lat), 4326)::geography END;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS loads_sync_geog_trg ON loads;
CREATE TRIGGER loads_sync_geog_trg BEFORE INSERT OR UPDATE ON loads
  FOR EACH ROW EXECUTE FUNCTION loads_sync_geog();

-- Then in src/lib/loads/query.ts, replace the haversine fragments with:
--   radius filter : ST_DWithin(pickup_geog, ST_MakePoint($lng,$lat)::geography, $meters)
--   distance      : ST_Distance(pickup_geog, ST_MakePoint($lng,$lat)::geography) / 1609.344
--   route corridor: ST_DWithin(pickup_geog, ST_MakeLine($origin, $dest)::geography, $meters)
