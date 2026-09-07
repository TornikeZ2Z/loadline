/**
 * Truck search -- the second board.
 *
 * Structurally a sibling of `searchLoads`, and deliberately not a generalisation
 * of it. `loads`, `searchLoads` and `GET /api/loads` are untouched by this
 * feature: not one predicate, not one column, not one line of SQL (SPEC §0).
 * What that buys is an invariant instead of a rule someone has to remember --
 * `rebuildSender`'s `UPDATE loads ... WHERE sender_key = $1` cannot reach a
 * truck, `getLoad` cannot return one, and `coalesce(sum(l.cubic_feet),0)` cannot
 * accidentally count free space as freight.
 *
 * The geography and paging fragments come from `./sql`, shared with the job
 * board: "within 50 miles of Newark", "inside the viewport" and "070 means
 * north Jersey" are the same questions for both, and answering them twice is how
 * two boards start disagreeing about where Newark is. What is NOT shared is
 * everything that names a quantity -- the select list, the summary, the sort --
 * written here with the job-only predicates DELETED rather than adapted. A
 * shared `orderBy` with a `cf` case is how `free_cf` ends up sorted on the
 * freight scale.
 *
 * TWO independent visibility predicates, both pinned in SQL:
 *
 *   scope     -- "is this row fit to be seen by the public at all?"  REQUIRED
 *                and positional, so you cannot read a truck without deciding.
 *                `visibility` is never a query key; a pending row is not a
 *                board filter away, it is unreachable.
 *   audience  -- "whose demo scratch work is this?"  Optional, and omitting it
 *                means anonymous, so forgetting it costs rows and never leaks.
 */
import { params, query, queryOne } from "@/lib/db";
import { DEFAULT_TZ } from "@/lib/extract/dates";
import { radiusBoundingBox, unionBoundingBox } from "@/lib/geo/math";
import { corridorFit } from "@/lib/match/corridor";
import {
  boundsClause,
  clamp,
  distanceSql,
  expandStates,
  pageLimit,
  pageOffset,
  radiusClause,
  zipPattern,
} from "./sql";
import type { BoundsInput, GeoPoint } from "./types";
import type {
  TruckAudience,
  TruckRow,
  TruckSearchParams,
  TruckSearchResult,
  TruckSummary,
} from "./truckTypes";

/**
 * Who is asking to be served: the public board, or an admin console that is
 * allowed to see rows nobody has approved yet.
 *
 * A required positional argument rather than a field on `TruckSearchParams`,
 * and rather than a defaulted parameter. `TruckSearchParams` is built out of a
 * URL; a visibility axis that could be typed into a query string would gate
 * nothing. And a default would mean a new call site inherits the safe answer
 * silently -- here, forgetting it does not compile.
 */
export type TruckScope = "public" | "admin";

/** Ceiling on rows pulled into memory for corridor post-processing. */
const CORRIDOR_CANDIDATE_CAP = 3000;

/** How far off the driver's line a truck may sit before it stops being "on the way". */
const DEFAULT_CORRIDOR_MILES = 75;

/** Open-ended size filters: a truck is never excluded for being unusually small or large. */
const FREE_CF_FLOOR = -1;
const FREE_CF_CEILING = 1_000_000;

/**
 * `contact_phone_raw` is absent, exactly as it is from the job board's
 * SELECT_COLUMNS: a column that never enters a row shape cannot enter a
 * response body. npm run check:redact asserts it, by scanning the table's
 * columns rather than by trusting this comment.
 */
