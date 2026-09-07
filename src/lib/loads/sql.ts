/**
 * SQL fragments that are about geography, paging and place names rather than
 * about jobs.
 *
 * These came out of `query.ts` unchanged when the truck board arrived. A truck
 * listing is not a shipment and gets its own table and its own search function
 * (see .design/truck/SPEC.md §0), but "within 50 miles of Newark", "inside the
 * viewport", "070 means north Jersey" and "?limit=1e21 is not a page size" are
 * the same questions for both, and answering them twice is how two boards start
 * disagreeing about where Newark is.
 *
 * Everything here is pure: a string in, a string out, with bind values pushed
 * onto the caller's `params()`. Nothing knows which table it is filtering --
 * column names arrive as arguments, and they are column references chosen by
 * the caller, never user input.
 *
 * What deliberately did NOT move: `SELECT_COLUMNS`, `summarize`, `orderBy`,
 * `PER_CF_SQL` and `eitherEndInBounds`. Those name job columns, and a truck's
 * versions are meant to be written with the job-only predicates deleted rather
 * than adapted -- a shared `orderBy` with a `cf` case is how `free_cf` ends up
 * sorted on the freight scale.
 */
import type { params } from "@/lib/db";
import { radiusBoundingBox } from "@/lib/geo/math";
import { REGIONS } from "@/lib/geo/states";
import type { BoundsInput, GeoPoint } from "./types";

/** Haversine in SQL. `latCol`/`lngCol` are column refs, never user input. */
export function distanceSql(latCol: string, lngCol: string, latP: string, lngP: string): string {
  return `(3958.7613 * 2 * asin(least(1, sqrt(
    power(sin(radians(${latP}::float8 - ${latCol}) / 2), 2) +
    cos(radians(${latCol})) * cos(radians(${latP}::float8)) *
    power(sin(radians(${lngP}::float8 - ${lngCol}) / 2), 2)
  ))))`;
}

/**
 * Radius search: bounding-box prefilter (served by the (lat,lng) btree indexes)
 * AND exact haversine. The box alone would return corner false-positives; the
 * haversine alone would table-scan.
 */
export function radiusClause(
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

export function boundsClause(
  b: BoundsInput,
  p: ReturnType<typeof params>,
  latCol: string,
  lngCol: string,
): string {
  return `(${latCol} BETWEEN ${p.add(b.minLat)} AND ${p.add(b.maxLat)}
       AND ${lngCol} BETWEEN ${p.add(b.minLng)} AND ${p.add(b.maxLng)})`;
}

export function zipPattern(zip: string): string {
  const digits = zip.replace(/\D/g, "").slice(0, 5);
  // Partial ZIPs are a legitimate filter: "070" means north Jersey.
  return digits.length === 5 ? digits : `${digits}%`;
}

/** Region tokens ("southeast", "tristate") expand into their member states. */
export function expandStates(input: string[] | undefined): string[] {
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

export function clamp(n: number, lo: number, hi: number): number {
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
