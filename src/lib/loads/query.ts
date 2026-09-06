/**
 * Job search.
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
 *
 * The summary is computed over the *full* WHERE, not the returned page: the
 * board's headline ("18 jobs · 6,450 cf ≈ 4.3 trucks") describes the whole
 * filtered set, and a driver deciding whether a lane is worth the trip is
 * reading that number, not the page size.
 */
import { params, query, queryOne } from "@/lib/db";
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
  LoadSummary,
} from "./types";

/** Ceiling on rows pulled into memory for corridor post-processing. */
const CORRIDOR_CANDIDATE_CAP = 3000;

/** How far off the driver's line a pickup may sit before it stops being "on the way". */
const DEFAULT_CORRIDOR_MILES = 75;

/** Open-ended size filters: a job is never excluded for being unusually small or large. */
const CF_FLOOR = -1;
const CF_CEILING = 1_000_000;

const SELECT_COLUMNS = `
  l.id, l.status, l.status_source,
  l.pickup_label, l.pickup_city, l.pickup_state, l.pickup_zip,
  l.pickup_lat, l.pickup_lng, l.pickup_precision,
  l.delivery_label, l.delivery_city, l.delivery_state, l.delivery_zip,
  l.delivery_lat, l.delivery_lng, l.delivery_precision,
  l.trip_miles,
  l.cubic_feet, l.price_per_cf, l.price_flat, l.rate_usd,
  l.ready_now,
  l.ready_date::text  AS ready_date,
  l.ready_source,
  l.deliver_by::text  AS deliver_by,
  coalesce(l.tags,  '{}') AS tags,
  coalesce(l.flags, '{}') AS flags,
  l.job_notes, l.line_text, l.requirements,
  l.sender_key, l.job_key, l.ordinal,
  l.contact_name, l.contact_phone, l.contact_mode,
  l.first_seen_at::text AS first_seen_at,
  l.last_seen_at::text  AS last_seen_at,
  l.seen_count, l.relist_count,
  l.delisted_at::text   AS delisted_at,
  l.snapshot_message_id,
  l.confidence, l.needs_review, l.dup_group_id, l.is_canonical,
  g.name AS group_name,
  l.source_message_id, l.posted_by,
  l.created_at::text  AS created_at,
  l.expires_at::text  AS expires_at,
  l.pickup_date::text   AS pickup_date,
  l.pickup_time::text   AS pickup_time,
  l.pickup_time_note,
  l.delivery_date::text AS delivery_date,
  l.weight_lbs, l.pieces, l.notes,
  -- Branch on the group rather than COALESCE: an ungrouped count(*) over an
  -- empty set is 0, never NULL, so a COALESCE(..., 1) fallback never fires and
  -- every job without a duplicate group would ship "0 postings" instead of 1.
  CASE WHEN l.dup_group_id IS NULL THEN 1
       ELSE (SELECT count(*) FROM loads d WHERE d.dup_group_id = l.dup_group_id)
  END AS dup_count`;

