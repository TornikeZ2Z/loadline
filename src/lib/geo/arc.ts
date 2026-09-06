/**
 * The curve a job draws on the map.
 *
 * Every job is a route, and a busy sender posts eight jobs out of one town to
 * eight different ZIPs -- drawn as straight lines they would collapse into a
 * single stroke leaving the origin. So each route is a quadratic arc bent to
 * one of five deterministic sides (`side = (id % 5) - 2`), which fans a shared
 * origin out into legible separate strokes and keeps the same job on the same
 * side across re-renders.
 *
 * Pure client-safe math, kept out of A's `math.ts` so the file has one owner.
 */

import type { Point } from "./math";

/** How far the control point is pushed off the chord, per unit of `side`. */
const BOW = 0.06;

/**
 * `n` points along a quadratic Bézier from `a` to `b`, bowed to `side`
 * (-2..2; 0 is a straight line), as GeoJSON `[lng, lat]` pairs.
 *
 * The perpendicular is taken in the raw lng/lat plane rather than in projected
 * metres: at US scale the visual difference is a slight tilt of the bow, and
 * doing it properly would mean projecting to Web Mercator and back for every
 * point of every route on every render.
 */
export function arcPoints(a: Point, b: Point, side: number, n = 32): [number, number][] {
  const steps = Math.max(2, Math.floor(n));
  const ax = a.lng;
  const ay = a.lat;
  const bx = b.lng;
  const by = b.lat;

  const dx = bx - ax;
  const dy = by - ay;
  const chord = Math.hypot(dx, dy);

  // Control point: chord midpoint pushed along the chord's perpendicular.
  const offset = chord * BOW * side;
  const nx = chord === 0 ? 0 : -dy / chord;
  const ny = chord === 0 ? 0 : dx / chord;
  const cx = (ax + bx) / 2 + nx * offset;
  const cy = (ay + by) / 2 + ny * offset;

  const out: [number, number][] = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const u = 1 - t;
    out.push([
      u * u * ax + 2 * u * t * cx + t * t * bx,
      u * u * ay + 2 * u * t * cy + t * t * by,
    ]);
  }
  return out;
}
