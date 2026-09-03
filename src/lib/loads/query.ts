/**
 * Load search.
 *
 * All filtering is one parameterized SQL statement, with two exceptions that
 * are documented inline: route-corridor matching and detour scoring are done
 * in JS over a bounding-box-limited candidate set, because the cross-track
 * math is unpleasant in portable SQL and corridor searches are naturally
 * narrow.
 *
 * Radius search pattern: bounding-box prefilter (served by the (lat,lng) btree
 * indexes) AND exact haversine. The box alone would return corner
 * false-positives; the haversine alone would table-scan.
 */
import { params, query } from "@/lib/db";
import { DEFAULT_TZ } from "@/lib/extract/dates";
import {
  alongTrackFraction,
  crossTrackMiles,
  detourMiles,
  haversineMiles,
  radiusBoundingBox,
  unionBoundingBox,
} from "@/lib/geo/math";
import { REGIONS } from "@/lib/geo/states";
import type {
  BoundsInput,
  GeoPoint,
  LoadRow,
  LoadSearchParams,
  LoadSearchResult,
} from "./types";

/** Ceiling on rows pulled into memory for corridor post-processing. */
const CORRIDOR_CANDIDATE_CAP = 3000;

/** How far off the driver's line a pickup may sit before it stops being "on the way". */
const DEFAULT_CORRIDOR_MILES = 75;

const SELECT_COLUMNS = `
  l.id, l.status,
  l.pickup_label, l.pickup_city, l.pickup_state, l.pickup_zip,
  l.pickup_lat, l.pickup_lng, l.pickup_precision,
  l.delivery_label, l.delivery_city, l.delivery_state, l.delivery_zip,
  l.delivery_lat, l.delivery_lng, l.delivery_precision,
  l.trip_miles,
  l.pickup_date::text   AS pickup_date,
  l.pickup_time::text   AS pickup_time,
  l.pickup_time_note,
  l.delivery_date::text AS delivery_date,
  l.load_type, l.weight_lbs, l.pallets, l.pieces, l.rate_usd,
  l.contact_name, l.contact_phone, l.notes,
  l.confidence, l.needs_review, l.dup_group_id, l.is_canonical,
  l.source_message_id,
  l.created_at::text AS created_at,
  l.expires_at::text AS expires_at,
  g.name AS group_name,
  COALESCE((
    SELECT count(*) FROM loads d
     WHERE d.dup_group_id = l.dup_group_id AND l.dup_group_id IS NOT NULL
  ), 1) AS dup_count`;

/** Haversine in SQL. `latCol`/`lngCol` are column refs, never user input. */
function distanceSql(latCol: string, lngCol: string, latP: string, lngP: string): string {
  return `(3958.7613 * 2 * asin(least(1, sqrt(
    power(sin(radians(${latP}::float8 - ${latCol}) / 2), 2) +
    cos(radians(${latCol})) * cos(radians(${latP}::float8)) *
    power(sin(radians(${lngP}::float8 - ${lngCol}) / 2), 2)
  ))))`;
}