/** Per-cubic-foot price, in SQL: what a mover compares two jobs on. */
const PER_CF_SQL = `coalesce(l.price_per_cf, l.price_flat / nullif(l.cubic_feet, 0))`;

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

  // --- pickup / delivery attributes ----------------------------------------
  const pickupStates = expandStates(input.pickupStates);
  if (pickupStates.length) where.push(`l.pickup_state = ANY(${p.add(pickupStates)}::text[])`);
  const deliveryStates = expandStates(input.deliveryStates);
  if (deliveryStates.length) where.push(`l.delivery_state = ANY(${p.add(deliveryStates)}::text[])`);

  if (input.pickupCity) where.push(`lower(l.pickup_city) = lower(${p.add(input.pickupCity)})`);
  if (input.deliveryCity) where.push(`lower(l.delivery_city) = lower(${p.add(input.deliveryCity)})`);
  if (input.pickupZip) where.push(`l.pickup_zip LIKE ${p.add(zipPattern(input.pickupZip))}`);
  if (input.deliveryZip) where.push(`l.delivery_zip LIKE ${p.add(zipPattern(input.deliveryZip))}`);

  // --- size -----------------------------------------------------------------
  // A post that never stated a size is still a job. It stays in the results
  // unless the driver explicitly unchecks "include jobs without a size".
  if (input.minCf != null || input.maxCf != null) {
    const lo = p.add(input.minCf ?? CF_FLOOR);
    const hi = p.add(input.maxCf ?? CF_CEILING);
    where.push(
      input.includeUnsized === false
        ? `(l.cubic_feet IS NOT NULL AND l.cubic_feet BETWEEN ${lo} AND ${hi})`
        : `(l.cubic_feet IS NULL OR l.cubic_feet BETWEEN ${lo} AND ${hi})`,
    );
  } else if (input.includeUnsized === false) {
    where.push(`l.cubic_feet IS NOT NULL`);
  }

  // --- readiness / deadline / freshness -------------------------------------
  // `CURRENT_DATE` is the database process's own local date -- under PGlite
  // that is whatever zone the Node process happens to run in, neither UTC nor
  // the board's. Every other "today" (the chips, the corridor summary, the
  // client's `boardDay`) is computed in DEFAULT_TZ, so this one is too, bound
  // as a date rather than left to the server's clock.
  if (input.readyOnly) where.push(`(l.ready_now OR l.ready_date <= ${p.add(localToday())}::date)`);
  if (input.readyBy) where.push(`(l.ready_now OR l.ready_date <= ${p.add(input.readyBy)}::date)`);
  if (input.deliverBy) {
    where.push(`(l.deliver_by IS NULL OR l.deliver_by <= ${p.add(input.deliverBy)}::date)`);
  }
  if (input.seenDays != null) {
    const days = clamp(Math.round(input.seenDays), 1, 30);
    where.push(`l.last_seen_at > now() - (${p.add(String(days))} || ' days')::interval`);
  }

  if (input.hasPrice) where.push(`(l.price_per_cf IS NOT NULL OR l.price_flat IS NOT NULL)`);

  // The sender key is "phone:<E.164>" -- the author's own number. The query
  // builder honours it for admin and internal callers; B's public route strips
  // the `sender` key from the URL for everyone else, so summary.count can never
  // be used to confirm whose phone a number is.
  if (input.senderKey) where.push(`l.sender_key = ${p.add(input.senderKey)}`);

  if (input.q) {
    // Never contact_phone: a phone search would leak the number through the count.
    const like = p.add(`%${input.q.toLowerCase()}%`);
    where.push(`(
      lower(l.pickup_label || ' ' || l.delivery_label || ' ' ||
            coalesce(l.job_notes,'') || ' ' || coalesce(l.requirements,'') || ' ' ||
            array_to_string(coalesce(l.tags,'{}'),' ') || ' ' ||
            coalesce(l.contact_name,'')) LIKE ${like}
    )`);
  }

  // --- map viewport ---------------------------------------------------------
  // A route is on screen when either of its ends is: panning to Florida should
  // show the jobs arriving there, not only the ones leaving from there.
  if (input.bounds) where.push(eitherEndInBounds(input.bounds, p));

  const corridor =
    input.routeMode === "corridor" && input.origin && input.destination
      ? {
          origin: input.origin,
          destination: input.destination,
          miles: input.corridorMiles ?? DEFAULT_CORRIDOR_MILES,
        }
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
  // than the statement references, so the count and summary queries -- which
  // have no SELECT list to speak of -- must be given exactly this prefix.
  const whereValues = [...p.values];

  // --- distance column -----------------------------------------------------
  // An explicit origin outranks the viewer's own location: when someone
  // searches "pick up near Newark", the distances they want are from Newark.
  const reference = input.origin ?? input.viewer ?? null;
  let distanceExpr = "NULL::float8";
  if (reference) {
    const latP = p.add(reference.lat);
    const lngP = p.add(reference.lng);
    distanceExpr = distanceSql("l.pickup_lat", "l.pickup_lng", latP, lngP);
  }

  if (corridor) {
    return corridorSearch(input, corridor, fromSql, whereSql, distanceExpr, p);
  }

  const sortSql = orderBy(input.sort, Boolean(reference));
  const limit = pageLimit(input.limit);
  const offset = pageOffset(input.offset);

  const rows = await query<LoadRow>(
    `SELECT ${SELECT_COLUMNS}, ${distanceExpr} AS distance_miles
       ${fromSql}
       ${whereSql}
     ORDER BY ${sortSql}
     LIMIT ${p.add(limit)} OFFSET ${p.add(offset)}`,
    p.values,
  );

  const summary = await summarize(fromSql, whereSql, whereValues);

  return {
    rows,
    total: summary.count,
    summary,
    applied: {
      origin: input.origin ?? null,
      destination: input.destination ?? null,
      radiusMiles: input.radiusMiles ?? null,
      routeMode: "endpoints",
      readyBy: input.readyBy ?? null,
      deliverBy: input.deliverBy ?? null,
      // The headline counts the whole filtered set but the page stops at
      // `limit`, so the board needs to be told when the two disagree --
      // otherwise "742 jobs" sits above a list of 500 with nothing to explain
      // the other 242. Only the corridor branch used to set this.
      truncated: summary.count > offset + rows.length,
    },
  };
}

