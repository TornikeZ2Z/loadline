/** Dashboard aggregates. One module so the page and the API agree. */
import { query, queryOne } from "@/lib/db";
import { radiusBoundingBox } from "@/lib/geo/math";
import type { GeoPoint, LoadRow } from "./types";
import { searchLoads } from "./query";

export interface DashboardStats {
  availableToday: number;
  availableTomorrow: number;
  newLast24h: number;
  nearMe: number;
  totalAvailable: number;
  needsReview: number;
  topStates: Array<{ state: string; count: number }>;
  topLanes: Array<{ lane: string; count: number }>;
  recent: LoadRow[];
  near: LoadRow[];
  pipeline: {
    pending: number;
    processedToday: number;
    skippedToday: number;
    errors: number;
    duplicateClusters: number;
  };
}

export async function dashboardStats(viewer: GeoPoint | null): Promise<DashboardStats> {
  const counts = await queryOne<{
    total: number;
    today: number;
    tomorrow: number;
    fresh: number;
    review: number;
  }>(
    `SELECT
       count(*) FILTER (WHERE status = 'available' AND is_canonical)::int AS total,
       count(*) FILTER (WHERE status = 'available' AND is_canonical AND pickup_date = CURRENT_DATE)::int AS today,
       count(*) FILTER (WHERE status = 'available' AND is_canonical AND pickup_date = CURRENT_DATE + 1)::int AS tomorrow,
       count(*) FILTER (WHERE is_canonical AND created_at > now() - interval '24 hours')::int AS fresh,
       count(*) FILTER (WHERE status = 'available' AND is_canonical AND needs_review)::int AS review
     FROM loads`,
  );

  const topStates = await query<{ state: string; count: number }>(
    `SELECT pickup_state AS state, count(*)::int AS count
       FROM loads
      WHERE status = 'available' AND is_canonical AND pickup_state IS NOT NULL
      GROUP BY pickup_state ORDER BY count DESC, state LIMIT 8`,
  );

  const topLanes = await query<{ lane: string; count: number }>(
    `SELECT pickup_state || ' to ' || delivery_state AS lane, count(*)::int AS count
       FROM loads
      WHERE status = 'available' AND is_canonical
        AND pickup_state IS NOT NULL AND delivery_state IS NOT NULL
        AND pickup_state <> delivery_state
      GROUP BY 1 ORDER BY count DESC, lane LIMIT 6`,
  );

  const pipeline = await queryOne<{
    pending: number;
    processed_today: number;
    skipped_today: number;
    errors: number;
  }>(
    `SELECT
       count(*) FILTER (WHERE status = 'pending')::int AS pending,
       count(*) FILTER (WHERE status = 'done' AND processed_at > now() - interval '24 hours')::int AS processed_today,
       count(*) FILTER (WHERE status = 'skipped' AND processed_at > now() - interval '24 hours')::int AS skipped_today,
       count(*) FILTER (WHERE status = 'error')::int AS errors
     FROM raw_messages`,
  );

  const clusters = await queryOne<{ n: number }>(
    `SELECT count(DISTINCT dup_group_id)::int AS n FROM loads WHERE dup_group_id IS NOT NULL`,
  );

  const recent = (await searchLoads({ sort: "newest", limit: 6, viewer })).rows;

  let near: LoadRow[] = [];
  let nearCount = 0;
  if (viewer) {
    const result = await searchLoads({
      origin: viewer,
      radiusMiles: 100,
      sort: "distance",
      limit: 6,
      viewer,
    });
    near = result.rows;
    nearCount = result.total;
  }

  return {
    availableToday: counts?.today ?? 0,
    availableTomorrow: counts?.tomorrow ?? 0,
    newLast24h: counts?.fresh ?? 0,
    nearMe: nearCount,
    totalAvailable: counts?.total ?? 0,
    needsReview: counts?.review ?? 0,
    topStates,
    topLanes,
    recent,
    near,
    pipeline: {
      pending: pipeline?.pending ?? 0,
      processedToday: pipeline?.processed_today ?? 0,
      skippedToday: pipeline?.skipped_today ?? 0,
      errors: pipeline?.errors ?? 0,
      duplicateClusters: clusters?.n ?? 0,
    },
  };
}

/** Pickup pins for the map, aggregated by city so dense metros stay readable. */
export async function mapClusters(bounds: {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}): Promise<Array<{ city: string; state: string; lat: number; lng: number; count: number }>> {
  return query(
    `SELECT pickup_city AS city, pickup_state AS state,
            avg(pickup_lat) AS lat, avg(pickup_lng) AS lng, count(*)::int AS count
       FROM loads
      WHERE status = 'available' AND is_canonical
        AND pickup_lat BETWEEN $1 AND $2 AND pickup_lng BETWEEN $3 AND $4
        AND pickup_city IS NOT NULL
      GROUP BY pickup_city, pickup_state
      ORDER BY count DESC LIMIT 200`,
    [bounds.minLat, bounds.maxLat, bounds.minLng, bounds.maxLng],
  );
}

export { radiusBoundingBox };