export async function searchLoads(input: LoadSearchParams): Promise<LoadSearchResult> {
  const p = params();
  const where: string[] = [];

  // --- status ---------------------------------------------------------------
  const statuses = input.statuses?.length ? input.statuses : ["available"];
  where.push(`l.status = ANY(${p.add(statuses)}::text[])`);

  if (!input.includeDuplicates) where.push(`l.is_canonical = true`);
  if (input.needsReviewOnly) where.push(`l.needs_review = true`);

  // --- dates ----------------------------------------------------------------
  const { from, to } = resolveDateWindow(input);
  if (from && to) {
    where.push(`l.pickup_date >= ${p.add(from)}::date`);
    where.push(`l.pickup_date <= ${p.add(to)}::date`);
  } else if (from) {
    // An open-ended window keeps undated posts in play. Those are often the
    // most urgent ones ("need a truck now"), and dropping them for having no
    // parseable date would be exactly the wrong filter.
    where.push(
      `(l.pickup_date >= ${p.add(from)}::date
        OR (l.pickup_date IS NULL AND l.created_at >= now() - interval '2 days'))`,
    );
  } else if (to) {
    where.push(`l.pickup_date <= ${p.add(to)}::date`);
  }

  // --- pickup / delivery attributes ----------------------------------------
  const pickupStates = expandStates(input.pickupStates);
  if (pickupStates.length) where.push(`l.pickup_state = ANY(${p.add(pickupStates)}::text[])`);
  const deliveryStates = expandStates(input.deliveryStates);
  if (deliveryStates.length) where.push(`l.delivery_state = ANY(${p.add(deliveryStates)}::text[])`);

  if (input.pickupCity) where.push(`lower(l.pickup_city) = lower(${p.add(input.pickupCity)})`);
  if (input.deliveryCity) where.push(`lower(l.delivery_city) = lower(${p.add(input.deliveryCity)})`);
  if (input.pickupZip) where.push(`l.pickup_zip LIKE ${p.add(zipPattern(input.pickupZip))}`);
  if (input.deliveryZip) where.push(`l.delivery_zip LIKE ${p.add(zipPattern(input.deliveryZip))}`);

  if (input.loadTypes?.length) where.push(`l.load_type = ANY(${p.add(input.loadTypes)}::text[])`);
  if (input.minWeight != null) where.push(`l.weight_lbs >= ${p.add(input.minWeight)}`);
  if (input.maxWeight != null) where.push(`l.weight_lbs <= ${p.add(input.maxWeight)}`);

  if (input.q) {
    const like = p.add(`%${input.q.toLowerCase()}%`);
    where.push(`(
      lower(l.pickup_label) LIKE ${like} OR lower(l.delivery_label) LIKE ${like} OR
      lower(coalesce(l.contact_name,'')) LIKE ${like} OR
      lower(coalesce(l.notes,'')) LIKE ${like} OR
      lower(coalesce(l.load_type,'')) LIKE ${like}
    )`);
  }

  // --- map viewport ---------------------------------------------------------
  if (input.bounds) where.push(boundsClause(input.bounds, p, "l.pickup_lat", "l.pickup_lng"));

  const corridor =
    input.routeMode === "corridor" && input.origin && input.destination
      ? { origin: input.origin, destination: input.destination, miles: input.corridorMiles ?? DEFAULT_CORRIDOR_MILES }
      : null;

  // --- radius filters -------------------------------------------------------
  // In corridor mode the origin/destination describe the driver's route, not
  // two independent radius constraints, so the endpoint filters are skipped.
  if (!corridor) {
    if (input.origin && input.radiusMiles) {
      where.push(radiusClause(input.origin, input.radiusMiles, p, "l.pickup_lat", "l.pickup_lng"));
    }
    if (input.destination && input.destRadiusMiles) {
      where.push(
        radiusClause(input.destination, input.destRadiusMiles, p, "l.delivery_lat", "l.delivery_lng"),
      );
    }
  } else {
    // Cheap prefilter: pickups must at least fall inside the route's padded box.
    const box = unionBoundingBox([
      radiusBoundingBox(corridor.origin, corridor.miles),
      radiusBoundingBox(corridor.destination, corridor.miles),
    ]);
    where.push(boundsClause(box, p, "l.pickup_lat", "l.pickup_lng"));
    where.push(`l.pickup_lat IS NOT NULL`);
  }

  const whereSql = where.length ? `WHERE ${where.join("\n  AND ")}` : "";
  const fromSql = `FROM loads l LEFT JOIN whatsapp_groups g ON g.id = l.group_id`;

  // Snapshot the bind values the WHERE clause needs, before adding any that
  // only the SELECT list uses. Postgres rejects a bind with more parameters
  // than the statement references, so the count query -- which has no SELECT
  // list to speak of -- must be given exactly this prefix and no more.
  const whereValues = [...p.values];

  // --- distance column -----------------------------------------------------
  // An explicit origin outranks the saved home base: when someone searches
  // "pick up near Newark", the distances they want to see are from Newark, not
  // from wherever their profile happens to say they live.
  const reference = input.origin ?? input.viewer ?? null;
  let distanceExpr = "NULL::float8";
  if (reference) {
    const latP = p.add(reference.lat);
    const lngP = p.add(reference.lng);
    distanceExpr = distanceSql("l.pickup_lat", "l.pickup_lng", latP, lngP);
  }

  if (corridor) {
    return corridorSearch(input, corridor, fromSql, whereSql, distanceExpr, p, from, to);
  }

  const sortSql = orderBy(input.sort, Boolean(reference));
  const limit = clamp(input.limit ?? 50, 1, 200);
  const offset = Math.max(input.offset ?? 0, 0);

  const rows = await query<LoadRow>(
    `SELECT ${SELECT_COLUMNS}, ${distanceExpr} AS distance_miles
       ${fromSql}
       ${whereSql}
     ORDER BY ${sortSql}
     LIMIT ${p.add(limit)} OFFSET ${p.add(offset)}`,
    p.values,
  );

  const countRows = await query<{ n: number }>(
    `SELECT count(*)::int AS n ${fromSql} ${whereSql}`,
    whereValues,
  );

  return {
    rows,
    total: countRows[0]?.n ?? rows.length,
    applied: {
      origin: input.origin ?? null,
      destination: input.destination ?? null,
      radiusMiles: input.radiusMiles ?? null,
      routeMode: "endpoints",
      dateFrom: from,
      dateTo: to,
    },
  };
}