/** The board headline, over the whole filtered set rather than the page. */
async function summarize(
  fromSql: string,
  whereSql: string,
  whereValues: unknown[],
): Promise<LoadSummary> {
  // The board's calendar, not the database process's: the same date the chips
  // underneath this headline are measured against (see the readiness filter).
  const today = `$${whereValues.length + 1}`;
  const row = await queryOne<LoadSummary>(
    `SELECT count(*)::int AS "count",
            coalesce(sum(l.cubic_feet),0)::int AS "totalCf",
            count(l.cubic_feet)::int AS "withCf",
            count(*) FILTER (WHERE l.ready_now OR l.ready_date <= ${today}::date)::int AS "readyNow",
            count(*) FILTER (WHERE l.last_seen_at > now() - interval '24 hours')::int AS "freshToday",
            count(*) FILTER (WHERE l.price_per_cf IS NOT NULL OR l.price_flat IS NOT NULL)::int AS "priced",
            percentile_cont(0.5) WITHIN GROUP (ORDER BY ${PER_CF_SQL}::float8)
              FILTER (WHERE l.price_per_cf IS NOT NULL OR (l.price_flat IS NOT NULL AND l.cubic_feet > 0)) AS "medianPricePerCf"
       ${fromSql}
       ${whereSql}`,
    [...whereValues, localToday()],
  );
  return (
    row ?? {
      count: 0,
      totalCf: 0,
      withCf: 0,
      readyNow: 0,
      freshToday: 0,
      priced: 0,
      medianPricePerCf: null,
    }
  );
}

/**
 * Route matching, the thing a plain board cannot do.
 *
 * "I am in Miami and I want to end up back in New Jersey" should not only
 * return Miami -> New Jersey jobs. It should return anything whose pickup sits
 * near the line and whose delivery makes forward progress along it, ranked by
 * how far off the route the driver has to swing.
 */
async function corridorSearch(
  input: LoadSearchParams,
  corridor: { origin: GeoPoint; destination: GeoPoint; miles: number },
  fromSql: string,
  whereSql: string,
  distanceExpr: string,
  p: ReturnType<typeof params>,
): Promise<LoadSearchResult> {
  const candidates = await query<LoadRow>(
    `SELECT ${SELECT_COLUMNS}, ${distanceExpr} AS distance_miles
       ${fromSql}
       ${whereSql}
     ORDER BY l.last_seen_at DESC NULLS LAST, l.id DESC
     LIMIT ${p.add(CORRIDOR_CANDIDATE_CAP)}`,
    p.values,
  );

  const { origin, destination, miles } = corridor;
  const routeLength = haversineMiles(origin, destination);
  const scored: LoadRow[] = [];

  for (const row of candidates) {
    if (row.pickup_lat == null || row.pickup_lng == null) continue;
    // Both endpoints are required here. Without a delivery coordinate there is
    // no way to tell whether the job moves the driver toward home or straight
    // back the way they came, and "might be on your way" is not what this
    // search promises. Such jobs still appear in state and radius searches.
    if (row.delivery_lat == null || row.delivery_lng == null) continue;

    const pickup = { lat: row.pickup_lat, lng: row.pickup_lng };
    const delivery = { lat: row.delivery_lat, lng: row.delivery_lng };

    const offRoute = crossTrackMiles(pickup, origin, destination);
    if (offRoute > miles) continue;

    const pickupProgress = alongTrackFraction(pickup, origin, destination);
    const deliveryProgress = alongTrackFraction(delivery, origin, destination);

    const closerToDest =
      haversineMiles(delivery, destination) < haversineMiles(pickup, destination);
    if (deliveryProgress <= pickupProgress && !closerToDest) continue;

    // The delivery has to stay near the route too. Heading to New Jersey,
    // Miami -> Seattle technically makes "forward progress" (north) while
    // being nobody's idea of a job on the way.
    const deliveryOffRoute = crossTrackMiles(delivery, origin, destination);
    if (deliveryOffRoute > miles * 2) continue;

    // Cap total extra driving, scaled against the trip as well as the corridor
    // width: 150 extra miles is a rounding error coast to coast and a different
    // trip entirely on a 400-mile run.
    const detour = detourMiles(origin, destination, pickup, delivery);
    if (detour > Math.min(miles * 2, routeLength * 0.3)) continue;

    row.off_route_miles = Math.round(offRoute);
    row.route_progress = Number(pickupProgress.toFixed(3));
    row.detour_miles = Math.round(detour);
    scored.push(row);
  }

  // Best first: least extra driving, then freshest.
  scored.sort((a, b) => {
    const ad = a.detour_miles ?? Infinity;
    const bd = b.detour_miles ?? Infinity;
    if (ad !== bd) return ad - bd;
    return (b.last_seen_at ?? "").localeCompare(a.last_seen_at ?? "");
  });

  const limit = pageLimit(input.limit);
  const offset = pageOffset(input.offset);
  const rows = scored.slice(offset, offset + limit);

  return {
    rows,
    total: scored.length,
    // The corridor filter runs in JS, so the summary is folded from the same
    // scored set rather than re-run as SQL -- it still describes the whole
    // match, not the page.
    summary: summarizeRows(scored),
    applied: {
      origin,
      destination,
      corridorMiles: miles,
      routeMode: "corridor",
      readyBy: input.readyBy ?? null,
      deliverBy: input.deliverBy ?? null,
      // Two different ways matches go missing here: the candidate scan hit its
      // cap, or the scored set was longer than the page. The flag has to cover
      // both, or it fires on 12 matches and stays quiet when 700 are cut to 500.
      truncated: candidates.length >= CORRIDOR_CANDIDATE_CAP || scored.length > offset + rows.length,
    },
  };
}