const TRUCK_SELECT_COLUMNS = `
  t.id, t.status, t.status_source, t.visibility,
  t.source_message_id, t.group_id, t.posted_by, t.sender_key, t.truck_key,
  t.origin_label, t.origin_city, t.origin_state, t.origin_zip,
  t.origin_lat, t.origin_lng, t.origin_precision,
  t.dest_label, t.dest_city, t.dest_state, t.dest_zip,
  t.dest_lat, t.dest_lng, t.dest_precision,
  t.leg_miles, t.road_miles, t.road_minutes,
  t.free_cf, t.truck_cf, t.free_source, t.truck_text,
  t.avail_now,
  t.avail_from::text AS avail_from,
  t.avail_to::text   AS avail_to,
  t.avail_source,
  t.corridor_miles,
  t.has_dot_mc, t.has_hhg_authority, t.has_coi,
  coalesce(t.equipment, '{}') AS equipment,
  coalesce(t.cannot,    '{}') AS cannot,
  t.equipment_notes, t.requirements, t.notes,
  t.contact_name, t.contact_phone, t.contact_mode, t.contact_phone_source,
  t.line_text, t.supply_phrase, t.shape,
  t.confidence, t.needs_review,
  coalesce(t.flags, '{}') AS flags,
  t.first_seen_at::text AS first_seen_at,
  t.last_seen_at::text  AS last_seen_at,
  t.seen_count,
  t.expires_at::text AS expires_at,
  t.created_at::text AS created_at,
  t.updated_at::text AS updated_at,
  t.is_demo,
  g.name AS group_name`;

const TRUCK_FROM_SQL = `FROM trucks t LEFT JOIN whatsapp_groups g ON g.id = t.group_id`;

/**
 * The quarantine, pinned in SQL and written unconditionally.
 *
 * This is the direct answer to the defect that sank the one-table design:
 * `getLoad(id)` has no status predicate, so under one table an unreviewed row
 * was reachable by incrementing a bigserial and `POST /api/loads/:id/contact`
 * would hand out its phone. Here every read states a scope, and every public
 * scope ANDs this clause before anything else.
 *
 * `admin` returns null: an admin console sees the queue, which is its whole
 * purpose. Only an admin-guarded handler can produce that argument.
 */
function visibilityClause(scope: TruckScope): string | null {
  return scope === "public" ? `t.visibility = 'public'` : null;
}

/**
 * The demo predicate, for trucks.
 *
 * A sibling of `demoVisibilitySql` in ./query.ts rather than a shared fragment,
 * for the same reason the select list and the summary are siblings: the job
 * query path is frozen for this feature, and lifting a predicate out of
 * `searchLoads` would be a change to `searchLoads`. The cost of the copy is
 * drift, and the answer to it is a gate rather than a comment --
 * npm run check:demo runs the SAME audience matrix against both tables and
 * fails if the two ever answer differently.
 *
 * Read it as: a row nobody posted from the demo is everybody's; a row posted
 * from the demo belongs to the account that posted it and to nobody else.
 * `null` for `userId` needs no special case -- `t.posted_by = NULL` is NULL,
 * `false OR NULL` is NULL, and a NULL WHERE clause excludes the row.
 */
function demoVisibilitySql(
  audience: TruckAudience | null | undefined,
  p: ReturnType<typeof params>,
): string | null {
  if (audience?.includeDemo) return null;
  const viewer = audience?.userId ?? null;
  if (viewer == null) return `t.is_demo = false`;
  return `(t.is_demo = false OR t.posted_by = ${p.add(viewer)})`;
}

/**
 * Does this truck exist FOR THIS CALLER?
 *
 * For the paths that hold an id and never load a row -- the road geometry, the
 * status PATCH -- so they can answer 404 rather than serve, or admit to, a
 * listing that is not theirs. One primary-key lookup, both predicates applied.
 */
export async function isTruckVisible(
  id: number,
  scope: TruckScope,
  audience?: TruckAudience | null,
): Promise<boolean> {
  const p = params();
  const idP = p.add(id);
  const where = [`t.id = ${idP}`];
  const vis = visibilityClause(scope);
  if (vis) where.push(vis);
  const demo = demoVisibilitySql(audience, p);
  if (demo) where.push(demo);
  const row = await queryOne<{ ok: number }>(
    `SELECT 1 AS ok FROM trucks t WHERE ${where.join("\n        AND ")}`,
    p.values,
  );
  return row != null;
}

/**
 * Who posted this truck, and what state it is in -- for the owner-guarded
 * writes.
 *
 * It exists so that PATCH /api/trucks/:id and its /status sibling never write
 * `FROM trucks` themselves. `npm run check:demo` refuses a hand-written truck
 * query in any handler a non-admin can reach, with no exemption table, and that
 * absolute rule is worth more than the six lines it costs here: a hand-written
 * ownership read is exactly the shape that forgets the scope, and then a 403
 * rather than a 404 tells a stranger that a pending truck exists.
 *
 * Returns null for a row this caller may not see, so the caller answers 404
 * before it has anything to answer 403 about.
 */
