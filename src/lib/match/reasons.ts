/**
 * Every sentence the matcher says, composed once.
 *
 * The board, the truck panel, the form preview and (stage 5) the notification
 * cron all print these strings, and they print the SAME strings, byte for byte.
 * A notification that describes a match differently from the page it links to
 * is untrusted twice: once for the mismatch, and once more for whichever of the
 * two the reader decides was the lie.
 *
 * Every clause is a number from a column or an explicit statement of absence.
 * No adjectives, no percentages of confidence, no "great fit". A driver is
 * about to spend a phone call on this; the page owes them the arithmetic, not
 * an opinion about it.
 *
 * Pure -- no database, no clock, no network, no React. SPEC 11.8.
 */
import { formatMiles } from "@/lib/geo/math";
import { formatCf } from "@/lib/moving/cubicFeet";
import { MILES_PER_DRIVING_DAY } from "./constants";
import type { MatchFacts, MatchResult, RefusalCode, Unknown } from "./types";
import { REFUSAL_ORDER } from "./types";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Thu 11 Sep" from an ISO date, with no timezone anywhere near it. */
export function dayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return `${WEEKDAYS[dow]} ${d} ${MONTHS[mo - 1]}`;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

// --- the four clauses, in SPEC 11.8's fixed order ----------------------------

/**
 * 1. Geometry.
 *
 * Radius mode gets a sentence and not a number, and it always comes first: a
 * driver reading "22 mi from where you'll be empty" without it would assume the
 * board had checked the direction. It had nothing to check.
 */
export function geometryClause(f: MatchFacts): string {
  if (f.off_route_miles == null) {
    return "no destination on your truck — this load is near you, not on a route";
  }
  // A pickup on the line reads "on your route", not "0.0 mi off your route".
  // The same rule as the detour clause below, for the same reason: a rounded
  // zero is a sentence, not a measurement, and printing it as a number invites
  // the reader to wonder what the tenth of a mile was.
  if (f.off_route_miles < 0.5) return "on your route";
  return `${formatMiles(f.off_route_miles)} off your route`;
}

/**
 * 2. Driving.
 *
 * The detour is printed as whole miles, so "rounds to 0" and "prints 0" are the
 * same event: a tenth of a mile of extra driving is no extra driving, and
 * "+0 mi detour" would be a number pretending to be a measurement.
 */
export function drivingClause(f: MatchFacts): string {
  if (f.detour_miles == null) {
    return `${formatMiles(f.origin_to_pickup_miles)} from where you'll be empty`;
  }
  const miles = Math.round(f.detour_miles);
  return miles === 0 ? "no extra driving" : `+${miles} mi detour`;
}

/** 3. Size. Never the word "fits" -- the two numbers, and whose is whose. */
export function sizeClause(f: MatchFacts): string {
  if (f.job_cf != null && f.free_cf != null) {
    return `${formatCf(f.job_cf)} into your ${formatCf(f.free_cf)} free`;
  }
  if (f.job_cf != null) return `${formatCf(f.job_cf)}, your free space not stated`;
  if (f.free_cf != null) return `size not stated, your ${formatCf(f.free_cf)} free`;
  return "size not stated on either side";
}

/**
 * 4. Dates.
 *
 * When the truck stated no departure, no date is printed at all. Today was
 * assumed to run the gates -- that assumption is honest as a *refusal* ("you
 * have already driven past") and dishonest as a promise, so the clause says
 * what is missing instead of dressing the assumption up as a calendar.
 */
export function dateClause(f: MatchFacts, unknowns: readonly Unknown[]): string {
  const noTruckDate = unknowns.includes("truck_depart_date");
  const noJobDate = unknowns.includes("job_ready_date");
  if (noTruckDate && noJobDate) return "no dates stated on either side";
  if (noTruckDate) return "no departure date on your truck";
  if (f.load_day == null || f.deliver_day == null) return "no dates stated on either side";

  const base = `loads ${dayLabel(f.load_day)}, delivers ${dayLabel(f.deliver_day)}`;
  if (f.slack_days == null) return base;
  if (f.slack_days === 0) return `${base} — on its deadline`;
  return `${base} — ${f.slack_days} ${plural(f.slack_days, "day", "days")} before its deadline`;
}