/**
 * Route matching, the thing a plain load board cannot do.
 *
 * "I'll be in Philadelphia tomorrow and I want to end up in Georgia" should not
 * only return Philadelphia -> Georgia loads. It should return anything whose
 * pickup sits near the Philadelphia -> Georgia line and whose delivery makes
 * forward progress along it, ranked by how far off the route the driver has to
 * swing. Charlotte -> Atlanta belongs in that answer.
 */
async function corridorSearch(
  input: LoadSearchParams,
  corridor: { origin: GeoPoint; destination: GeoPoint; miles: number },
  fromSql: string,
  whereSql: string,
  distanceExpr: string,
  p: ReturnType<typeof params>,
  from: string | null,
  to: string | null,
): Promise<LoadSearchResult> {
  const candidates = await query<LoadRow>(
    `SELECT ${SELECT_COLUMNS}, ${distanceExpr} AS distance_miles
       ${fromSql}
       ${whereSql}
     ORDER BY l.pickup_date NULLS LAST, l.id DESC
     LIMIT ${p.add(CORRIDOR_CANDIDATE_CAP)}`,
    p.values,
  );

  const { origin, destination, miles } = corridor;
  const routeLength = haversineMiles(origin, destination);
  const scored: LoadRow[] = [];

  for (const row of candidates) {
    if (row.pickup_lat == null || row.pickup_lng == null) continue;
    // Both endpoints are required here. Without a delivery coordinate there is
    // no way to tell whether the load moves the driver toward the destination
    // or straight back the way they came, and "might be on your way" is not
    // what this search promises. Such loads still appear in radius and state
    // searches; they are only excluded from corridor matching.
    if (row.delivery_lat == null || row.delivery_lng == null) continue;

    const pickup = { lat: row.pickup_lat, lng: row.pickup_lng };
    const delivery = { lat: row.delivery_lat, lng: row.delivery_lng };

    const offRoute = crossTrackMiles(pickup, origin, destination);
    if (offRoute > miles) continue;

    const pickupProgress = alongTrackFraction(pickup, origin, destination);
    const deliveryProgress = alongTrackFraction(delivery, origin, destination);

    // Forward progress: the delivery must land further along the route than the
    // pickup, or at least end up closer to where the driver is going.
    const closerToDest =
      haversineMiles(delivery, destination) < haversineMiles(pickup, destination);
    if (deliveryProgress <= pickupProgress && !closerToDest) continue;

    // The delivery has to stay near the route too. Heading to Atlanta,
    // Philadelphia -> Miami technically makes "forward progress" (Miami is
    // south) while being nobody's idea of a load on the way. Allowing the
    // delivery to sit twice as far off the line as the pickup leaves room for
    // genuinely coastal lanes without admitting the whole southeast.
    const deliveryOffRoute = crossTrackMiles(delivery, origin, destination);
    if (deliveryOffRoute > miles * 2) continue;

    // Cap total extra driving. Scaled against the trip as well as the corridor
    // width: 150 extra miles is a rounding error on a coast-to-coast run and a
    // different trip entirely on a 400-mile one. This is what rejects loads
    // whose pickup sits behind the driver -- backtracking to a pickup north of
    // the origin shows up here as a large detour even when the pickup is
    // technically within the corridor.
    const detour = detourMiles(origin, destination, pickup, delivery);
    if (detour > Math.min(miles * 2, routeLength * 0.3)) continue;

    row.off_route_miles = Math.round(offRoute);
    row.route_progress = Number(pickupProgress.toFixed(3));
    row.detour_miles = Math.round(detour);
    scored.push(row);
  }

  // Best first: least extra driving, then earliest pickup.
  scored.sort((a, b) => {
    const ad = a.detour_miles ?? Infinity;
    const bd = b.detour_miles ?? Infinity;
    if (ad !== bd) return ad - bd;
    return (a.pickup_date ?? "9999").localeCompare(b.pickup_date ?? "9999");
  });

  const limit = clamp(input.limit ?? 50, 1, 200);
  const offset = Math.max(input.offset ?? 0, 0);

  return {
    rows: scored.slice(offset, offset + limit),
    total: scored.length,
    applied: {
      origin,
      destination,
      corridorMiles: miles,
      routeMode: "corridor",
      dateFrom: from,
      dateTo: to,
      truncated: candidates.length >= CORRIDOR_CANDIDATE_CAP,
    },
  };
}

