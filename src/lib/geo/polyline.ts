/**
 * HERE's **flexible polyline**, decoded here rather than depended on.
 *
 * `/v8/routes` returns the road geometry in HERE's own encoding — not Google's
 * encoded polyline, and not GeoJSON. It is a compact, self-describing format: a
 * header declares the coordinate precision and whether a third dimension is
 * present, then every point is a pair (or triple) of zig-zagged varints holding
 * the delta from the previous point. A Miami → Kearny truck route arrives as
 * roughly 67,000 characters.
 *
 * There is a published npm package for it. package-lock.json is frozen, so this
 * is the whole decoder instead — it is sixty lines of arithmetic and it has no
 * moving parts.
 *
 * Two details are worth knowing before touching it:
 *
 *  - **No bitwise accumulation.** The reference JavaScript implementation
 *    builds each varint with `result |= (v & 0x1f) << shift`. JavaScript's
 *    bitwise operators are 32-bit and signed, so at precision 7 a zig-zagged
 *    longitude near the antimeridian (3.6e9) silently wraps to a negative
 *    number and the route jumps to the other side of the planet. Plain
 *    multiplication by `2 ** shift` is exact to 2^53 and costs nothing.
 *
 *  - **Decode server-side only.** The browser never sees the encoded string;
 *    it gets the simplified `[lng, lat]` array cached on the row.
 */

/** Index = value, so `ALPHABET[62] === "-"`. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const VALUE_OF = new Map<string, number>(
  Array.from(ALPHABET, (char, index) => [char, index] as const),
);

/** The only header version HERE has ever emitted. */
const FORMAT_VERSION = 1;

/** Points are 1e-`precision` degrees apart at worst; HERE routing uses 5. */
const MAX_PRECISION = 15;

/**
 * Decode a flexible polyline into GeoJSON coordinate order, `[lng, lat]`.
 *
 * A third dimension (elevation, level) is read and discarded: the board is
 * two-dimensional and carrying altitude would only make the cached row bigger.
 *
 * Throws on a string this is not — a caller that would rather lose the geometry
 * than the trip summary should catch.
 */
export function decodeFlexiblePolyline(encoded: string): [number, number][] {
  let cursor = 0;

  /** The next unsigned varint, or null once the string runs out. */
  const next = (): number | null => {
    let result = 0;
    let shift = 0;
    while (cursor < encoded.length) {
      const char = encoded[cursor]!;
      cursor += 1;
      const value = VALUE_OF.get(char);
      if (value === undefined) {
        throw new Error(`flexible polyline: unexpected character ${JSON.stringify(char)}`);
      }
      result += (value & 0x1f) * 2 ** shift;
      if ((value & 0x20) === 0) return result;
      shift += 5;
      if (shift > 50) throw new Error("flexible polyline: varint too long");
    }
    return null;
  };

  const version = next();
  if (version !== FORMAT_VERSION) {
    throw new Error(`flexible polyline: unsupported version ${version}`);
  }

  const header = next();
  if (header == null) throw new Error("flexible polyline: truncated header");
  const precision = header & 0x0f;
  const thirdDim = (header >> 4) & 0x07;
  if (precision > MAX_PRECISION) throw new Error("flexible polyline: absurd precision");

  const factor = 10 ** precision;
  const points: [number, number][] = [];
  let lat = 0;
  let lng = 0;

  for (;;) {
    const dLat = next();
    if (dLat == null) break;
    const dLng = next();
    if (dLng == null) break;
    // Present but unused: the elevation/level channel, read so the stream stays
    // aligned on the next pair.
    if (thirdDim !== 0 && next() == null) break;

    lat += unzigzag(dLat);
    lng += unzigzag(dLng);
    points.push([lng / factor, lat / factor]);
  }

  return points;
}

/** Zig-zag: even numbers are positive, odd numbers are negative. */
function unzigzag(value: number): number {
  return value % 2 === 1 ? -(value + 1) / 2 : value / 2;
}

/**
 * Thin a road geometry down to something a map can use.
 *
 * 67 KB of raw geometry per job is more than any zoom the board offers can
 * show: at national scale a cross-country route is a few hundred pixels of
 * line, and the extra points are invisible in the render and expensive in the
 * row, the response and the GeoJSON source.
 *
 * Douglas–Peucker with a widening tolerance: run it, and if the result is still
 * over budget, run it again with a coarser epsilon. The alternative — picking
 * one epsilon — either leaves a transcontinental route too heavy or flattens a
 * cross-town one into a triangle, because the two differ by three orders of
 * magnitude in length.
 */
export function simplifyPath(
  points: [number, number][],
  maxPoints = 500,
): [number, number][] {
  if (points.length <= maxPoints) return points;

  // ~55 m at the equator. Below a route's own rendering error at every zoom the
  // board offers, so the first pass is usually the only one.
  let epsilon = 0.0005;
  let out = douglasPeucker(points, epsilon);
  for (let i = 0; i < 24 && out.length > maxPoints; i += 1) {
    epsilon *= 1.7;
    out = douglasPeucker(points, epsilon);
  }
  return out;
}

/**
 * Iterative Douglas–Peucker. Iterative rather than recursive because a route
 * that happens to be nearly straight recurses once per point, and 8,000 frames
 * is a stack overflow rather than a slow function.
 *
 * Distances are measured in degrees with longitude scaled by the local cosine,
 * so the tolerance means roughly the same thing in Miami and in Minnesota.
 */
function douglasPeucker(points: [number, number][], epsilon: number): [number, number][] {
  const n = points.length;
  if (n <= 2) return points.slice();

  const kx = Math.max(0.2, Math.cos((points[Math.floor(n / 2)]![1] * Math.PI) / 180));
  const limit = epsilon * epsilon;

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack: number[] = [0, n - 1];
  while (stack.length) {
    const end = stack.pop()!;
    const start = stack.pop()!;

    let farthest = -1;
    let worst = 0;
    for (let i = start + 1; i < end; i += 1) {
      const d = segmentDistanceSq(points[i]!, points[start]!, points[end]!, kx);
      if (d > worst) {
        worst = d;
        farthest = i;
      }
    }

    if (farthest !== -1 && worst > limit) {
      keep[farthest] = 1;
      stack.push(start, farthest, farthest, end);
    }
  }

  const out: [number, number][] = [];
  for (let i = 0; i < n; i += 1) if (keep[i]) out.push(points[i]!);
  return out;
}

/** Squared distance from `p` to the segment `a`–`b`, longitude scaled by `kx`. */
function segmentDistanceSq(
  p: [number, number],
  a: [number, number],
  b: [number, number],
  kx: number,
): number {
  const ax = a[0] * kx;
  const ay = a[1];
  let x = ax;
  let y = ay;
  const dx = b[0] * kx - ax;
  const dy = b[1] - ay;

  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] * kx - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b[0] * kx;
      y = b[1];
    } else if (t > 0) {
      x = ax + dx * t;
      y = ay + dy * t;
    }
  }

  const ex = p[0] * kx - x;
  const ey = p[1] - y;
  return ex * ex + ey * ey;
}