/**
 * 5. The wait, when there is one.
 *
 * SPEC 11.8 lists this as an alternative form of the date clause. It is
 * appended instead: a driver who would arrive on the 11th and sit until the
 * 14th needs BOTH facts, and replacing the dates with the wait throws away the
 * one the calendar is planned against.
 */
export function waitClause(f: MatchFacts): string | null {
  if (f.wait_days == null || f.wait_days <= 0) return null;
  return `you'd wait ${f.wait_days} ${plural(f.wait_days, "day", "days")} for it to be ready`;
}

/** The whole line, joined with " · " by the caller. */
export function buildReasons(f: MatchFacts, unknowns: readonly Unknown[]): string[] {
  const out = [geometryClause(f), drivingClause(f), sizeClause(f), dateClause(f, unknowns)];
  const wait = waitClause(f);
  if (wait) out.push(wait);
  return out;
}

/**
 * Where the mileage behind the dates came from, printed ONCE per page the way
 * `truckLine` names its 1,500 cf divisor. It is deliberately not part of
 * `reasons`: repeated on every row it becomes wallpaper, and a per-row suffix
 * would make the two directions of the same pair disagree (acceptance M15).
 */
export function basisNote(basis: MatchFacts["basis"]): string {
  return basis === "road"
    ? "Dates use the cached road distance for this lane."
    : `Dates are a straight-line estimate at ${MILES_PER_DRIVING_DAY} mi/day.`;
}

/** What was never stated, in words, for the chip under a Possible match. */
export const UNKNOWN_LABELS: Record<Unknown, string> = {
  job_size: "size not stated on the job",
  truck_free_space: "free space not stated on the truck",
  job_ready_date: "no ready date on the job",
  truck_depart_date: "no departure date on the truck",
  truck_destination: "no destination on the truck",
};

/** The standing caveat beside every match list on a truck. SPEC 11.5. */
export const SIZE_CAVEAT =
  "Cubic feet is the only size either side states. Whether a piece physically goes through your " +
  "door, and whether the payload is within your weight rating, is your call.";

/** The admission that service matching is doing almost nothing. SPEC 11.6. */
export const SERVICE_THIN_NOTE =
  "Only 17 of 98 jobs on this board state a requirement and none carry a service tag, so service " +
  "matching is doing almost nothing yet. It gets better as posts get richer.";

/** The admission that the deadline gate cannot fire. SPEC 11.5. */
export const DEADLINE_INERT_NOTE =
  "No job on this board states a delivery deadline, so deadlines weren't checked.";

// --- the refusal histogram ---------------------------------------------------

/**
 * Which side of the pair is being looked at. The refusals are the same gates
 * either way; the sentences are not, because "your route" and "their route" are
 * different claims and only one of them is true on a given page.
 */
export type MatchSide = "truck" | "job";

export interface HistogramContext {
  /** The anchor truck's stated free space, for "bigger than your 700 cf free". */
  freeCf?: number | null;
  /** The anchor job's stated size, for the mirror. */
  jobCf?: number | null;
  /** The anchor truck stated no destination, so it is "near you", not "near your route". */
  radius?: boolean;
}

/**
 * Refusals that are about the ANCHOR rather than about the candidates.
 *
 * If the truck is not available, every job on the board fails gate 1 for the
 * same reason, and a histogram reading "98 were no longer listed" would blame
 * the board for the reader's own listing. These get one sentence instead.
 */
const ANCHOR_REFUSALS: Record<MatchSide, Partial<Record<RefusalCode, string>>> = {
  truck: {
    truck_not_available: "This truck is no longer listed as available, so nothing is matched to it.",
    no_truck_origin: "This truck has no location on it, so there is nothing to match from.",
  },
  job: {
    job_not_available: "This job is no longer listed, so nothing is matched to it.",
    no_job_pickup: "This job has no pickup location on it, so there is nothing to match from.",
    no_job_delivery:
      "This job says where to pick up but not where to deliver, so there is no direction to match against.",
  },
};

