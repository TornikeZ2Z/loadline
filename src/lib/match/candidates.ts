/**
 * The prefilters: which listings are worth asking `evaluateMatch` about.
 *
 * A bounding box and a status, and nothing else. Every real decision belongs to
 * the pure function -- if a listing is excluded here it is excluded SILENTLY,
 * with no refusal code and no line in the histogram, so this box is deliberately
 * looser than any gate downstream. Anything the box drops, the driver never
 * hears about; anything it keeps costs microseconds.
 *
 * Fourteen columns, not sixty. The full rows for the handful that survive come
 * back through `loadsByIds` / `trucksByIds`, so the board's `SELECT_COLUMNS`
 * and `TRUCK_SELECT_COLUMNS` stay the one place either table's columns are
 * named.
 *
 * BOTH visibility predicates travel with the query and neither can be omitted:
 * the truck side takes a required positional `scope`, and the fragments
 * themselves are imported from the query modules rather than restated here.
 * SPEC 11.9.
 */
import { params, query } from "@/lib/db";
import { radiusBoundingBox, unionBoundingBox, type BoundingBox } from "@/lib/geo/math";
import { boundsClause, radiusClause } from "@/lib/loads/sql";
import { loadDemoVisibilitySql } from "@/lib/loads/query";
import { truckDemoVisibilitySql, truckVisibilityClause, type TruckScope } from "@/lib/loads/truckQuery";
import type { LoadAudience } from "@/lib/loads/types";
import type { TruckAudience } from "@/lib/loads/truckTypes";
import {
  DEFAULT_MATCH_CORRIDOR_MILES,
  MATCH_CANDIDATE_CAP,
  MAX_CORRIDOR_MILES,
  OPEN_TRUCK_RADIUS_MILES,
} from "./constants";
import type { MatchJob, MatchTruck } from "./types";

/** The fourteen columns `evaluateMatch` reads off a job, plus nothing. */
const JOB_MATCH_COLUMNS = `
  l.id, l.status, l.sender_key, l.posted_by,
  l.pickup_lat, l.pickup_lng, l.delivery_lat, l.delivery_lng,
  l.cubic_feet, l.ready_now,
  l.ready_date::text AS ready_date,
  l.deliver_by::text AS deliver_by,
  l.requirements, l.road_miles`;

/** ...and off a truck. */
const TRUCK_MATCH_COLUMNS = `
  t.id, t.status, t.visibility, t.sender_key, t.posted_by,
  t.origin_lat, t.origin_lng, t.dest_lat, t.dest_lng,
  t.corridor_miles, t.free_cf, t.avail_now,
  t.avail_from::text AS avail_from,
  t.avail_to::text   AS avail_to`;

/**
 * The anchor of a match query, read with the same predicates as everything
 * else, so a listing this caller may not see produces the same 404 the detail
 * route produces rather than an empty match list that admits it exists.
 *
 * The narrow column set and not `getLoad`: `LoadRow` has no `road_miles`
 * (`SELECT_COLUMNS` is frozen and does not select it), and the anchor job needs
 * it for exactly the same reason a candidate does.
 */
export async function matchJobById(
  id: number,
  audience?: LoadAudience | null,
): Promise<MatchJob | null> {
  const p = params();
  const where = [`l.id = ${p.add(id)}`];
  const demo = loadDemoVisibilitySql(audience, p);
  if (demo) where.push(demo);
  const rows = await query<MatchJob>(
    `SELECT ${JOB_MATCH_COLUMNS} FROM loads l WHERE ${where.join(" AND ")}`,
    p.values,
  );
  return rows[0] ?? null;
}

/** The same, for the truck side, with the scope that cannot be forgotten. */
export async function matchTruckById(
  id: number,
  scope: TruckScope,
  audience?: TruckAudience | null,
): Promise<MatchTruck | null> {
  const p = params();
  const where = [`t.id = ${p.add(id)}`];
  const vis = truckVisibilityClause(scope);
  if (vis) where.push(vis);
  const demo = truckDemoVisibilitySql(audience, p);
  if (demo) where.push(demo);
  const rows = await query<MatchTruck>(
    `SELECT ${TRUCK_MATCH_COLUMNS} FROM trucks t WHERE ${where.join(" AND ")}`,
    p.values,
  );
  return rows[0] ?? null;
}

/**
 * Anything the driver would reach for. Every gate downstream is tighter than
 * this, and it is tighter than none of them -- which is the only property a
 * prefilter has to have.
 */