// --- fragment builders -------------------------------------------------------

function radiusClause(
  center: GeoPoint,
  miles: number,
  p: ReturnType<typeof params>,
  latCol: string,
  lngCol: string,
): string {
  const box = radiusBoundingBox(center, miles);
  const latP = p.add(center.lat);
  const lngP = p.add(center.lng);
  return `(
    ${latCol} BETWEEN ${p.add(box.minLat)} AND ${p.add(box.maxLat)}
    AND ${lngCol} BETWEEN ${p.add(box.minLng)} AND ${p.add(box.maxLng)}
    AND ${distanceSql(latCol, lngCol, latP, lngP)} <= ${p.add(miles)}
  )`;
}

function boundsClause(
  b: BoundsInput,
  p: ReturnType<typeof params>,
  latCol: string,
  lngCol: string,
): string {
  return `(${latCol} BETWEEN ${p.add(b.minLat)} AND ${p.add(b.maxLat)}
       AND ${lngCol} BETWEEN ${p.add(b.minLng)} AND ${p.add(b.maxLng)})`;
}

function orderBy(sort: LoadSearchParams["sort"], hasDistance: boolean): string {
  switch (sort) {
    case "pickup_date":
      return `l.pickup_date ASC NULLS LAST, l.id DESC`;
    case "distance":
      return hasDistance ? `distance_miles ASC NULLS LAST, l.id DESC` : `l.id DESC`;
    case "trip_miles":
      return `l.trip_miles DESC NULLS LAST, l.id DESC`;
    case "rate":
      return `l.rate_usd DESC NULLS LAST, l.id DESC`;
    case "newest":
    default:
      return `l.created_at DESC, l.id DESC`;
  }
}

function zipPattern(zip: string): string {
  const digits = zip.replace(/\D/g, "").slice(0, 5);
  // Partial ZIPs are a legitimate freight filter: "070" means north Jersey.
  return digits.length === 5 ? digits : `${digits}%`;
}

/** Region tokens ("northeast") expand into their member states. */
function expandStates(input: string[] | undefined): string[] {
  if (!input?.length) return [];
  const out = new Set<string>();
  for (const raw of input) {
    const token = raw.trim();
    if (!token) continue;
    const region = REGIONS[token.toLowerCase().replace(/[\s-]/g, "")];
    if (region) region.states.forEach((s) => out.add(s));
    else out.add(token.toUpperCase().slice(0, 2));
  }
  return [...out];
}

function resolveDateWindow(input: LoadSearchParams): { from: string | null; to: string | null } {
  const preset = input.datePreset ?? "any";
  if (preset === "custom" || (!preset && (input.dateFrom || input.dateTo))) {
    return { from: input.dateFrom ?? null, to: input.dateTo ?? null };
  }
  const today = localToday();
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "tomorrow": {
      const t = shift(today, 1);
      return { from: t, to: t };
    }
    case "next3":
      return { from: today, to: shift(today, 2) };
    case "week":
      return { from: today, to: shift(today, 6) };
    default:
      return { from: input.dateFrom ?? null, to: input.dateTo ?? null };
  }
}

function localToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return parts; // en-CA yields YYYY-MM-DD
}

function shift(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** Single load with its duplicate siblings and source message. */
export async function getLoad(id: number): Promise<LoadRow | null> {
  const rows = await query<LoadRow>(
    `SELECT ${SELECT_COLUMNS}, NULL::float8 AS distance_miles
       FROM loads l LEFT JOIN whatsapp_groups g ON g.id = l.group_id
      WHERE l.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function getDuplicates(load: LoadRow): Promise<LoadRow[]> {
  if (!load.dup_group_id) return [];
  return query<LoadRow>(
    `SELECT ${SELECT_COLUMNS}, NULL::float8 AS distance_miles
       FROM loads l LEFT JOIN whatsapp_groups g ON g.id = l.group_id
      WHERE l.dup_group_id = $1 AND l.id <> $2
      ORDER BY l.created_at DESC`,
    [load.dup_group_id, load.id],
  );
}
