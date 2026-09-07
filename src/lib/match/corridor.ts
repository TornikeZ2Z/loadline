/**
 * "Is this job on my way?" -- once, for everybody who asks.
 *
 * The board's corridor search has answered this since wave 1: a driver going
 * Miami -> North Jersey wants anything whose pickup sits near the line and
 * whose delivery makes forward progress along it, without a detour that turns
 * the run into a different trip. The truck matcher asks the identical question
 * from the other side, and the one thing this feature cannot afford is two
 * implementations of it drifting apart: drift here produces exactly the
 * wrong-way match the product claims it does not make.
 *
 * So the test lives here, in one pure function, and `corridorSearch` in
 * `lib/loads/query.ts` calls it rather than owning it.
 *
 * Pure: no database, no network, no clock. Imports nothing but geometry.
 */
import {
  alongTrackFraction,
  crossTrackMiles,
  detourMiles,
  haversineMiles,
} from "@/lib/geo/math";
import type { GeoPoint } from "@/lib/loads/types";

/** The driver's leg, and how far off it still counts as "on the way". */
export interface CorridorRoute {
  origin: GeoPoint;
  destination: GeoPoint;
  halfWidthMiles: number;
}

/** Everything the callers rank, print or gate on. Miles, unrounded. */
export interface CorridorFit {
  /** How far the PICKUP sits off the driver's line. */
  offRoute: number;
  /** How far the DELIVERY sits off it. */
  deliveryOffRoute: number;
  /** Where along the leg each end falls, 0 at the origin and 1 at the destination. */
  pickupProgress: number;
  deliveryProgress: number;
  /** Extra driving the job costs, over driving the leg straight through. */
  detour: number;
  /** The leg itself, straight line. */
  legMiles: number;
}

/**
 * `null` means outside the corridor -- the same "skip this row" the board's
 * loop has always meant, with no partial result to misread.
 *
 * `strictForward` is the one behavioural difference between the two callers.
 * The board search allows an escape hatch: a delivery that does not advance
 * along the leg still counts if it ends up closer to the destination than the
 * pickup was, which keeps honest jobs around a curved coast. The matcher does
 * not take it -- when a *truck* is being told "this load carries you home", a
 * delivery that fails strict forward progress is the failure mode, not an edge
 * case. `evaluateMatch` layers PROGRESS_EPSILON and a bearing test on top of
 * this; neither belongs here, because the board must keep behaving exactly as
 * it does today.
 */
export function corridorFit(
  pickup: GeoPoint,
  delivery: GeoPoint,
  route: CorridorRoute,
  opts: { strictForward: boolean },
): CorridorFit | null {
  const { origin, destination, halfWidthMiles: miles } = route;

  const offRoute = crossTrackMiles(pickup, origin, destination);
  if (offRoute > miles) return null;

  const pickupProgress = alongTrackFraction(pickup, origin, destination);
  const deliveryProgress = alongTrackFraction(delivery, origin, destination);

  if (deliveryProgress <= pickupProgress) {
    if (opts.strictForward) return null;
    const closerToDest =
      haversineMiles(delivery, destination) < haversineMiles(pickup, destination);
    if (!closerToDest) return null;
  }

  // The delivery has to stay near the route too. Heading to New Jersey,
  // Miami -> Seattle technically makes "forward progress" (north) while
  // being nobody's idea of a job on the way.
  const deliveryOffRoute = crossTrackMiles(delivery, origin, destination);
  if (deliveryOffRoute > miles * 2) return null;

  // Cap total extra driving, scaled against the trip as well as the corridor
  // width: 150 extra miles is a rounding error coast to coast and a different
  // trip entirely on a 400-mile run.
  const legMiles = haversineMiles(origin, destination);
  const detour = detourMiles(origin, destination, pickup, delivery);
  if (detour > Math.min(miles * 2, legMiles * 0.3)) return null;

  return { offRoute, deliveryOffRoute, pickupProgress, deliveryProgress, detour, legMiles };
}
