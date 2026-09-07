/**
 * What a match is, and what it takes to decide one.
 *
 * The two INPUT shapes are `Pick`ed off `LoadRow` and `TruckRow` rather than
 * written out again. `evaluateMatch` is pure and takes no database, but it must
 * not be free to drift from the columns it is judging: if `free_cf` is ever
 * renamed, a hand-copied field list keeps compiling and starts refusing every
 * truck for having no stated space. These are `import type`, erased at compile
 * time, so the runtime import graph acceptance M14 scans stays clean.
 *
 * SPEC 11.1.
 */
import type { LoadRow } from "@/lib/loads/types";
import type { TruckRow } from "@/lib/loads/truckTypes";

/**
 * Why a pair is not a match. First failure wins; the caller gets a histogram of
 * these and prints it, because "no matches" with no reason is the screen that
 * makes a driver stop opening the page.
 */
export type RefusalCode =
  | "truck_not_available"
  | "job_not_available"
  | "same_party"
  | "no_truck_origin"
  | "no_job_pickup"
  | "no_job_delivery"
  | "pickup_off_corridor"
  | "delivery_off_corridor"
  | "wrong_direction"
  | "detour_too_far"
  | "too_big"
  | "not_ready_in_time"
  | "deadline_missed"
  | "dismissed";

/**
 * The gates, in the order `evaluateMatch` applies them. Exported because the
 * histogram renders in this order and the eval suite walks it: a code that
 * exists and is never reachable, or a gate with no code, fails loudly.
 */
export const REFUSAL_ORDER: readonly RefusalCode[] = [
  "truck_not_available",
  "job_not_available",
  "same_party",
  "no_truck_origin",
  "no_job_pickup",
  "no_job_delivery",
  "pickup_off_corridor",
  "delivery_off_corridor",
  "wrong_direction",
  "detour_too_far",
  "too_big",
  "not_ready_in_time",
  "deadline_missed",
  "dismissed",
];

/**
 * Two bands, not three. A driver acts on *worth a call* or *worth a look*; a
 * middle band is a hedge that means neither.
 */
export type MatchTier = "strong" | "possible";

/**
 * A fact neither side stated. One of these anywhere caps the match at Possible
 * for ever -- that single rule is the whole of what makes the Strong badge
 * worth reading. SPEC 11.7.
 */
export type Unknown =
  | "job_size"
  | "truck_free_space"
  | "job_ready_date"
  | "truck_depart_date"
  | "truck_destination";

/** Declaration order, so `unknowns` is stable across runs (acceptance M16). */
export const UNKNOWN_ORDER: readonly Unknown[] = [
  "job_size",
  "truck_free_space",
  "job_ready_date",
  "truck_depart_date",
  "truck_destination",
];

/**
 * Every quantity the reason clauses print, unrounded.
 *
 * The three route numbers are `null` in radius mode -- a truck with no stated
 * destination has no route to be off, and a zero there would read as "right on
 * your line". Absence is spelled `null` and printed as a sentence.
 */
export interface MatchFacts {
  /** How far the pickup sits off the truck's line. Null in radius mode. */
  off_route_miles: number | null;
  /** Extra driving the job costs over the bare leg. Null in radius mode. */
  detour_miles: number | null;
  /** Where along the leg the pickup falls, 0..1. Null in radius mode. */
  route_progress: number | null;
  /** The truck's own leg, straight line. Null in radius mode. */
  leg_miles: number | null;
  /** Truck origin -> job pickup, straight line. Always known: G4 and G5 passed. */
  origin_to_pickup_miles: number;
  job_cf: number | null;
  free_cf: number | null;
  /** job_cf / free_cf. Null unless both are stated -- never a filled-in middle. */
  fill_pct: number | null;
  /** ISO date the truck could load it. Null when the truck stated no departure. */
  load_day: string | null;
  deliver_day: string | null;
  /** Days the driver would sit waiting for the freight to be ready. */
  wait_days: number | null;
  /** Days between the estimated delivery and the job's deadline. Null when none. */
  slack_days: number | null;
  /** The truck stated no departure window, so today was assumed for the gates. */
  dates_assumed: boolean;
  /** Whether `loads.road_miles` was already cached. Never fetched to find out. */
  basis: "road" | "estimate";
}

export type MatchVerdict =
  | { ok: false; refusal: RefusalCode }
  | {
      ok: true;
      tier: MatchTier;
      /**
       * NEVER RENDERED. It orders matches inside a tier and nothing else: a
       * printed "82" invites belief proportional to its precision, and this is
       * a weighted opinion about six quantities, three of them estimates. It is
       * on the wire for the eval suite and the admin console.
       */
      score: number;
      facts: MatchFacts;
      unknowns: Unknown[];
      /** The one-line explanation, clause by clause, in SPEC 11.8's order. */
      reasons: string[];
      /** The job's `requirements` string, verbatim. Never scored, never gated. */
      requirements: string | null;
    };

export type MatchOk = Extract<MatchVerdict, { ok: true }>;

export interface MatchResult<T> {
  matches: Array<{ item: T; verdict: MatchOk }>;
  /** Every gate that refused, and how many times. The empty state prints it. */
  refusals: Partial<Record<RefusalCode, number>>;
  candidates: number;
  truncated: boolean;
  /**
   * Gates that cannot fire today, said out loud rather than left looking like
   * passed tests. `service` is always "thin" (SPEC 11.6); `deadline` is "inert"
   * when no candidate job states one.
   */
  gates: { service: "thin"; deadline: "inert" | "live" };
}

/**
 * What the posting form shows while a driver is still typing: counts, and the
 * same refusal histogram the panels print.
 *
 * Here rather than beside `previewMatches` in `run.ts` so the form can import
 * the shape without `@/lib/db` appearing anywhere near a client bundle.
 */
export interface MatchPreview {
  strong: number;
  possible: number;
  total: number;
  candidates: number;
  truncated: boolean;
  refusals: Partial<Record<RefusalCode, number>>;
  gates: { service: "thin"; deadline: "inert" | "live" };
}

/**
 * The truck, as the decision sees it. A `Pick`, so a renamed column is a
 * compile error rather than a silent behaviour change.
 */
export type MatchTruck = Pick<
  TruckRow,
  | "id"
  | "status"
  | "visibility"
  | "sender_key"
  | "posted_by"
  | "origin_lat"
  | "origin_lng"
  | "dest_lat"
  | "dest_lng"
  | "corridor_miles"
  | "free_cf"
  | "avail_now"
  | "avail_from"
  | "avail_to"
>;

/**
 * The job, as the decision sees it.
 *
 * `road_miles` is NOT on `LoadRow`: the column exists in db/schema.sql and is
 * read by `roadDistance.ts`, and the board's `SELECT_COLUMNS` -- frozen for
 * this feature -- does not select it. The candidate query selects it by name,
 * and the matcher prefers it over the straight-line estimate when it is there.
 * It is never FETCHED: matching must not make a billable HERE call, ever.
 */
export type MatchJob = Pick<
  LoadRow,
  | "id"
  | "status"
  | "sender_key"
  | "posted_by"
  | "pickup_lat"
  | "pickup_lng"
  | "delivery_lat"
  | "delivery_lng"
  | "cubic_feet"
  | "ready_now"
  | "ready_date"
  | "deliver_by"
  | "requirements"
> & { road_miles: number | null };