/** The same summary as `summarize`, computed in JS for corridor mode. */
function summarizeRows(rows: LoadRow[]): LoadSummary {
  const today = localToday();
  const dayAgo = Date.now() - 24 * 3600_000;
  const perCf: number[] = [];
  let totalCf = 0;
  let withCf = 0;
  let readyNow = 0;
  let freshToday = 0;
  let priced = 0;

  for (const r of rows) {
    if (r.cubic_feet != null) {
      totalCf += r.cubic_feet;
      withCf++;
    }
    if (r.ready_now || (r.ready_date != null && r.ready_date <= today)) readyNow++;
    if (r.last_seen_at != null && new Date(r.last_seen_at).getTime() > dayAgo) freshToday++;
    if (r.price_per_cf != null || r.price_flat != null) {
      priced++;
      if (r.price_per_cf != null) perCf.push(r.price_per_cf);
      else if (r.price_flat != null && r.cubic_feet) perCf.push(r.price_flat / r.cubic_feet);
    }
  }

  perCf.sort((a, b) => a - b);
  const mid = perCf.length ? (perCf.length % 2
    ? perCf[(perCf.length - 1) / 2]
    : (perCf[perCf.length / 2 - 1] + perCf[perCf.length / 2]) / 2) : null;

  return {
    count: rows.length,
    totalCf,
    withCf,
    readyNow,
    freshToday,
    priced,
    medianPricePerCf: mid,
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

function eitherEndInBounds(b: BoundsInput, p: ReturnType<typeof params>): string {
  return `(${boundsClause(b, p, "l.pickup_lat", "l.pickup_lng")}
        OR ${boundsClause(b, p, "l.delivery_lat", "l.delivery_lng")})`;
}

function orderBy(sort: LoadSearchParams["sort"], hasDistance: boolean): string {
  switch (sort) {
    case "newest":
      return `l.first_seen_at DESC NULLS LAST, l.id DESC`;
    case "last_seen":
      return `l.last_seen_at DESC NULLS LAST, l.id DESC`;
    case "distance":
      return hasDistance ? `distance_miles ASC NULLS LAST, l.id DESC` : `l.id DESC`;
    case "trip_miles":
      return `l.trip_miles DESC NULLS LAST, l.id DESC`;
    case "rate":
      return `${PER_CF_SQL} DESC NULLS LAST, l.id DESC`;
    case "cf":
      return `l.cubic_feet DESC NULLS LAST, l.id DESC`;
    case "deliver_by":
      return `l.deliver_by ASC NULLS LAST, l.id DESC`;
    case "ready":
    default:
      return `l.ready_now DESC, l.last_seen_at DESC NULLS LAST, l.id DESC`;
  }
}

function zipPattern(zip: string): string {
  const digits = zip.replace(/\D/g, "").slice(0, 5);
  // Partial ZIPs are a legitimate filter: "070" means north Jersey.
  return digits.length === 5 ? digits : `${digits}%`;
}

/** Region tokens ("southeast", "tristate") expand into their member states. */
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

function localToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()); // en-CA yields YYYY-MM-DD
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/**
 * LIMIT and OFFSET are bound as bigints, so they have to be whole numbers with
 * a ceiling: `?limit=1.5` and `?offset=1e21` are both finite, and both make the
 * driver reject the statement -- a 500 with a raw database message where the
 * caller should simply have got the nearest sensible page.
 *
 * Exported because every paged query has the same problem: the admin message
 * feed pages its own table and needs the same rounding with a smaller ceiling.
 */
export function pageLimit(limit: number | undefined, max = 500): number {
  return Number.isFinite(limit) ? clamp(Math.round(limit!), 1, max) : Math.min(50, max);
}

export function pageOffset(offset: number | undefined): number {
  return Number.isFinite(offset) ? clamp(Math.round(offset!), 0, 100_000) : 0;
}

/** Single job with its duplicate siblings and source message. */
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
      ORDER BY l.last_seen_at DESC NULLS LAST, l.id DESC`,
    [load.dup_group_id, load.id],
  );
}