function truckReachBox(truck: MatchTruck): BoundingBox | null {
  if (truck.origin_lat == null || truck.origin_lng == null) return null;
  const origin = { lat: truck.origin_lat, lng: truck.origin_lng };
  const half =
    Number.isFinite(truck.corridor_miles) && truck.corridor_miles > 0
      ? truck.corridor_miles
      : DEFAULT_MATCH_CORRIDOR_MILES;

  if (truck.dest_lat == null || truck.dest_lng == null) {
    // Radius mode. SPEC 11.9 pads with OPEN_TRUCK_RADIUS_MILES alone; the gate
    // it feeds accepts out to max(corridor, OPEN_TRUCK_RADIUS_MILES), so a
    // 150-mile driver would have had 50 miles of their own stated reach cut off
    // by the prefilter, with no refusal to show for it. The pad is the gate.
    return radiusBoundingBox(origin, Math.max(half, OPEN_TRUCK_RADIUS_MILES));
  }
  return unionBoundingBox([
    radiusBoundingBox(origin, half),
    radiusBoundingBox({ lat: truck.dest_lat, lng: truck.dest_lng }, half),
  ]);
}

/**
 * Jobs this truck could plausibly reach.
 *
 * Either end inside the box, because a job whose pickup sits outside it may
 * still deliver onto the line -- and the corridor test, not this, is what
 * decides that.
 */
export async function candidateJobsForTruck(
  truck: MatchTruck,
  audience?: LoadAudience | null,
): Promise<MatchJob[]> {
  const box = truckReachBox(truck);
  if (!box) return [];

  const p = params();
  const where = [
    `l.status = 'available'`,
    `(${boundsClause(box, p, "l.pickup_lat", "l.pickup_lng")}
      OR ${boundsClause(box, p, "l.delivery_lat", "l.delivery_lng")})`,
  ];
  const demo = loadDemoVisibilitySql(audience, p);
  if (demo) where.push(demo);

  return query<MatchJob>(
    `SELECT ${JOB_MATCH_COLUMNS}
       FROM loads l
      WHERE ${where.join("\n        AND ")}
      ORDER BY l.last_seen_at DESC NULLS LAST, l.id
      LIMIT ${MATCH_CANDIDATE_CAP}`,
    p.values,
  );
}

/**
 * Trucks that could plausibly take this job.
 *
 * Padded with MAX_CORRIDOR_MILES -- the widest corridor any one truck may
 * choose -- rather than with any particular truck's, so this set can never be
 * narrower than the corridor a truck picked for itself. It is not a perfect
 * mirror of the truck-anchored box and the symmetry guarantee is stated as what
 * can actually be held: for pairs where each side is in the other's candidate
 * set, both directions agree exactly (acceptance M15).
 */
export async function candidateTrucksForJob(
  job: MatchJob,
  scope: TruckScope,
  audience?: TruckAudience | null,
): Promise<MatchTruck[]> {
  if (job.pickup_lat == null || job.pickup_lng == null) return [];
  const pickup = { lat: job.pickup_lat, lng: job.pickup_lng };

  const p = params();
  const where = [`t.status = 'available'`];
  const vis = truckVisibilityClause(scope);
  if (vis) where.push(vis);

  // "The truck's leg passes near this pickup" as a box test: the leg's own
  // bounding box has to intersect a box drawn MAX_CORRIDOR_MILES around the
  // pickup. Cheap, index-shaped, and never tighter than the corridor gate.
  const reach = radiusBoundingBox(pickup, MAX_CORRIDOR_MILES);
  const legNear = `(
    t.dest_lat IS NOT NULL AND t.dest_lng IS NOT NULL
    AND least(t.origin_lat, t.dest_lat)    <= ${p.add(reach.maxLat)}
    AND greatest(t.origin_lat, t.dest_lat) >= ${p.add(reach.minLat)}
    AND least(t.origin_lng, t.dest_lng)    <= ${p.add(reach.maxLng)}
    AND greatest(t.origin_lng, t.dest_lng) >= ${p.add(reach.minLng)}
  )`;

  const near = [
    radiusClause(pickup, MAX_CORRIDOR_MILES + 25, p, "t.origin_lat", "t.origin_lng"),
    legNear,
  ];
  if (job.delivery_lat != null && job.delivery_lng != null) {
    near.push(
      radiusClause(
        { lat: job.delivery_lat, lng: job.delivery_lng },
        MAX_CORRIDOR_MILES + 25,
        p,
        "t.dest_lat",
        "t.dest_lng",
      ),
    );
  }
  where.push(`(${near.join("\n         OR ")})`);

  const demo = truckDemoVisibilitySql(audience, p);
  if (demo) where.push(demo);

  return query<MatchTruck>(
    `SELECT ${TRUCK_MATCH_COLUMNS}
       FROM trucks t
      WHERE ${where.join("\n        AND ")}
      ORDER BY t.last_seen_at DESC NULLS LAST, t.id
      LIMIT ${MATCH_CANDIDATE_CAP}`,
    p.values,
  );
}
