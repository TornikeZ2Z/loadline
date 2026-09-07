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

/**
 * A point `miles` from `from` on a given initial bearing, on the sphere.
 * The inverse of `haversineMiles` + `initialBearing`, and the primitive the
 * corridor outline is built from.
 */
export function destinationPoint(from: Point, bearingDeg: number, miles: number): Point {
  const d = miles / EARTH_RADIUS_MI;
  const theta = rad(bearingDeg);
  const phi1 = rad(from.lat);
  const lambda1 = rad(from.lng);
  const sinPhi2 = Math.sin(phi1) * Math.cos(d) + Math.cos(phi1) * Math.sin(d) * Math.cos(theta);
  const phi2 = Math.asin(Math.min(Math.max(sinPhi2, -1), 1));
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(d) * Math.cos(phi1),
      Math.cos(d) - Math.sin(phi1) * sinPhi2,
    );
  return { lat: deg(phi2), lng: ((deg(lambda2) + 540) % 360) - 180 };
}

/**
 * The point a fraction `f` of the way along the great circle a -> b.
 *
 * Spherical interpolation, not a linear blend of the two coordinates: on a
 * Mercator map the great circle between Seattle and Miami bows a long way
 * clear of the straight line drawn between them, and the corridor is matched
 * on the great circle (`crossTrackMiles`). Interpolating the plain numbers
 * would draw a band the server never used.
 */
export function intermediatePoint(a: Point, b: Point, f: number): Point {
  const delta = haversineMiles(a, b) / EARTH_RADIUS_MI;
  if (delta < 1e-9) return { lat: a.lat, lng: a.lng };
  const sinDelta = Math.sin(delta);
  const A = Math.sin((1 - f) * delta) / sinDelta;
  const B = Math.sin(f * delta) / sinDelta;
  const phi1 = rad(a.lat);
  const lambda1 = rad(a.lng);
  const phi2 = rad(b.lat);
  const lambda2 = rad(b.lng);
  const x = A * Math.cos(phi1) * Math.cos(lambda1) + B * Math.cos(phi2) * Math.cos(lambda2);
  const y = A * Math.cos(phi1) * Math.sin(lambda1) + B * Math.cos(phi2) * Math.sin(lambda2);
  const z = A * Math.sin(phi1) + B * Math.sin(phi2);
  return { lat: deg(Math.atan2(z, Math.hypot(x, y))), lng: deg(Math.atan2(y, x)) };
}

/** Points along an arc of `miles` radius, the bearing sweeping from -> to. */
function capArc(centre: Point, fromBearing: number, toBearing: number, miles: number): Point[] {
  const steps = 12;
  const out: Point[] = [];
  // From 1, not 0: the arc's first point is the side's last point, and
  // repeating a vertex buys nothing.
  for (let i = 1; i <= steps; i += 1) {
    out.push(destinationPoint(centre, fromBearing + ((toBearing - fromBearing) * i) / steps, miles));
  }
  return out;
}

/**
 * The outline of the corridor `crossTrackMiles` actually tests, as a ring of
 * [lng, lat] ready for GeoJSON.
 *
 * That test is a CAPSULE, not a band: between the endpoints it measures
 * perpendicular distance to the great circle, and past either endpoint it
 * falls back to the straight-line distance to that endpoint -- which is a
 * half-disc of radius `miles` stuck on each end. Drawing a rectangle instead
 * claims two corners the matcher rejects and disclaims two half-discs it
 * accepts, at both ends, at every width.
 *
 * The sides are offset from the LOCAL course rather than from the chord's
 * bearing, so the band follows the same great circle the matcher projects
 * onto rather than the straight line a Mercator map would draw between the
 * two ends.
 */
export function corridorRing(
  origin: Point,
  destination: Point,
  miles: number,
  steps = 48,
): [number, number][] {
  const ring: Point[] = [];
  const width = Math.max(miles, 0.1);

  // A route with no length is a plain circle: the capsule's two caps and no
  // sides between them. Without this the bearings below are undefined.
  if (haversineMiles(origin, destination) < 0.1) {
    for (let i = 0; i <= 48; i += 1) ring.push(destinationPoint(origin, (i * 360) / 48, width));
    return ring.map((p) => [p.lng, p.lat]);
  }

  const path: Point[] = [];
  for (let i = 0; i <= steps; i += 1) path.push(intermediatePoint(origin, destination, i / steps));
  // The course AT a vertex, which is what its two offsets are perpendicular to.
  const course = (i: number) =>
    i < steps ? initialBearing(path[i]!, path[i + 1]!) : initialBearing(path[i - 1]!, path[i]!);

  // Right-hand side, origin -> destination.
  for (let i = 0; i <= steps; i += 1) ring.push(destinationPoint(path[i]!, course(i) + 90, width));
  // Round the far end: +90 down through the course itself (straight on) to -90.
  ring.push(...capArc(path[steps]!, course(steps) + 90, course(steps) - 90, width));
  // Left-hand side, back down.
  for (let i = steps; i >= 0; i -= 1) ring.push(destinationPoint(path[i]!, course(i) - 90, width));
  // Round the near end: -90 down through -180 (behind the origin) to -270 = +90.
  ring.push(...capArc(path[0]!, course(0) - 90, course(0) - 270, width));

  return ring.map((p) => [p.lng, p.lat]);
}
