/**
 * Everything the UI says about a truck, in one place.
 *
 * The sibling of `./present.ts`, and separate from it for the reason the whole
 * feature is separate: a truck is not a shipment. `present.ts` knows how to
 * turn 2,000 cubic feet of freight into "≈ 1.3 truckloads"; nothing in this
 * file may ever divide free space by a truck size, because that sentence is a
 * statement about freight volume and free space is not freight.
 *
 * Pure functions over `Pick<TruckRow, …>`: no database, no session, safe in a
 * client component, testable from a script.
 *
 * Two rules run through all of it, the same two that run through `present.ts`:
 * never invent precision the post did not have -- a truck with no stated free
 * space reads SPACE_NOT_STATED, never "0 cf" -- and never print a phone.
 */

import type { LoadSummary } from "@/lib/loads/types";
import type { TruckRow, TruckStatus, TruckSummary } from "@/lib/loads/truckTypes";
import type { PublicTruckRow } from "@/lib/loads/publicView";
import { boardDay, type Tone } from "@/lib/loads/present";
import { formatCf } from "@/lib/moving/cubicFeet";

/**
 * The one string for "this post never said how much room is on the truck".
 *
 * ONE string, exported, and imported by every surface that prints it -- the
 * card, the detail, the map hover (stage 3) and the match reason (stage 4).
 * Acceptance H5 is four surfaces and one string, and the way that goes wrong is
 * a second literal typed into a fourth component. `npm run check:sums` asserts
 * this literal appears in exactly one source file.
 */
export const SPACE_NOT_STATED = "Space not stated";

/**
 * The same rule for the date. A truck whose post did not say when it leaves is
 * still a truck; "Departure not stated" is the fact, and the matcher caps such
 * a truck at Possible rather than guessing today (SPEC §9, §11).
 */
export const DEPARTURE_NOT_STATED = "Departure not stated";

/** The same rule for the lane. Never a centroid, never "Anywhere". */
export const NO_DESTINATION_STATED = "No destination stated";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sep 12" */
function shortDate(iso: string | null): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

