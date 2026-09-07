/**
 * Road distance -- and the road itself -- for a load, via the HERE truck router.
 *
 * Deliberately computed **only when a load is opened**, never for a list. A
 * board query returns 500 jobs; routing all of them would be 500 billable calls
 * to answer a question nobody asked yet. Straight-line miles are fine for
 * ranking and filtering -- the road number matters once a driver is deciding on
 * one specific job.
 *
 * One call per job, ever. The lane's summary and its geometry come back on the
 * same request (`return=summary,polyline`) and are cached together on the row,
 * because neither can change for a given pickup/delivery pair. That is why
 * `tripDistance` asks for geometry whenever the row has none, even though the
 * job detail only wants the numbers: the map will want the line seconds later,
 * and a second request for it would be a second invoice line.
 *
 * The driver-to-pickup leg cannot be cached on the row (it depends who is
 * asking), so it is memoized in process on a coarse coordinate key -- and it
 * never asks for geometry, because nothing draws it.
 */
import { query, queryOne } from "@/lib/db";
import { hereConfigured, hereRoute, type RoadDistance } from "@/lib/geo/here";

export interface LoadDistances {
  /** Pickup -> delivery by road. */
  trip: RoadDistance | null;
  /** Where the driver is now -> pickup, by road. */
  toPickup: RoadDistance | null;
  /** True when HERE is not configured, so the UI can explain the absence. */
  unavailable: boolean;
}

/** What the map needs to draw one selected job's lane. */
export interface LoadRoadRoute {
  /** The real road, `[lng, lat]`, simplified. Null when there is none to draw. */
  path: [number, number][] | null;
  miles: number | null;
  minutes: number | null;
  /**
   * No road route could be produced -- no key, quota spent, or the router said
   * no. The caller draws its straight dashed line and says so.
   */
  unavailable: boolean;
}

interface LoadPoints {
  pickup_lat: number | null;
  pickup_lng: number | null;
  delivery_lat: number | null;
  delivery_lng: number | null;
  road_miles: number | null;
  road_minutes: number | null;
  road_path: unknown;
}

const POINT_COLUMNS = `pickup_lat, pickup_lng, delivery_lat, delivery_lng,
                       road_miles, road_minutes, road_path`;

export async function loadDistances(
  loadId: number,
  viewer: { lat: number; lng: number } | null,
): Promise<LoadDistances> {
  if (!hereConfigured()) return { trip: null, toPickup: null, unavailable: true };

  const row = await queryOne<LoadPoints>(
    `SELECT ${POINT_COLUMNS} FROM loads WHERE id = $1`,
    [loadId],
  );
  if (!row) return { trip: null, toPickup: null, unavailable: false };

  const trip = await tripRoute(loadId, row);
  const toPickup =
    viewer && row.pickup_lat != null && row.pickup_lng != null
      ? await legDistance(viewer, { lat: row.pickup_lat, lng: row.pickup_lng })
      : null;

  // Only the numbers cross the wire here: the detail drawer shows "1,281 mi by
  // road", and shipping 9 KB of geometry to draw nothing would be waste.
  return {
    trip: trip ? { miles: trip.miles, minutes: trip.minutes } : null,
    toPickup: toPickup ? { miles: toPickup.miles, minutes: toPickup.minutes } : null,
    unavailable: false,
  };
}

/**
 * The lane a selected job draws on the map.
 *
 * Returns null only when the job does not exist. A cached `road_path` is served
 * whether or not HERE is configured today -- the geometry was already paid for,
 * and refusing to draw it because a key was later removed would be theatre.
 */
export async function loadRoadRoute(loadId: number): Promise<LoadRoadRoute | null> {
  const row = await queryOne<LoadPoints>(
    `SELECT ${POINT_COLUMNS} FROM loads WHERE id = $1`,
    [loadId],
  );
  if (!row) return null;

  const cached = parsePath(row.road_path);
  if (cached) {
    return { path: cached, miles: row.road_miles, minutes: row.road_minutes, unavailable: false };
  }

  const fetched = await tripRoute(loadId, row);
  if (!fetched?.path) {
    return {
      path: null,
      miles: fetched?.miles ?? row.road_miles,
      minutes: fetched?.minutes ?? row.road_minutes,
      unavailable: true,
    };
  }
  return {
    path: fetched.path,
    miles: fetched.miles,
    minutes: fetched.minutes,
    unavailable: false,
  };
}

/**
 * The lane a selected TRUCK draws, and the reason it is a second function
 * rather than a `kind` parameter on the one above.
 *
 * The columns are not the same columns. A job's lane runs pickup -> delivery
 * and both ends are required to exist for the row to be worth plotting; a
 * truck's runs origin -> destination and THE DESTINATION IS OPTIONAL, because
 * a post that says "empty in Newark, looking for loads to the midwest" has not
 * named one. That row gets `unavailable` and no path -- never a guessed
 * endpoint, and never a billable call to route towards one.
 *
 * Same billing discipline as a job: the geometry and the summary arrive on one
 * HERE request and are cached together on the row, so a truck costs one routing
 * call in its lifetime however many times it is opened.
 */
