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
import type { MapEnd } from "@/lib/loads/types";
import type { PublicLoadRow } from "@/lib/loads/publicView";
import { endLabelText, endPoint } from "./points";

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

// `truckMarks(rows, end)` lands with the map's truck source. It is the same
// shape with `kind: "truck"`, `cf: free_cf`, a bearing, and -- the rule that
// makes the Deliveries view honest -- NO mark at all for a truck with no
// stated destination, because a vehicle drawn at a centroid on a map of
// arrivals is an invention.
