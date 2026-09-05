/**
 * Road distance for a load, via the HERE truck router.
 *
 * Deliberately computed **only when a load is opened**, never for a list. A
 * board query returns 50 loads; routing all of them would be 50 billable calls
 * to answer a question nobody asked yet. Straight-line miles are fine for
 * ranking and filtering -- the road number matters once a driver is deciding on
 * one specific job.
 *
 * The load's own lane is cached on the row, because it can never change. The
 * driver-to-pickup leg cannot be cached that way (it depends who is asking), so
 * it is memoized in process on a coarse coordinate key.
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

interface LoadPoints {
  pickup_lat: number | null;
  pickup_lng: number | null;
  delivery_lat: number | null;
  delivery_lng: number | null;
  road_miles: number | null;
  road_minutes: number | null;
}

export async function loadDistances(
  loadId: number,
  viewer: { lat: number; lng: number } | null,
): Promise<LoadDistances> {
  if (!hereConfigured()) return { trip: null, toPickup: null, unavailable: true };

  const row = await queryOne<LoadPoints>(
    `SELECT pickup_lat, pickup_lng, delivery_lat, delivery_lng, road_miles, road_minutes
       FROM loads WHERE id = $1`,
    [loadId],
  );
  if (!row) return { trip: null, toPickup: null, unavailable: false };

  const trip = await tripDistance(loadId, row);
  const toPickup =
    viewer && row.pickup_lat != null && row.pickup_lng != null
      ? await legDistance(viewer, { lat: row.pickup_lat, lng: row.pickup_lng })
      : null;

  return { trip, toPickup, unavailable: false };
}

async function tripDistance(loadId: number, row: LoadPoints): Promise<RoadDistance | null> {
  if (row.road_miles != null && row.road_minutes != null) {
    return { miles: row.road_miles, minutes: row.road_minutes };
  }
  if (row.pickup_lat == null || row.pickup_lng == null) return null;
  if (row.delivery_lat == null || row.delivery_lng == null) return null;

  const result = await hereRoute(
    { lat: row.pickup_lat, lng: row.pickup_lng },
    { lat: row.delivery_lat, lng: row.delivery_lng },
  );
  if (!result) return null;

  await query(`UPDATE loads SET road_miles = $1, road_minutes = $2 WHERE id = $3`, [
    result.miles,
    result.minutes,
    loadId,
  ]);
  return result;
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

  const value = await hereRoute(from, to);
  legCache.set(key, { value, at: Date.now() });
  if (legCache.size > 500) legCache.delete(legCache.keys().next().value!);
  return value;
}