export async function truckOwner(
  id: number,
  scope: TruckScope,
  audience?: TruckAudience | null,
): Promise<{ id: number; posted_by: number | null; status: string } | null> {
  const p = params();
  const where = [`t.id = ${p.add(id)}`];
  const vis = visibilityClause(scope);
  if (vis) where.push(vis);
  const demo = demoVisibilitySql(audience, p);
  if (demo) where.push(demo);
  return queryOne<{ id: number; posted_by: number | null; status: string }>(
    `SELECT t.id, t.posted_by, t.status FROM trucks t WHERE ${where.join(" AND ")}`,
    p.values,
  );
}

/**
 * The truck board.
 *
 * Predicates that exist for jobs and are ABSENT here, deliberately:
 * `hasPrice` (a truck carries no price in v1), `deliverBy`, `readyOnly`,
 * `readyBy` (a truck departs, it is not ready), `minCf`/`maxCf` (freight
 * volume, not free space), `tags`, `dupes` and `includeDuplicates`. A URL
 * copied from the job board fails loudly in `parseTruckSearchParams` rather
 * than quietly returning an unfiltered truck board.
 */
export async function searchTrucks(
  scope: TruckScope,
  input: TruckSearchParams,
  audience?: TruckAudience | null,
): Promise<TruckSearchResult> {
  const p = params();
  const where: string[] = [];

  // --- may this row be seen at all -----------------------------------------
  // First, and written unconditionally, so it is the one clause no later branch
  // can drop: the corridor branch below rewrites the endpoint filters, and both
  // of these must survive that.
  const vis = visibilityClause(scope);
  if (vis) where.push(vis);
  const demo = demoVisibilitySql(audience, p);
  if (demo) where.push(demo);

  // --- status ---------------------------------------------------------------
  const statuses = input.statuses?.length ? input.statuses : ["available"];
  where.push(`t.status = ANY(${p.add(statuses)}::text[])`);

  if (input.needsReviewOnly) where.push(`t.needs_review = true`);

  // --- where it is, where it is going --------------------------------------
  // The DESTINATION-side predicates are collected separately, and that is not
  // tidiness. Every one of them is `dest_<x> = <y>`, which is NULL -- and so
  // not true -- for a truck whose post never said where it is headed. "Trucks
  // heading to FL" therefore removes rows a driver can see on the map, and the
  // only honest board is one that says how many. `where` plus `destWhere` is
  // the real filter; `where` alone is what that count is measured against.
  const destWhere: string[] = [];

  const originStates = expandStates(input.originStates);
  if (originStates.length) where.push(`t.origin_state = ANY(${p.add(originStates)}::text[])`);
  const destStates = expandStates(input.destStates);
  if (destStates.length) destWhere.push(`t.dest_state = ANY(${p.add(destStates)}::text[])`);

  if (input.originCity) where.push(`lower(t.origin_city) = lower(${p.add(input.originCity)})`);
  if (input.destCity) destWhere.push(`lower(t.dest_city) = lower(${p.add(input.destCity)})`);
  if (input.originZip) where.push(`t.origin_zip LIKE ${p.add(zipPattern(input.originZip))}`);
  if (input.destZip) destWhere.push(`t.dest_zip LIKE ${p.add(zipPattern(input.destZip))}`);

  // "Only trucks whose post never said where they are headed". The map cannot
  // draw such a truck on the Deliveries view and the matcher cannot promise it
  // is going anywhere, so it is a state a driver may want to look at directly.
  if (input.noDestOnly) where.push(`t.dest_lat IS NULL`);

  // --- free space -----------------------------------------------------------
  // NOT the job board's size filter, and never mapped onto it: "jobs over
  // 600 cf" and "trucks with 600 cf free" are different questions. A post that
  // never stated a free size is still a truck; it stays in the results unless
  // the driver explicitly unchecks "include trucks without a stated size".
  if (input.minFreeCf != null || input.maxFreeCf != null) {
    const lo = p.add(input.minFreeCf ?? FREE_CF_FLOOR);
    const hi = p.add(input.maxFreeCf ?? FREE_CF_CEILING);
    where.push(
      input.includeUnsized === false
        ? `(t.free_cf IS NOT NULL AND t.free_cf BETWEEN ${lo} AND ${hi})`
        : `(t.free_cf IS NULL OR t.free_cf BETWEEN ${lo} AND ${hi})`,
    );
  } else if (input.includeUnsized === false) {
    where.push(`t.free_cf IS NOT NULL`);
  }

  // --- when it leaves -------------------------------------------------------
  // A truck with no stated date is never hidden by a date filter: unknown is
  // printed as unknown, not treated as "leaves after your window".
  if (input.departsBy) {
    where.push(`(t.avail_now OR t.avail_from IS NULL OR t.avail_from <= ${p.add(input.departsBy)}::date)`);
  }
  if (input.seenDays != null) {
    const days = clamp(Math.round(input.seenDays), 1, 30);
    where.push(`t.last_seen_at > now() - (${p.add(String(days))} || ' days')::interval`);
  }

  // The sender key is "phone:<E.164>" -- the driver's own number. Only an
  // admin-guarded caller may set it; the public route strips the key from the
  // URL, so summary.count can never be used to confirm whose phone a number is.
  if (input.senderKey) where.push(`t.sender_key = ${p.add(input.senderKey)}`);

  if (input.q) {
    // Never contact_phone: a phone search would leak the number through the count.
    const like = p.add(`%${input.q.toLowerCase()}%`);
    where.push(`(
      lower(t.origin_label || ' ' || coalesce(t.dest_label,'') || ' ' ||
            coalesce(t.notes,'') || ' ' || coalesce(t.truck_text,'') || ' ' ||
            coalesce(t.equipment_notes,'') || ' ' ||
            array_to_string(coalesce(t.equipment,'{}'),' ') || ' ' ||
            coalesce(t.contact_name,'')) LIKE ${like}
    )`);
  }

  // --- map viewport ---------------------------------------------------------
  // A truck is on screen when either end of its leg is. A truck with no stated
  // destination has only one end, and `(origin IN BOUNDS OR NULL)` keeps it
  // when its origin is on screen and drops it when it is not -- which is the
  // honest answer for a listing that names one place.
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
  // In corridor mode the origin/destination describe the searcher's route, not
  // two independent radius constraints, so the endpoint filters are skipped.
  if (!corridor) {
    if (input.origin && input.radiusMiles) {
      where.push(radiusClause(input.origin, input.radiusMiles, p, "t.origin_lat", "t.origin_lng"));
    }
    if (input.destination && input.destRadiusMiles) {
      destWhere.push(
        radiusClause(input.destination, input.destRadiusMiles, p, "t.dest_lat", "t.dest_lng"),
      );
    }
  } else {
    // Cheap prefilter: a truck must at least start inside the route's padded box.
    const box = unionBoundingBox([
      radiusBoundingBox(corridor.origin, corridor.miles),
      radiusBoundingBox(corridor.destination, corridor.miles),
    ]);
    where.push(boundsClause(box, p, "t.origin_lat", "t.origin_lng"));
  }

  const allWhere = [...where, ...destWhere];
  const whereSql = allWhere.length ? `WHERE ${allWhere.join("\n  AND ")}` : "";

  // Snapshot the bind values the WHERE clause needs, before adding any that only
  // the SELECT list uses: Postgres rejects a bind with more parameters than the
  // statement references, and the summary query has no SELECT list to speak of.
  const whereValues = [...p.values];

  // How many trucks this destination filter is hiding purely for having no
  // stated destination. Asked only when there IS such a filter, and only
  // outside corridor mode, which counts its own exclusions in JS below.
  const noDestHidden =
    destWhere.length && !corridor ? await countNoDestination(where, destWhere, whereValues) : 0;

  // --- distance column ------------------------------------------------------
  // An explicit origin outranks the viewer's own location, and it is measured to
  // where the truck WILL BE EMPTY, which is the only end a dispatcher can meet.
  const reference = input.origin ?? input.viewer ?? null;
  let distanceExpr = "NULL::float8";
  if (reference) {
    const latP = p.add(reference.lat);
    const lngP = p.add(reference.lng);
    distanceExpr = distanceSql("t.origin_lat", "t.origin_lng", latP, lngP);
  }

  if (corridor) {
    return corridorSearch(input, corridor, whereSql, distanceExpr, p);
  }

  const sortSql = orderBy(input.sort, Boolean(reference));
  const limit = pageLimit(input.limit);
  const offset = pageOffset(input.offset);

  const rows = await query<TruckRow>(
    `SELECT ${TRUCK_SELECT_COLUMNS}, ${distanceExpr} AS distance_miles
       ${TRUCK_FROM_SQL}
       ${whereSql}
     ORDER BY ${sortSql}
     LIMIT ${p.add(limit)} OFFSET ${p.add(offset)}`,
    p.values,
  );

  const summary = await summarize(whereSql, whereValues);

  return {
    rows,
    total: summary.count,
    summary,
    applied: {
      origin: input.origin ?? null,
      destination: input.destination ?? null,
      radiusMiles: input.radiusMiles ?? null,
      routeMode: "endpoints",
      departsBy: input.departsBy ?? null,
      truncated: summary.count > offset + rows.length,
      noDestExcluded: noDestHidden || undefined,
    },
  };
}

