/**
 * The matcher's numbers. Every one of them is PRINTED where it is used.
 *
 * A threshold a driver cannot see is a threshold they cannot argue with, and
 * this matcher's whole claim is that its refusals are checkable: "38 weren't
 * near your route" means nothing unless the reader can find out how near near
 * is. So the corridor width is a control on the posting form, the drive-day
 * model is named in the date clause, and the two Strong fractions are named in
 * the "how this was matched" panel.
 *
 * Pure: no database, no clock, no network. SPEC 11.2.
 */
import {
  DEFAULT_TRUCK_CORRIDOR_MILES,
  TRUCK_CORRIDOR_OPTIONS,
} from "@/lib/loads/constants";

/**
 * How far off their line a driver will swing, when nobody said.
 *
 * Derived from the form's default rather than written again as `60`. The
 * specification gives the same number in two places -- the schema default for
 * `trucks.corridor_miles` and the matcher's default -- and two literals is how
 * a form that offers 60 ends up matched at 75.
 */
export const DEFAULT_MATCH_CORRIDOR_MILES = DEFAULT_TRUCK_CORRIDOR_MILES;

/**
 * The widest corridor any single truck may choose, and therefore the pad on the
 * JOB-anchored candidate box: a set built with a narrower pad than some truck's
 * own corridor would silently drop that truck from the mirror of a match it
 * makes in the other direction.
 *
 * Read off the option list rather than restated, for the same reason.
 */
export const MAX_CORRIDOR_MILES = Math.max(...TRUCK_CORRIDOR_OPTIONS);

/** Extra driving a job may cost, as a fraction of the leg it is bolted onto. */
export const MAX_DETOUR_FRACTION = 0.3;

/** How far a job's own course may diverge from the truck's, in degrees. */
export const MAX_BEARING_DEG = 90;

/**
 * Forward progress has to be progress. Two points that project onto the same
 * 2% of the leg are not a trip along it; they are a lateral hop that the raw
 * `deliveryProgress > pickupProgress` comparison would wave through.
 */
export const PROGRESS_EPSILON = 0.02;

/** Straight line -> road miles. Crude, disclosed, and never fetched. */
export const ROAD_FACTOR = 1.18;

/** An HHG truck's day. Crude, disclosed, and used only to refuse and to wait. */
export const MILES_PER_DRIVING_DAY = 500;

/**
 * A truck that never said where it is going has no route to be near, so it gets
 * a circle instead of a corridor -- and the circle is never smaller than the
 * corridor the driver chose.
 */
export const OPEN_TRUCK_RADIUS_MILES = 100;

/** Rows pulled into memory per match query, before the pure pass. */
export const MATCH_CANDIDATE_CAP = 2000;

/** Strong needs a detour inside this fraction of the leg. */
export const STRONG_DETOUR_FRACTION = 0.15;

/** ...and a pickup inside this fraction of the corridor the driver chose. */
export const STRONG_OFFROUTE_FRACTION = 0.5;

/**
 * Service dimensions that VETO a match. Empty, and it ships empty.
 *
 * 0 of 98 job rows carry a tag and 17 carry one repeated string, so there is no
 * service dimension to score; a ranking built on that would look meaningful and
 * be noise. The mechanism exists so that the day a real "no lift gate" veto is
 * needed it has a home, and acceptance M13 asserts the set is still empty so
 * nobody fills it with guesses in the meantime. SPEC 11.6.
 */
export const HARD_TAG_VETOES: ReadonlySet<string> = new Set<string>();
