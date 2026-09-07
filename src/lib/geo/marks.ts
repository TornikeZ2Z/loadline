/**
 * The one place a job and a truck are the same thing.
 *
 * The map plots two populations. They are drawn differently on purpose -- a job
 * is a filled disc whose AREA is its freight, a truck is a fixed-size arrow --
 * but the work of turning rows into markers is identical: round the coordinate,
 * pile up everything that lands on it, keep the distinct real positions
 * underneath so a marker can be fanned apart honestly, and remember the
 * coarsest precision so a click cannot zoom past the datum. That logic was
 * expensively arrived at (see `points.ts`) and is not going to be written twice.
 *
 * So `buildGroups` takes marks, and each kind is projected into one here.
 *
 * `cf` is the trap this shape exists to keep visible: on a job it is FREIGHT on
 * a floor and on a truck it is FREE SPACE, a hole in the air. The two are never
 * summed, which is why `buildGroups` is called once per population and never
 * over a mixed array. Nothing here enforces that -- the callers do, and §14.5
 * of the spec says why in more detail than fits in a comment.
 */
import type { Feature, FeatureCollection, Point as GeoPoint } from "geojson";
import type { MapEnd } from "@/lib/loads/types";
import type { PublicLoadRow, PublicTruckRow } from "@/lib/loads/publicView";
import { SPACE_NOT_STATED, truckPlaceLabel } from "@/lib/loads/truckPresent";
import { formatCf } from "@/lib/moving/cubicFeet";
import { initialBearing } from "@/lib/geo/math";
import { buildGroups, endLabelText, endPoint, groupKey, type BuiltPoints, type PointProps } from "./points";

export type MarkKind = "job" | "truck";

export interface MapMark {
  kind: MarkKind;
  id: number;
  lng: number;
  lat: number;
  /** This position is a state centroid standing in for a coordinate nobody geocoded. */
  approx: boolean;
  /** Caps how far a click may zoom; see ZOOM_BY_PRECISION. */
  precision: string | null;
  label: string;
  state: string | null;
  /** FREIGHT for a job, FREE SPACE for a truck. Never summed across kinds. */
  cf: number | null;
  /** Trucks only: which way it is pointing. */
  bearing: number | null;
  /** Trucks only: the other end of its leg, for the hover line. */
  other: { lng: number; lat: number } | null;
}

/**
 * Jobs at the chosen end. A job that cannot be placed at all -- no coordinate
 * and no state to fall back on -- produces no mark, and the board counts those
 * out loud elsewhere rather than pretending they are somewhere.
 */
export function jobMarks(jobs: PublicLoadRow[], end: MapEnd): MapMark[] {
  const marks: MapMark[] = [];
  for (const job of jobs) {
    const at = endPoint(job, end);
    if (!at) continue;
    marks.push({
      kind: "job",
      id: job.id,
      lng: at.lng,
      lat: at.lat,
      approx: at.approx,
      precision: at.precision,
      label: endLabelText(job, end),
      state: end === "pickup" ? job.pickup_state : job.delivery_state,
      cf: job.cubic_feet,
      bearing: null,
      other: null,
    });
  }
  return marks;
}

/** A coordinate this row was never geocoded to more finely than a whole state. */
function isApprox(precision: string | null): boolean {
  return precision === "state" || precision === "region";
}

/**
 * Trucks at the chosen end.
 *
 * Two rules, and the second is the one that keeps the Deliveries view honest:
 *
 *  - **Pickups plots a truck where it will be EMPTY** -- its origin -- because
 *    that is where a dispatcher's freight has to be for this truck to be any
 *    use. Deliveries plots where it is headed.
 *  - **A truck with no stated destination gets NO MARK AT ALL on Deliveries.**
 *    Not a centroid, not its origin, nowhere. Drawing it at its origin would
 *    put a standing vehicle on a map of arrivals, and the state pills would
 *    then total freight arriving in FL beside trucks parked in FL -- two
 *    geographies on one number. The map says how many are missing instead.
 *
 * The bearing is always origin -> destination, whichever end is plotted: it is
 * the direction of travel, not a property of the dot. A truck with no stated
 * destination has no bearing, and the map draws it as a ring rather than
 * pointing it somewhere nobody said.
 */
export function truckMarks(trucks: PublicTruckRow[], end: MapEnd): MapMark[] {
  const marks: MapMark[] = [];
  for (const truck of trucks) {
    const origin = { lng: truck.origin_lng, lat: truck.origin_lat };
    const placed = truck.dest_lat != null && truck.dest_lng != null;
    const dest = placed ? { lng: truck.dest_lng!, lat: truck.dest_lat! } : null;
    const bearing = dest ? initialBearing(origin, dest) : null;

    if (end === "delivery") {
      if (!dest) continue;
      marks.push({
        kind: "truck",
        id: truck.id,
        lng: dest.lng,
        lat: dest.lat,
        approx: isApprox(truck.dest_precision),
        precision: truck.dest_precision,
        label: truckPlaceLabel(truck, "dest").text,
        state: truck.dest_state,
        cf: truck.free_cf,
        bearing,
        other: origin,
      });
      continue;
    }

    marks.push({
      kind: "truck",
      id: truck.id,
      lng: origin.lng,
      lat: origin.lat,
      approx: isApprox(truck.origin_precision),
      precision: truck.origin_precision,
      label: truckPlaceLabel(truck, "origin").text,
      state: truck.origin_state,
      cf: truck.free_cf,
      bearing,
      other: dest,
    });
  }
  return marks;
}

