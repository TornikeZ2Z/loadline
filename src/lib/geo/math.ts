/** Great-circle geometry helpers, shared by the SQL query builder and the UI. */

export const EARTH_RADIUS_MI = 3958.7613;

export interface Point {
  lat: number;
  lng: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in statute miles. */
export function haversineMiles(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(h));
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/**
 * Box that fully contains the radius circle. Used as an index-friendly
 * prefilter before the exact haversine test -- a plain btree on (lat, lng)
 * can serve this, so we get most of the benefit of a spatial index for free.
 */
export function radiusBoundingBox(center: Point, miles: number): BoundingBox {
  const latDelta = deg(miles / EARTH_RADIUS_MI);
  // Longitude degrees shrink toward the poles. Clamp the cosine so a box near
  // a pole widens instead of dividing by ~0.
  const cos = Math.max(Math.cos(rad(center.lat)), 0.01);
  const lngDelta = deg(miles / (EARTH_RADIUS_MI * cos));
  return {
    minLat: center.lat - latDelta,
    maxLat: center.lat + latDelta,
    minLng: center.lng - lngDelta,
    maxLng: center.lng + lngDelta,
  };
}

export function unionBoundingBox(boxes: BoundingBox[]): BoundingBox {
  return {
    minLat: Math.min(...boxes.map((b) => b.minLat)),
    maxLat: Math.max(...boxes.map((b) => b.maxLat)),
    minLng: Math.min(...boxes.map((b) => b.minLng)),
    maxLng: Math.max(...boxes.map((b) => b.maxLng)),
  };
}

/**
 * Perpendicular ("cross-track") distance in miles from `p` to the great-circle
 * path start -> end. This is the core of corridor / route matching: a load
 * whose pickup sits 20 miles off the I-95 line between Philadelphia and Atlanta
 * is on the way; one 300 miles off is not.
 *
 * Points that project beyond either endpoint fall back to the straight-line
 * distance to that endpoint, so the corridor is a capsule rather than an
 * infinite band.
 */
export function crossTrackMiles(p: Point, start: Point, end: Point): number {
  const routeLen = haversineMiles(start, end);
  if (routeLen < 0.1) return haversineMiles(p, start);

  const { crossTrack, alongTrack } = project(p, start, end);
  if (crossTrack == null || alongTrack == null) return haversineMiles(p, start);

  // Capsule, not an infinite band: past either endpoint, fall back to the
  // straight-line distance to that endpoint.
  if (alongTrack < 0) return haversineMiles(p, start);
  if (alongTrack > routeLen) return haversineMiles(p, end);
  return Math.abs(crossTrack);
}

/**
 * How far along the route (0..1) a point projects. Used to require that a
 * load's delivery is *further along* than its pickup -- otherwise a
 * Philadelphia -> Atlanta driver gets shown loads heading back north.
 */
export function alongTrackFraction(p: Point, start: Point, end: Point): number {
  const routeLen = haversineMiles(start, end);
  if (routeLen < 0.1) return 0;
  const { alongTrack } = project(p, start, end);
  if (alongTrack == null) return 0;
  return Math.min(Math.max(alongTrack / routeLen, 0), 1);
}

/**
 * Project a point onto the great circle through start -> end.
 *
 * Returns SIGNED along-track distance in miles. The textbook along-track
 * formula uses acos(), which is non-negative and therefore reports a point
 * sitting *behind* the origin as being far along the route -- that is how a
 * northbound Newark -> Boston load can look like it belongs on a
 * Philadelphia -> Atlanta run. The bearing comparison below recovers the sign.
 */
function project(
  p: Point,
  start: Point,
  end: Point,
): { crossTrack: number | null; alongTrack: number | null } {
  const d13 = haversineMiles(start, p) / EARTH_RADIUS_MI; // angular distance
  if (d13 === 0) return { crossTrack: 0, alongTrack: 0 };

  const theta13 = initialBearing(start, p);
  const theta12 = initialBearing(start, end);

  const dxt = Math.asin(Math.sin(d13) * Math.sin(rad(theta13 - theta12)));
  const cosDxt = Math.cos(dxt);
  if (cosDxt === 0) return { crossTrack: null, alongTrack: null };

  const ratio = Math.min(Math.max(Math.cos(d13) / cosDxt, -1), 1);
  let alongTrack = Math.acos(ratio) * EARTH_RADIUS_MI;
  if (Number.isNaN(alongTrack)) return { crossTrack: null, alongTrack: null };

  // Signed bearing separation in [-180, 180). More than 90 degrees off the
  // route bearing means the point lies behind the origin, so the projection
  // runs backwards along the route.
  const bearingDelta = ((theta13 - theta12 + 540) % 360) - 180;
  if (Math.abs(bearingDelta) > 90) alongTrack = -alongTrack;

  return { crossTrack: dxt * EARTH_RADIUS_MI, alongTrack };
}

export function initialBearing(a: Point, b: Point): number {
  const dLng = rad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLng);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Extra miles a driver adds by taking a detour through pickup then delivery,
 * compared with driving the bare origin -> destination leg.
 */
export function detourMiles(
  origin: Point,
  destination: Point,
  pickup: Point,
  delivery: Point,
): number {
  const direct = haversineMiles(origin, destination);
  const viaLoad =
    haversineMiles(origin, pickup) +
    haversineMiles(pickup, delivery) +
    haversineMiles(delivery, destination);
  return Math.max(viaLoad - direct, 0);
}

export function formatMiles(miles: number | null | undefined): string {
  if (miles == null || Number.isNaN(miles)) return "--";
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}