export async function truckRoadRoute(truckId: number): Promise<LoadRoadRoute | null> {
  const row = await queryOne<TruckPoints>(
    `SELECT ${TRUCK_POINT_COLUMNS} FROM trucks WHERE id = $1`,
    [truckId],
  );
  if (!row) return null;

  const cached = parsePath(row.road_path);
  if (cached) {
    return { path: cached, miles: row.road_miles, minutes: row.road_minutes, unavailable: false };
  }
  // No destination was ever stated. There is no lane to buy.
  if (row.dest_lat == null || row.dest_lng == null) {
    return { path: null, miles: null, minutes: null, unavailable: true };
  }
  if (!hereConfigured()) {
    return {
      path: null,
      miles: row.road_miles,
      minutes: row.road_minutes,
      unavailable: true,
    };
  }

  const result = await hereRoute(
    { lat: row.origin_lat, lng: row.origin_lng },
    { lat: row.dest_lat, lng: row.dest_lng },
    { withPath: true },
  );
  if (!result?.path) {
    return {
      path: null,
      miles: result?.miles ?? row.road_miles,
      minutes: result?.minutes ?? row.road_minutes,
      unavailable: true,
    };
  }

  await query(`UPDATE trucks SET road_miles = $1, road_minutes = $2, road_path = $3 WHERE id = $4`, [
    result.miles,
    result.minutes,
    JSON.stringify(result.path),
    truckId,
  ]);
  return { path: result.path, miles: result.miles, minutes: result.minutes, unavailable: false };
}

interface TruckPoints {
  origin_lat: number;
  origin_lng: number;
  dest_lat: number | null;
  dest_lng: number | null;
  road_miles: number | null;
  road_minutes: number | null;
  road_path: unknown;
}

const TRUCK_POINT_COLUMNS = `origin_lat, origin_lng, dest_lat, dest_lng,
                             road_miles, road_minutes, road_path`;

interface CachedTrip extends RoadDistance {
  path: [number, number][] | null;
}

/**
 * The job's own lane, from the row when it is there and from HERE when it is
 * not. Geometry is requested whenever the row has none, so the numbers and the
 * line are always bought together.
 */
async function tripRoute(loadId: number, row: LoadPoints): Promise<CachedTrip | null> {
  const cachedPath = parsePath(row.road_path);
  if (row.road_miles != null && row.road_minutes != null && cachedPath) {
    return { miles: row.road_miles, minutes: row.road_minutes, path: cachedPath };
  }

  if (!hereConfigured()) {
    return row.road_miles != null && row.road_minutes != null
      ? { miles: row.road_miles, minutes: row.road_minutes, path: cachedPath }
      : null;
  }
  if (row.pickup_lat == null || row.pickup_lng == null) return null;
  if (row.delivery_lat == null || row.delivery_lng == null) return null;

  const result = await hereRoute(
    { lat: row.pickup_lat, lng: row.pickup_lng },
    { lat: row.delivery_lat, lng: row.delivery_lng },
    { withPath: true },
  );
  if (!result) {
    return row.road_miles != null && row.road_minutes != null
      ? { miles: row.road_miles, minutes: row.road_minutes, path: cachedPath }
      : null;
  }

  await query(`UPDATE loads SET road_miles = $1, road_minutes = $2, road_path = $3 WHERE id = $4`, [
    result.miles,
    result.minutes,
    result.path ? JSON.stringify(result.path) : null,
    loadId,
  ]);
  return { miles: result.miles, minutes: result.minutes, path: result.path };
}

/**
 * `road_path` back into coordinates.
 *
 * jsonb comes back parsed from `pg` and from PGlite, but a text column or a
 * driver change would hand back a string, and a half-written row would hand
 * back something else entirely. Anything that is not a list of pairs is treated
 * as "not routed yet" rather than crashing a public endpoint.
 */
function parsePath(value: unknown): [number, number][] | null {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(raw) || raw.length < 2) return null;

  const out: [number, number][] = [];
  for (const point of raw) {
    if (!Array.isArray(point) || point.length < 2) return null;
    const lng = Number(point[0]);
    const lat = Number(point[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    out.push([lng, lat]);
  }
  return out;
}

// Rounded to ~1km so a driver moving slightly does not re-bill the same leg.
const legCache = new Map<string, { value: RoadDistance | null; at: number }>();
const LEG_TTL_MS = 30 * 60_000;

async function legDistance(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): Promise<RoadDistance | null> {
  const key = [from.lat, from.lng, to.lat, to.lng].map((n) => n.toFixed(2)).join(",");
  const hit = legCache.get(key);
  if (hit && Date.now() - hit.at < LEG_TTL_MS) return hit.value;

  const result = await hereRoute(from, to);
  const value = result ? { miles: result.miles, minutes: result.minutes } : null;
  legCache.set(key, { value, at: Date.now() });
  if (legCache.size > 500) legCache.delete(legCache.keys().next().value!);
  return value;
}