function truckSideClause(code: RefusalCode, n: number, ctx: HistogramContext): string | null {
  const were = `${n} ${plural(n, "was", "were")}`;
  switch (code) {
    case "job_not_available":
      return `${were} no longer listed`;
    case "same_party":
      return `${were} your own`;
    case "no_job_pickup":
      return `${n} did not say where to pick up`;
    case "no_job_delivery":
      return `${n} did not say where to deliver`;
    case "pickup_off_corridor":
      return ctx.radius ? `${were} not near you` : `${were} not near your route`;
    case "delivery_off_corridor":
      return `${were} dropping too far off your route`;
    case "wrong_direction":
      return `${were} going the wrong way`;
    case "detour_too_far":
      return `${were} too far out of your way`;
    case "too_big":
      return ctx.freeCf != null
        ? `${were} bigger than your ${formatCf(ctx.freeCf)} free`
        : `${were} bigger than your free space`;
    case "not_ready_in_time":
      return `${n} would not be ready before you drive past`;
    case "deadline_missed":
      return `${n} could not be delivered by ${plural(n, "its", "their")} deadline`;
    case "dismissed":
      return `${n} you dismissed`;
    default:
      return null;
  }
}

function jobSideClause(code: RefusalCode, n: number, ctx: HistogramContext): string | null {
  const were = `${n} ${plural(n, "was", "were")}`;
  switch (code) {
    case "truck_not_available":
      return `${were} no longer available`;
    case "same_party":
      return `${were} your own`;
    case "no_truck_origin":
      return `${n} did not say where they will be`;
    case "pickup_off_corridor":
      return `${were} not running near this pickup`;
    case "delivery_off_corridor":
      return `${n} would be dropping too far off their route`;
    case "wrong_direction":
      return `${were} going the other way`;
    case "detour_too_far":
      return `${were} too far out of their way`;
    case "too_big":
      return ctx.jobCf != null
        ? `${n} had no room for ${formatCf(ctx.jobCf)}`
        : `${n} had no room for it`;
    case "not_ready_in_time":
      return `${n} would drive past before it is ready`;
    case "deadline_missed":
      return `${n} could not make the delivery deadline`;
    case "dismissed":
      return `${were} dismissed by their owner`;
    default:
      return null;
  }
}

/**
 * The histogram, gate by gate, in the order the gates run.
 *
 * Ordered by the gates and not by count, deliberately: the same board answers
 * the same way twice running, and a reader comparing two trucks is comparing
 * two lists in the same order rather than re-reading which line moved.
 */
export function refusalClauses(
  refusals: Partial<Record<RefusalCode, number>>,
  side: MatchSide,
  ctx: HistogramContext = {},
): string[] {
  const out: string[] = [];
  for (const code of REFUSAL_ORDER) {
    if (ANCHOR_REFUSALS[side][code]) continue;
    const n = refusals[code] ?? 0;
    if (n <= 0) continue;
    const clause = side === "truck" ? truckSideClause(code, n, ctx) : jobSideClause(code, n, ctx);
    if (clause) out.push(clause);
  }
  return out;
}

export interface EmptyMatchCopy {
  headline: string;
  /** The histogram. Empty when the anchor itself is the reason. */
  clauses: string[];
  /** What to ask for, when there is nothing to explain. */
  ask: string | null;
}

/**
 * What an empty match list says.
 *
 * Three different silences, and telling them apart is the whole point:
 *
 *   nothing on the board  -- ask for supply; there is nothing to explain yet
 *   the anchor is at fault -- one sentence about this listing
 *   candidates were refused -- the histogram, gate by gate
 *
 * "No matches" on its own is the screen that teaches a driver the board does
 * not work. SPEC 2, SPEC 11.8, acceptance M18.
 */
export function emptyMatchCopy(
  result: Pick<MatchResult<unknown>, "refusals" | "candidates">,
  side: MatchSide,
  ctx: HistogramContext = {},
): EmptyMatchCopy {
  if (result.candidates === 0) {
    return side === "truck"
      ? {
          headline: "No jobs are listed on this lane yet.",
          clauses: [],
          ask: "Nothing on the board runs anywhere near this leg today. It is worth looking again tomorrow — the board turns over daily.",
        }
      : {
          headline: "No trucks are listed for this lane yet.",
          clauses: [],
          ask: "Driving this way empty? Post the leg — it takes about a minute and dispatchers on this board will see it.",
        };
  }

  for (const [code, sentence] of Object.entries(ANCHOR_REFUSALS[side]) as Array<
    [RefusalCode, string]
  >) {
    if ((result.refusals[code] ?? 0) > 0) {
      return { headline: sentence, clauses: [], ask: null };
    }
  }

  return {
    headline:
      side === "truck" ? "No jobs fit this truck right now." : "No trucks could take this right now.",
    clauses: refusalClauses(result.refusals, side, ctx),
    ask: null,
  };
}