/**
 * Trucks that pass every OTHER filter and were dropped for having no stated
 * destination -- the number the Trucks tab prints rather than swallowing.
 *
 * `destWhere` is re-attached inside a branch that can never be taken, and that
 * is not decoration. This query reuses the main query's bind values, and
 * Postgres counts a prepared statement's parameters by the highest `$n` it
 * mentions: drop the destination predicates entirely and the highest `$n` can
 * fall below the number of values supplied, which is a bind error rather than a
 * wrong answer. Mentioning them under `true OR (...)` keeps the parameter list
 * identical while the planner discards the branch.
 */
async function countNoDestination(
  where: string[],
  destWhere: string[],
  whereValues: unknown[],
): Promise<number> {
  const clauses = [...where, `t.dest_lat IS NULL`];
  if (destWhere.length) clauses.push(`(true OR (${destWhere.join(" AND ")}))`);
  const row = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n ${TRUCK_FROM_SQL} WHERE ${clauses.join(" AND ")}`,
    whereValues,
  );
  return row?.n ?? 0;
}

/** The truck headline, over the whole filtered set rather than the page. */
async function summarize(whereSql: string, whereValues: unknown[]): Promise<TruckSummary> {
  // The board's calendar, not the database process's: the same date the chips
  // underneath this headline are measured against.
  const today = `$${whereValues.length + 1}`;
  const row = await queryOne<TruckSummary>(
    `SELECT count(*)::int AS "count",
            coalesce(sum(t.free_cf),0)::int AS "totalFreeCf",
            count(t.free_cf)::int AS "withFreeCf",
            count(*) FILTER (WHERE t.avail_now OR t.avail_from <= ${today}::date)::int AS "departingToday",
            count(*) FILTER (WHERE t.dest_lat IS NULL)::int AS "noDestination",
            count(*) FILTER (WHERE t.last_seen_at > now() - interval '24 hours')::int AS "freshToday",
            percentile_cont(0.5) WITHIN GROUP (ORDER BY t.corridor_miles::float8) AS "medianCorridorMiles"
       ${TRUCK_FROM_SQL}
       ${whereSql}`,
    [...whereValues, localToday()],
  );
  return row ?? emptySummary();
}

function emptySummary(): TruckSummary {
  return {
    count: 0,
    totalFreeCf: 0,
    withFreeCf: 0,
    departingToday: 0,
    noDestination: 0,
    freshToday: 0,
    medianCorridorMiles: null,
  };
}

/**
 * Route matching for trucks: "I am driving Miami to north Jersey -- who else is
 * empty along that line?"
 *
 * The geometry is `corridorFit` in lib/match/corridor.ts, the SAME function the
 * job board's corridor search calls, with `strictForward: false` so the two
 * boards agree about what "on the way" means. A second implementation of this
 * test is the one duplication the spec refuses at any price: drift here
 * produces exactly the wrong-way match the product claims it does not make.
 *
 * A truck with no stated destination has no line to compare and is dropped --
 * but it is COUNTED and the count is returned, because a filter that silently
 * removes rows a driver can see on the map is the deliver-by lesson from wave 1.
 */
async function corridorSearch(
  input: TruckSearchParams,
  corridor: { origin: GeoPoint; destination: GeoPoint; miles: number },
  whereSql: string,
  distanceExpr: string,
  p: ReturnType<typeof params>,
): Promise<TruckSearchResult> {
  const candidates = await query<TruckRow>(
    `SELECT ${TRUCK_SELECT_COLUMNS}, ${distanceExpr} AS distance_miles
       ${TRUCK_FROM_SQL}
       ${whereSql}
     ORDER BY t.last_seen_at DESC NULLS LAST, t.id DESC
     LIMIT ${p.add(CORRIDOR_CANDIDATE_CAP)}`,
    p.values,
  );

  const { origin, destination, miles } = corridor;
  const route = { origin, destination, halfWidthMiles: miles };
  const scored: TruckRow[] = [];
  let noDestExcluded = 0;

  for (const row of candidates) {
    if (row.dest_lat == null || row.dest_lng == null) {
      noDestExcluded++;
      continue;
    }

    const start = { lat: row.origin_lat, lng: row.origin_lng };
    const end = { lat: row.dest_lat, lng: row.dest_lng };

    const fit = corridorFit(start, end, route, { strictForward: false });
    if (!fit) continue;

    row.off_route_miles = Math.round(fit.offRoute);
    row.route_progress = Number(fit.pickupProgress.toFixed(3));
    row.detour_miles = Math.round(fit.detour);
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
      departsBy: input.departsBy ?? null,
      truncated: candidates.length >= CORRIDOR_CANDIDATE_CAP || scored.length > offset + rows.length,
      noDestExcluded,
    },
  };
}

/** The same summary as `summarize`, computed in JS for corridor mode. */
function summarizeRows(rows: TruckRow[]): TruckSummary {
  const today = localToday();
  const dayAgo = Date.now() - 24 * 3600_000;
  const corridors: number[] = [];
  let totalFreeCf = 0;
  let withFreeCf = 0;
  let departingToday = 0;
  let noDestination = 0;
  let freshToday = 0;

  for (const r of rows) {
    if (r.free_cf != null) {
      totalFreeCf += r.free_cf;
      withFreeCf++;
    }
    if (r.avail_now || (r.avail_from != null && r.avail_from <= today)) departingToday++;
    if (r.dest_lat == null) noDestination++;
    if (r.last_seen_at != null && new Date(r.last_seen_at).getTime() > dayAgo) freshToday++;
    corridors.push(r.corridor_miles);
  }

  corridors.sort((a, b) => a - b);
  const mid = corridors.length
    ? corridors.length % 2
      ? corridors[(corridors.length - 1) / 2]
      : (corridors[corridors.length / 2 - 1] + corridors[corridors.length / 2]) / 2
    : null;

  return {
    count: rows.length,
    totalFreeCf,
    withFreeCf,
    departingToday,
    noDestination,
    freshToday,
    medianCorridorMiles: mid,
  };
}

// --- fragment builders -------------------------------------------------------
//
// `distanceSql`, `radiusClause`, `boundsClause`, `zipPattern`, `expandStates`,
// `clamp`, `pageLimit` and `pageOffset` come from ./sql, shared with the job
// board. What is written here names truck columns, and there is no case in it
// that could sort free space on the freight scale.

function eitherEndInBounds(b: BoundsInput, p: ReturnType<typeof params>): string {
  return `(${boundsClause(b, p, "t.origin_lat", "t.origin_lng")}
        OR ${boundsClause(b, p, "t.dest_lat", "t.dest_lng")})`;
}

function orderBy(sort: TruckSearchParams["sort"], hasDistance: boolean): string {
  switch (sort) {
    case "newest":
      return `t.first_seen_at DESC NULLS LAST, t.id DESC`;
    case "last_seen":
      return `t.last_seen_at DESC NULLS LAST, t.id DESC`;
    case "distance":
      return hasDistance ? `distance_miles ASC NULLS LAST, t.id DESC` : `t.id DESC`;
    case "free_cf":
      // A truck that never stated its free space sorts last rather than as 0 --
      // unknown is not "none".
      return `t.free_cf DESC NULLS LAST, t.id DESC`;
    case "leg_miles":
      return `t.leg_miles DESC NULLS LAST, t.id DESC`;
    case "depart":
    default:
      // Leaving today first, then the soonest stated departure. A truck with no
      // stated date sorts after the dated ones instead of pretending to be
      // imminent.
      return `t.avail_now DESC, t.avail_from ASC NULLS LAST, t.last_seen_at DESC NULLS LAST, t.id DESC`;
  }
}

/**
 * The board's calendar day.
 *
 * The same function as ./query.ts's private `localToday`, copied rather than
 * lifted: the job query path is frozen for this feature (SPEC §0), so the
 * shared home for it is ./sql.ts the next time `searchLoads` is open for edit.
 * Both read DEFAULT_TZ, so they cannot disagree about which day it is without
 * someone changing one of them on purpose.
 */
function localToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()); // en-CA yields YYYY-MM-DD
}

/**
 * One truck, by id.
 *
 * `WHERE t.id = $1` is the shape that had no predicate to extend on the job
 * side, which is exactly why both predicates are added here by hand. A
 * quarantine that lived only in `searchTrucks` would keep an unreviewed truck
 * off the board and leave it a URL away -- and one `POST /api/trucks/:id/contact`
 * away from a phone number.
 */
/**
 * Both truck predicates, for the one module outside this file that builds its
 * own `WHERE` against `trucks`: the matcher's candidate prefilter
 * (`src/lib/match/candidates.ts`).
 *
 * Exported rather than copied, and the asymmetry with the job side is
 * deliberate. This file copies the JOB board's demo fragment because the job
 * query path is frozen for this feature; there is nothing frozen about this
 * file, so the truck feature's own second reader shares the predicates instead
 * of restating them. A scope that has to be passed and a fragment that cannot
 * be forgotten are worth more here than a symmetry with a constraint that does
 * not apply.
 */
export {
  visibilityClause as truckVisibilityClause,
  demoVisibilitySql as truckDemoVisibilitySql,
};

/**
 * The rows behind a set of ids the caller already holds, in id order.
 *
 * The sibling of `loadsByIds`, and for the same caller: the matcher decides on
 * a fourteen-column prefilter and then needs the full public rows for the few
 * that survived, without a second copy of `TRUCK_SELECT_COLUMNS` living under
 * `lib/match`. Both predicates apply, so a pending or somebody else's demo
 * truck cannot arrive through the back door of a match list.
 */
export async function trucksByIds(
  ids: number[],
  scope: TruckScope,
  audience?: TruckAudience | null,
): Promise<TruckRow[]> {
  if (!ids.length) return [];
  const p = params();
  const where = [`t.id = ANY(${p.add(ids)}::bigint[])`];
  const vis = visibilityClause(scope);
  if (vis) where.push(vis);
  const demo = demoVisibilitySql(audience, p);
  if (demo) where.push(demo);

  return query<TruckRow>(
    `SELECT ${TRUCK_SELECT_COLUMNS}, NULL::float8 AS distance_miles
       ${TRUCK_FROM_SQL}
      WHERE ${where.join("\n        AND ")}
      ORDER BY t.id`,
    p.values,
  );
}

export async function getTruck(
  id: number,
  scope: TruckScope,
  audience?: TruckAudience | null,
): Promise<TruckRow | null> {
  const p = params();
  const idP = p.add(id);
  const where = [`t.id = ${idP}`];
  const vis = visibilityClause(scope);
  if (vis) where.push(vis);
  const demo = demoVisibilitySql(audience, p);
  if (demo) where.push(demo);

  const rows = await query<TruckRow>(
    `SELECT ${TRUCK_SELECT_COLUMNS}, NULL::float8 AS distance_miles
       ${TRUCK_FROM_SQL}
      WHERE ${where.join("\n        AND ")}`,
    p.values,
  );
  return rows[0] ?? null;
}