/* --------------------------- the truck marker ------------------------------
 *
 * `buildGroups` answers where the marks pile up, and that is all it answers:
 * its GeoJSON is frozen byte-for-byte by T-A3 (`npm run check:equiv`) and a
 * truck-shaped field added to `PointProps` would move the job snapshot for a
 * reason that has nothing to do with jobs. So the three facts the arrow needs
 * are derived HERE, over the same marks, under the same rounding, and welded
 * onto a copy of the features.
 */

/** What a truck marker knows that a job marker does not. */
export interface TruckGroupFacts {
  /**
   * Where to point, or null when there is nothing single to point at: no truck
   * here stated a destination, or the ones that did do not agree.
   */
  bearing: number | null;
  /** At least one truck here said where it is going. */
  directed: boolean;
  /** NOBODY here said how much room they have. */
  unstated: boolean;
  /** Distinct stated destinations under this marker. */
  destinations: number;
  /** Trucks here that never stated a destination. */
  noDestination: number;
}

export interface TruckPointProps extends PointProps {
  /** Degrees clockwise from north; 0 and meaningless when `directed` is false. */
  bearing: number;
  directed: boolean;
  unstated: boolean;
}

export interface TruckPoints {
  points: BuiltPoints;
  features: FeatureCollection<GeoPoint, TruckPointProps>;
  facts: Map<string, TruckGroupFacts>;
  /** The mark behind one truck id, for the hover leg and the selected lane. */
  markById: Map<number, MapMark>;
}

/**
 * Two trucks whose headings differ by less than this are drawn as one arrow.
 *
 * Trucks group only when they are within ~110 m of each other, which in
 * practice is one yard, and two trucks leaving one yard for Atlanta and for
 * Charlotte are going the same way at the scale this arrow is drawn. Past it
 * they are not, and the marker draws a ring: an arrow is a claim about where
 * these trucks are going, and there is no honest average of two directions.
 */
const BEARING_TOLERANCE_DEG = 20;

/** Signed shortest angle from `a` to `b`, in degrees. */
function angleDelta(a: number, b: number): number {
  return ((b - a + 540) % 360) - 180;
}

/** Marks -> the truck source: the shared grouping, plus what an arrow needs. */
export function truckPoints(marks: MapMark[]): TruckPoints {
  const points = buildGroups(marks);

  const facts = new Map<string, TruckGroupFacts>();
  const markById = new Map<number, MapMark>();
  const headings = new Map<string, number[]>();
  const destKeys = new Map<string, Set<string>>();

  for (const mark of marks) {
    markById.set(mark.id, mark);
    const key = groupKey(mark.lng, mark.lat);
    let fact = facts.get(key);
    if (!fact) {
      fact = {
        bearing: null,
        directed: false,
        unstated: true,
        destinations: 0,
        noDestination: 0,
      };
      facts.set(key, fact);
      headings.set(key, []);
      destKeys.set(key, new Set());
    }
    // Only a marker where EVERY truck's post was silent about space is drawn as
    // one, exactly as `buildGroups` treats an approximate coordinate.
    if (mark.cf != null) fact.unstated = false;
    if (mark.bearing == null) {
      fact.noDestination += 1;
    } else {
      fact.directed = true;
      headings.get(key)!.push(mark.bearing);
      if (mark.other) destKeys.get(key)!.add(groupKey(mark.other.lng, mark.other.lat));
    }
  }

  for (const [key, fact] of facts) {
    const list = headings.get(key)!;
    fact.destinations = destKeys.get(key)!.size;
    if (!list.length) continue;
    const first = list[0]!;
    const agreed = list.every((b) => Math.abs(angleDelta(first, b)) <= BEARING_TOLERANCE_DEG);
    // The mean of headings that already agree to within 20 degrees, taken the
    // only way an angle may be averaged: as offsets from one of them.
    fact.bearing = agreed
      ? (first + list.reduce((sum, b) => sum + angleDelta(first, b), 0) / list.length + 360) % 360
      : null;
  }

  const features: Feature<GeoPoint, TruckPointProps>[] = points.features.features.map((f) => {
    const fact = facts.get(f.properties.key);
    return {
      ...f,
      properties: {
        ...f.properties,
        bearing: fact?.bearing ?? 0,
        directed: fact?.bearing != null,
        unstated: fact?.unstated ?? true,
      },
    };
  });

  return {
    points,
    features: { type: "FeatureCollection", features },
    facts,
    markById,
  };
}

/**
 * "Newark, NJ · 2 trucks · 1,500 cf free" -- and every unknown said out loud.
 *
 * The unit phrase is "cf free" and never a bare "cf": the job marker two
 * hundred pixels away says "6,006 cf" and means freight on a floor, and the
 * only thing keeping a driver from reading one as the other is the word.
 */
export function truckGroupSummary(
  g: { label: string; ids: number[]; cf: number; unsized: number },
  facts: TruckGroupFacts | undefined,
): string {
  const n = g.ids.length;
  const parts = [g.label, `${n} truck${n === 1 ? "" : "s"}`];
  // A total of zero free space is not a total; it is the absence of one.
  parts.push(g.cf > 0 ? `${formatCf(g.cf)} free` : SPACE_NOT_STATED);
  if (g.cf > 0 && g.unsized > 0) {
    parts.push(`${g.unsized} space${g.unsized === 1 ? "" : "s"} not stated`);
  }
  if (facts && facts.noDestination > 0 && n > 1) {
    parts.push(`${facts.noDestination} with no destination`);
  }
  return parts.join(" · ");
}
