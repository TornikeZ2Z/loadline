/**
 * The curve one lane draws on the map.
 *
 * This file existed once before, when EVERY job drew an arc and the fan of
 * five deterministic sides (`side = (id % 5) - 2`) was there to stop eight jobs
 * out of one warehouse collapsing into a single stroke. That map was replaced
 * by `points.ts` -- a hundred overlapping curves is not a picture of anything --
 * and this went with it.
 *
 * It is back for the opposite reason. The arc was the best-looking thing on the
 * board; what was wrong was ninety-eight of them at once. So exactly one is
 * drawn, for the lane under the pointer, and it disappears when the pointer
 * leaves. The fan is therefore gone: with one curve on screen there is nothing
 * to fan apart, and a lane's shape should not depend on its row's id -- the
 * same lane hovered from a card and from its dot has to be the same curve.
 *
 * Pure client-safe math: no map, no DOM.
 */

import type { Point } from "./math";

/**
 * How far the control point is pushed off the chord, as a share of its length.
 *
 * A quadratic Bézier's midpoint sits half way to its control point, so the
 * curve bulges by BOW/2 of the chord -- about 11%, which on NJ to Florida is a
 * hand's width of daylight off the straight line. The fan used a fifth of this
 * per side because five of them had to stay apart without leaving the country;
 * one curve can afford to be a curve.
 */
const BOW = 0.22;

/**
 * `n` points along a quadratic Bézier from `a` to `b`, bowed to `side`
 * (0 is a straight line), as GeoJSON `[lng, lat]` pairs.
 *
 * The perpendicular is taken in the raw lng/lat plane rather than in projected
 * metres: at US scale the visual difference is a slight tilt of the bow, and
 * doing it properly would mean projecting to Web Mercator and back for every
 * point of the curve on every hover.
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

/**
 * The one lane the map draws on hover: pickup to delivery, bowed once, to the
 * left of travel, and sampled finely enough that the gradient along it reads as
 * a smooth wash rather than as sixteen flat facets.
 *
 * Always the same side, because a curve that flipped depending on which job it
 * belonged to would make two hovers of the same lane look like two lanes.
 */
export function lanePoints(a: Point, b: Point): [number, number][] {
  return arcPoints(a, b, 1, 64);
}