function dayNumber(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

/** Whole days from `iso` to `todayIso` (positive = in the past). */
function daysBefore(iso: string | null, todayIso: string): number | null {
  if (!iso) return null;
  const a = dayNumber(iso);
  const b = dayNumber(todayIso);
  if (a == null || b == null) return null;
  return b - a;
}

// --- space -------------------------------------------------------------------

type SpaceTruck = Pick<TruckRow, "free_cf" | "truck_cf" | "free_source" | "truck_text">;

/**
 * "700 cf free" · "Space not stated".
 *
 * The unit phrase is "cf free", never a bare "cf", and that is deliberate at
 * the level of the string rather than the level of the layout: two different
 * quantities must never share a unit word, because the board prints them within
 * 200 px of each other and a driver scanning a column has only the word to go
 * on. `stated` is returned separately so a caller can style the unknown case
 * without re-testing `free_cf` and reaching a different answer.
 */
export function freeSpaceLabel(truck: SpaceTruck): { text: string; stated: boolean; title: string } {
  if (truck.free_cf == null) {
    return {
      text: SPACE_NOT_STATED,
      stated: false,
      title:
        truck.truck_text
          ? `The post described the truck ("${truck.truck_text}") but never said how much of it is free. A size in feet is not a size in cubic feet, so we do not convert it.`
          : "The post never said how much room is left. It is not zero — it is unknown.",
    };
  }
  const of = truck.truck_cf != null ? ` of ${formatCf(truck.truck_cf)}` : "";
  return {
    text: `${formatCf(truck.free_cf)} free`,
    stated: true,
    title:
      truck.free_source === "empty_phrase"
        ? `The post said the truck is empty${of}.`
        : `Free space as stated in the post${of}.`,
  };
}

// --- lane --------------------------------------------------------------------

type LaneTruck = Pick<
  TruckRow,
  | "origin_label"
  | "origin_city"
  | "origin_state"
  | "origin_zip"
  | "origin_precision"
  | "dest_label"
  | "dest_city"
  | "dest_state"
  | "dest_zip"
  | "dest_precision"
>;

/**
 * "NJ → FL" or, when the post never said where the truck is headed, "NJ → ?".
 *
 * The "?" is the honest glyph and it is the same one `laneLabel` already uses
 * for a job whose state could not be read. What it must never be is a state
 * picked from the notes, a compass direction, or the word "Anywhere": a driver
 * scanning the lane column is reading a promise, and a truck with no stated
 * destination has not made one.
 */
export function truckLaneLabel(truck: Pick<TruckRow, "origin_state" | "dest_state" | "dest_lat">): string {
  const to = truck.dest_lat == null ? "?" : (truck.dest_state ?? "?");
  return `${truck.origin_state ?? "?"} → ${to}`;
}

/** The label to print for one end of the leg, and whether it is approximate. */
export function truckPlaceLabel(
  truck: LaneTruck,
  side: "origin" | "dest",
): { text: string; approx: boolean; stated: boolean } {
  const origin = side === "origin";
  const label = origin ? truck.origin_label : truck.dest_label;
  const precision = origin ? truck.origin_precision : truck.dest_precision;
  const city = origin ? truck.origin_city : truck.dest_city;
  const state = origin ? truck.origin_state : truck.dest_state;
  const zip = origin ? truck.origin_zip : truck.dest_zip;

  const composed = [city && state ? `${city}, ${state}` : (city ?? state ?? ""), zip ?? ""]
    .filter(Boolean)
    .join(" ")
    .trim();

  const text = label?.trim() || composed;
  if (!text) {
    return {
      text: origin ? "Location not stated" : NO_DESTINATION_STATED,
      approx: false,
      stated: false,
    };
  }
  return { text, approx: precision === "state" || precision === "region", stated: true };
}

// --- when it leaves ----------------------------------------------------------

type WhenTruck = Pick<TruckRow, "avail_now" | "avail_from" | "avail_to" | "avail_source">;

const AVAIL_SOURCE_NOTE: Record<string, string> = {
  line: "Stated on the truck's own line",
  header: "Taken from the post's header",
  form: "Entered on the posting form",
};

/**
 * "Empty now" · "Empty from Sep 12" · "Empty Sep 12 – Sep 14" ·
 * "Departure not stated".
 *
 * "Empty", not "Ready": a job becomes ready when the furniture is on the
 * sidewalk, and a truck becomes empty when it has dropped its last load. The
 * two words are kept apart everywhere, which is also why `parseTruckSearchParams`
 * refuses `readyBy` with a 400 rather than quietly mapping it.
 */
export function departureLabel(
  truck: WhenTruck,
  todayIso: string,
): { text: string; tone: Tone; title: string | null; stated: boolean } {
  const title = truck.avail_source ? (AVAIL_SOURCE_NOTE[truck.avail_source] ?? null) : null;

  if (truck.avail_now) return { text: "Empty now", tone: "ready", title, stated: true };

  if (truck.avail_from && truck.avail_to && truck.avail_from !== truck.avail_to) {
    return {
      text: `Empty ${shortDate(truck.avail_from)} – ${shortDate(truck.avail_to)}`,
      tone: "accent",
      title,
      stated: true,
    };
  }

  const day = truck.avail_from ?? truck.avail_to;
  if (day) {
    const days = daysBefore(day, todayIso);
    if (days != null && days >= 0) return { text: "Empty now", tone: "ready", title, stated: true };
    if (days === -1) return { text: "Empty tomorrow", tone: "accent", title, stated: true };
    return { text: `Empty ${shortDate(day)}`, tone: "accent", title, stated: true };
  }

  return {
    text: DEPARTURE_NOT_STATED,
    tone: "approx",
    title:
      title ??
      "The post did not say when this truck leaves. It is not today — it is unknown, and a match on this truck can never be better than Possible.",
    stated: false,
  };
}

// --- freshness and status ----------------------------------------------------

type FreshTruck = Pick<
  TruckRow,
  "status" | "first_seen_at" | "last_seen_at" | "seen_count" | "created_at" | "expires_at"
> & { is_web?: boolean };

/**
 * How alive a truck listing is.
 *
 * A truck's lifecycle is its own (`src/lib/pipeline/trucks.ts`): it departs on
 * the day it said it would, or it runs out of its 48-hour TTL. Neither is the
 * job board's "the sender stopped mentioning it", so neither may borrow that
 * wording -- "Sender silent" about a driver who said Tuesday and drove away on
 * Tuesday would be a false accusation printed on the board.
 */
export function truckFreshness(
  truck: FreshTruck,
  now: Date,
): { text: string; tone: Tone; detail: string | null } {
  const detail =
    truck.seen_count > 1 && truck.first_seen_at
      ? `Posted ${truck.seen_count}× since ${shortDate(truck.first_seen_at.slice(0, 10))}`
      : null;

  if (truck.status === "booked") return { text: "Booked", tone: "muted", detail };
  if (truck.status === "departed") return { text: "Departed", tone: "muted", detail };
  if (truck.status === "cancelled") return { text: "Cancelled", tone: "muted", detail };
  if (truck.status === "expired") return { text: "Listing expired", tone: "muted", detail };

  const stamp = truck.last_seen_at ?? truck.created_at;
  if (!stamp) return { text: "Posted", tone: "default", detail };
  const days = daysBefore(stamp.slice(0, 10), boardDay(now));
  if (days == null) return { text: "Posted", tone: "default", detail };
  if (days <= 0) return { text: "Posted today", tone: "fresh", detail };
  if (days === 1) return { text: "Posted yesterday", tone: "default", detail };
  return { text: `Posted ${days} days ago`, tone: "muted", detail };
}

const TRUCK_STATUS_STYLE: Record<TruckStatus, { tone: Tone; label: string; title: string }> = {
  available: { tone: "ok", label: "Available", title: "The driver has not marked it otherwise" },
  booked: { tone: "muted", label: "Booked", title: "The driver filled the space" },
  departed: {
    tone: "muted",
    label: "Departed",
    title: "Its stated departure day has passed — a fact, not a guess about silence",
  },
  expired: {
    tone: "muted",
    label: "Listing expired",
    title: "No departure date was ever stated and the listing ran out after 48 hours",
  },
  cancelled: { tone: "danger", label: "Cancelled", title: "Withdrawn by the driver" },
};

export function truckStatusMeta(status: TruckStatus): { tone: Tone; label: string; title: string } {
  return TRUCK_STATUS_STYLE[status] ?? TRUCK_STATUS_STYLE.available;
}

/** "via MoverMesh" | "Marco · via NJ Movers Loads" | "Unnamed driver". */
export function driverLine(truck: Pick<PublicTruckRow, "contact_name" | "group_name" | "is_web">): string {
  if (truck.is_web) return "via MoverMesh";
  const name = truck.contact_name?.trim() || "Unnamed driver";
  return truck.group_name ? `${name} · via ${truck.group_name}` : name;
}

/** "Newark, NJ 07102 → Miami, FL · 700 cf free · Empty now" — one line, for a hover or a clipboard. */
export function truckSummaryLine(truck: LaneTruck & SpaceTruck & WhenTruck, todayIso: string): string {
  const from = truckPlaceLabel(truck, "origin");
  const to = truckPlaceLabel(truck, "dest");
  const depart = departureLabel(truck, todayIso);
  return [
    to.stated ? `${from.text} → ${to.text}` : `${from.text} · ${NO_DESTINATION_STATED}`,
    freeSpaceLabel(truck).text,
    depart.stated ? depart.text : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

// --- the board headline ------------------------------------------------------

/**
 * The board's two headlines, and the reason this function exists at all.
 *
 * IT RETURNS TWO STRINGS AND IT IS STRUCTURALLY INCAPABLE OF ADDING ITS
 * ARGUMENTS. `LoadSummary` carries `totalCf` and `TruckSummary` carries
 * `totalFreeCf`; the two interfaces share no name that carries a volume, so
 * `jobs.totalCf + trucks.totalFreeCf` is something a person has to type on
 * purpose, in a file where `npm run check:sums` will see both words on one line
 * and fail.
 *
 * Why it matters more than it looks: `98 jobs · 42,506 cf` is the first thing
 * on the board and the number the whole product's credibility sits on. One
 * forgotten predicate under a single-table design turned it into
 * `104 listings · 49,506 cf` -- plausible, wrong, and observable by no test.
 * Here there is no arithmetic to forget.
 *
 * `truckLine` is null when there are no trucks, and that is not an oversight
 * about the empty state: "0 trucks" is a sentence about absence that the tab
 * label already carries, and printing it under the job count on day one would
 * make the board's opening statement an apology (SPEC §2).
 *
 * Note what is NOT here: `truckLine()` from present.ts, the "≈ 28.3 truckloads"
 * line. That divides a volume of freight by the size of a truck; doing it to a
 * count of free space would print "how many trucks fit in your trucks". It
 * belongs to `jobLine` only, its caller is the job header, and acceptance H2
 * scans the source to keep it there.
 */
export interface BoardHeadline {
  /** Always present: the board's freight statement. Never mentions trucks. */
  jobLine: string;
  /** Null when no trucks matched. Never mentions freight. */
  truckLine: string | null;
}

export function boardHeadline(jobs: LoadSummary, trucks: TruckSummary | null): BoardHeadline {
  const jobLine = `${jobs.count.toLocaleString("en-US")} ${jobs.count === 1 ? "job" : "jobs"}${
    jobs.totalCf > 0 ? ` · ${formatCf(jobs.totalCf)}` : ""
  }`;

  if (!trucks || trucks.count === 0) return { jobLine, truckLine: null };

  return {
    jobLine,
    truckLine: `${trucks.count.toLocaleString("en-US")} ${
      trucks.count === 1 ? "truck" : "trucks"
    }${trucks.totalFreeCf > 0 ? ` · ${formatCf(trucks.totalFreeCf)} free` : ""}`,
  };
}

/**
 * The truck headline's quiet second line: what the set looks like, in the
 * truck's own vocabulary.
 *
 * Every clause is omitted rather than printed as a zero, for the same reason
 * the job line omits the median when there is nothing to take a median over.
 * "1 without a stated size" is the one clause that is a CAVEAT rather than a
 * statistic, so it survives to the narrow layouts where the others do not.
 */
export function truckSubline(trucks: TruckSummary): {
  departing: string | null;
  unsized: string | null;
  noDest: string | null;
  swing: string | null;
} {
  const unsized = trucks.count - trucks.withFreeCf;
  return {
    departing: trucks.departingToday > 0 ? `${trucks.departingToday} departing today` : null,
    unsized: unsized > 0 ? `${unsized} without a stated size` : null,
    noDest: trucks.noDestination > 0 ? `${trucks.noDestination} with no stated destination` : null,
    swing:
      trucks.medianCorridorMiles != null
        ? `median swing ${Math.round(trucks.medianCorridorMiles)} mi`
        : null,
  };
}

/** The client-side fallback summary, for a partial or failed truck response. */
export function summarizeTrucks(rows: PublicTruckRow[], now: Date): TruckSummary {
  const today = boardDay(now);
  let totalFreeCf = 0;
  let withFreeCf = 0;
  let departingToday = 0;
  let noDestination = 0;
  const swings: number[] = [];
  for (const t of rows) {
    if (t.free_cf != null) {
      totalFreeCf += t.free_cf;
      withFreeCf += 1;
    }
    if (t.avail_now || (t.avail_from != null && t.avail_from <= today)) departingToday += 1;
    if (t.dest_lat == null) noDestination += 1;
    swings.push(t.corridor_miles);
  }
  swings.sort((a, b) => a - b);
  return {
    count: rows.length,
    totalFreeCf,
    withFreeCf,
    departingToday,
    noDestination,
    // Not computable in the browser: the server measures it against last_seen_at
    // over the whole filtered set, and a zero here would read as a claim.
    freshToday: 0,
    medianCorridorMiles: swings.length ? swings[Math.floor((swings.length - 1) / 2)] : null,
  };
}
