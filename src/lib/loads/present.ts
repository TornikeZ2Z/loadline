/**
 * Everything the UI says about a job, in one place.
 *
 * The split with `@/lib/moving/cubicFeet` is deliberate and load-bearing:
 * that module is arithmetic (what is 2,000 cf at $3.75?), this one is language
 * and tone (does that read as "Ready now" green or "Not ready yet" grey?).
 * Keeping them apart means no name exists in two files and the numeric helpers
 * stay usable from the server, the scripts and the eval.
 *
 * Pure functions over `Pick<LoadRow, …>`: unit-testable without a database, and
 * safe to import from any client component.
 *
 * Two rules run through all of it. Never invent precision the post did not have
 * -- a job with no size reads "Size not stated", not "0 cf", and a destination
 * resolved only to a state says so. And never print a phone: `maskPhones` is
 * re-exported here as a second pass over text the server already masked.
 */

import type { LoadRow, SortKey } from "@/lib/loads/types";
import type { PublicLoadRow } from "@/lib/loads/publicView";
import { DEFAULT_TZ } from "@/lib/extract/dates";
import {
  TRUCK_CF,
  CF_PRESETS,
  formatCf,
  jobPrice,
  pricePerCf,
  isReady,
} from "@/lib/moving/cubicFeet";
import { redactPhones } from "@/lib/loads/redact";

export { TRUCK_CF, CF_PRESETS, formatCf };

/** A second line of defence in the DOM; the server already masked everything. */
export const maskPhones = redactPhones;

export type Tone =
  | "default"
  | "accent"
  | "ok"
  | "ready"
  | "fresh"
  | "warn"
  | "review"
  | "approx"
  | "danger"
  | "muted";

// --- small date helpers ------------------------------------------------------
// ISO dates are compared and formatted by hand: `new Date("2026-09-12")` is
// UTC midnight, which renders as Sep 11 for anyone west of Greenwich.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * What day it is on the board's calendar -- the one date every "today" in the
 * UI has to be measured against.
 *
 * `new Date().toISOString().slice(0, 10)` is UTC by specification, whatever the
 * viewer's locale, so from 20:00 Eastern to midnight it already reads tomorrow:
 * a job that is not ready until tomorrow rendered the green "Ready now" chip,
 * and the header's count (taken from the server's calendar) contradicted the
 * chips underneath it. Every client-side today comes through here instead.
 *
 * Next only inlines NEXT_PUBLIC_ variables into the browser bundle, so on the
 * client `DEFAULT_TZ` is always the America/New_York default: moving the board
 * to another zone means publishing the zone, not just setting LOAD_TZ.
 */
export function boardDay(at: Date): string {
  // en-CA formats as YYYY-MM-DD, which is what every comparison here expects.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function dayNumber(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

/** "Sep 12" */
function shortDate(iso: string | null): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

/** Whole days from `iso` to `todayIso` (positive = in the past). */
function daysBefore(iso: string | null, todayIso: string): number | null {
  if (!iso) return null;
  const a = dayNumber(iso);
  const b = dayNumber(todayIso);
  if (a == null || b == null) return null;
  return b - a;
}

function money(n: number): string {
  return n >= 100
    ? `$${Math.round(n).toLocaleString("en-US")}`
    : `$${n.toFixed(2).replace(/\.00$/, "")}`;
}

// --- place and lane ----------------------------------------------------------

type PlaceJob = Pick<
  LoadRow,
  | "pickup_label"
  | "pickup_city"
  | "pickup_state"
  | "pickup_zip"
  | "pickup_precision"
  | "delivery_label"
  | "delivery_city"
  | "delivery_state"
  | "delivery_zip"
  | "delivery_precision"
>;

/**
 * The two precisions that are not a real place: the coordinate is a state or
 * region centroid, chosen because the post never named a city.
 *
 * One definition, because three surfaces test it — the label's `approx` flag,
 * the "approximate location" chip, and the distance caveat below — and they
 * must never disagree about which end of a job is a guess.
 */
export function isApproxPlace(precision: string | null | undefined): boolean {
  return precision === "state" || precision === "region";
}

/** "NJ → FL" — the two-letter lane, which is how these posts are scanned. */
export function laneLabel(job: Pick<LoadRow, "pickup_state" | "delivery_state">): string {
  return `${job.pickup_state ?? "?"} → ${job.delivery_state ?? "?"}`;
}

/**
 * The label to print for one end of the route, and whether it is only
 * approximate.
 *
 * The stored label is what the sender wrote, normalized, and is preferred --
 * "FL 33180" is a real destination in this trade even though it names no city.
 * The composed fallback exists for rows whose label never made it (a website
 * post with only a state, say), and deliberately stops at what is known rather
 * than guessing a city.
 */
export function placeLabel(
  job: PlaceJob,
  side: "pickup" | "delivery",
): { text: string; approx: boolean } {
  const pickup = side === "pickup";
  const label = pickup ? job.pickup_label : job.delivery_label;
  const precision = pickup ? job.pickup_precision : job.delivery_precision;
  const city = pickup ? job.pickup_city : job.delivery_city;
  const state = pickup ? job.pickup_state : job.delivery_state;
  const zip = pickup ? job.pickup_zip : job.delivery_zip;

  const composed = [city && state ? `${city}, ${state}` : (city ?? state ?? ""), zip ?? ""]
    .filter(Boolean)
    .join(" ")
    .trim();

  return {
    text: label?.trim() || composed || "Location not stated",
    approx: isApproxPlace(precision),
  };
}

/**
 * Why a distance measured between these ends cannot be stated to the mile.
 *
 * Deliberately NOT the same statement as "no road route was returned". Those
 * are two different failures and the brief asks for them kept apart: a job with
 * two exact ZIPs can still have no route (the provider was down), and a job with
 * a perfect HERE route can still be measured to the middle of South Carolina
 * because that is all the post gave. So this returns only the caveat, and the
 * caller keeps its own "by road / straight line / not available" ladder — the
 * two compose, in any of the four combinations.
 *
 * `span` says which ends the number spans: a viewer-to-pickup leg never touches
 * the delivery, so a vague delivery must not cast doubt on it.
 */
export function distanceCaveat(
  job: Pick<LoadRow, "pickup_precision" | "delivery_precision">,
  span: "trip" | "toPickup",
): { note: string; title: string } | null {
  const pickup = isApproxPlace(job.pickup_precision);
  const delivery = span === "trip" && isApproxPlace(job.delivery_precision);
  if (!pickup && !delivery) return null;

  const which = pickup && delivery ? "both ends" : pickup ? "the pickup" : "the delivery";
  return {
    note:
      pickup && delivery
        ? "between two approximate points"
        : pickup
          ? "from an approximate pickup"
          : "to an approximate delivery",
    title: `The post did not name a city, so ${which} sits on a state centroid rather than an address. The distance is measured to that point — treat it as a rough figure, not a route you can plan on.`,
  };
}

// --- price -------------------------------------------------------------------

type PricedJob = Pick<LoadRow, "price_per_cf" | "price_flat" | "cubic_feet">;

/**
 * What a job with no price says, on every surface that says anything.
 *
 * ONE STRING, and that is the decision rather than an accident of refactoring.
 * The card used to read "Price not stated" and the detail "Not stated -- ask the
 * sender", which was defensible per-surface wording and turned out to be the
 * wrong trade: 96 of 98 live jobs are unpriced, so a driver meets this fact
 * dozens of times per session and reads two different sentences for it. The CTO
 * chose the CEO's wording and chose it for both places.
 *
 * "Not provided" is a claim about the POST, which is the only thing we know --
 * unlike "No price", which can be read as a claim about the JOB, as in "this
 * one pays nothing". What it must never become is "Negotiable", "Make offer" or
 * "Auction": those are three real business states a sender can be in, and we
 * have no evidence for any of them.
 *
 * It is longer than the card's old string, and the card was given room for it
 * rather than the string being trimmed to fit -- see the price row in
 * LoadViews.tsx.
 */
export const PRICE_NOT_PROVIDED = "Price not provided";

/**
 * "$3.75/cf" + "est. $7,500", or "$1,500 flat" + "$5.00/cf", or
 * `PRICE_NOT_PROVIDED`.
 *
 * Movers quote per cubic foot, so that is the headline whenever the post gave
 * one; the estimated total is the derived number and stays subordinate, always
 * prefixed "est." so a figure we calculated is never read as one the sender
 * quoted. When only a flat price exists the two swap, because the per-cf figure
 * is then ours, not the sender's.
 */
export function formatPrice(job: PricedJob): { headline: string; sub: string | null; tone: Tone } {
  if (job.price_per_cf != null) {
    const total = jobPrice(job);
    return {
      headline: `${money(job.price_per_cf)}/cf`,
      sub: total != null ? `est. ${money(total)}` : "size not stated",
      tone: "ok",
    };
  }
  if (job.price_flat != null) {
    const perCf = pricePerCf(job);
    return {
      headline: `${money(job.price_flat)} flat`,
      sub: perCf != null ? `${money(perCf)}/cf` : null,
      tone: "ok",
    };
  }
  return { headline: PRICE_NOT_PROVIDED, sub: null, tone: "muted" };
}

/**
 * "$3.38/cf" — a bare rate, for the board header's median.
 *
 * Its caller must print it beside the count it was taken over: two of 98 jobs
 * carry a price today, and "median $3.38/cf" on its own would read as the going
 * rate on this board when it is the midpoint of two numbers.
 */
export function formatRate(perCf: number): string {
  return `${money(perCf)}/cf`;
}

// --- ready / deliver by ------------------------------------------------------

type ReadyJob = Pick<LoadRow, "ready_now" | "ready_date" | "ready_source">;

const READY_SOURCE_NOTE: Record<string, string> = {
  line: "Stated on the job's own line",
  header: "Taken from the post's header",
  footer: "Taken from the post's footer",
  title: "Taken from the post's title",
  assumed: "No ready marker in the post; assumed available — confirm on the call",
};

/**
 * "Ready now" · "Ready tomorrow" · "Ready Sep 12" · "Not ready yet".
 *
 * "Not ready yet" is the honest reading of a job on a post where OTHER lines
 * carried an RFD marker and this one did not: the sender distinguished them, so
 * we do too rather than rounding everything up to available.
 */
export function readyLabel(
  job: ReadyJob,
  todayIso: string,
): { text: string; tone: Tone; title: string | null } {
  const title = job.ready_source ? (READY_SOURCE_NOTE[job.ready_source] ?? null) : null;
  if (isReady(job, todayIso)) return { text: "Ready now", tone: "ready", title };
  if (job.ready_date) {
    const days = daysBefore(job.ready_date, todayIso);
    if (days === -1) return { text: "Ready tomorrow", tone: "accent", title };
    return { text: `Ready ${shortDate(job.ready_date)}`, tone: "accent", title };
  }
  return {
    text: "Not ready yet",
    tone: "muted",
    title: title ?? "The sender marked other jobs ready but not this one",
  };
}

/** "Deliver by Sep 20", warn tone inside three days. Null when the post gave none. */
export function deliverByLabel(
  job: Pick<LoadRow, "deliver_by">,
  todayIso: string,
): { text: string; tone: Tone } | null {
  if (!job.deliver_by) return null;
  const days = daysBefore(job.deliver_by, todayIso);
  const urgent = days != null && days >= -3;
  return { text: `Deliver by ${shortDate(job.deliver_by)}`, tone: urgent ? "warn" : "default" };
}

// --- freshness ---------------------------------------------------------------

type FreshJob = Pick<
  LoadRow,
  | "status"
  | "first_seen_at"
  | "last_seen_at"
  | "seen_count"
  | "relist_count"
  | "delisted_at"
  | "created_at"
> & { is_web?: boolean };

/**
 * How alive a job is. The lifecycle is the product's main claim -- a sender's
 * newest post is the truth, and anything it omits goes quiet -- so this string
 * is the one a driver reads before deciding to spend a call on it.
 *
 * A website post has no sender re-posting it daily, so "last seen" would be
 * meaningless: it reads from `created_at` and says "Posted today" instead.
 */
export function freshnessLabel(
  job: FreshJob,
  now: Date,
): { text: string; tone: Tone; detail: string | null } {
  let detail: string | null = null;
  if (job.seen_count > 1 && job.first_seen_at) {
    detail = `Posted ${job.seen_count}× since ${shortDate(job.first_seen_at.slice(0, 10))}`;
  }
  if (job.relist_count > 0) detail = detail ? `Relisted · ${detail}` : "Relisted";

  if (job.status === "taken") return { text: "Taken", tone: "muted", detail };
  if (job.status === "delisted") {
    return {
      text: job.delisted_at ? `Delisted ${shortDate(job.delisted_at.slice(0, 10))}` : "Delisted",
      tone: "muted",
      detail,
    };
  }
  if (job.status === "expired") {
    return {
      text: job.last_seen_at
        ? `Sender silent since ${shortDate(job.last_seen_at.slice(0, 10))}`
        : "Sender silent",
      tone: "muted",
      detail,
    };
  }

  const verb = job.is_web ? "Posted" : "Listed";
  const stamp = job.is_web ? (job.created_at ?? job.last_seen_at) : (job.last_seen_at ?? job.created_at);
  if (!stamp) return { text: verb, tone: "default", detail };
  const days = daysBefore(stamp.slice(0, 10), boardDay(now));
  if (days == null) return { text: verb, tone: "default", detail };
  if (days <= 0) return { text: `${verb} today`, tone: "fresh", detail };
  if (days === 1) return { text: `${verb} yesterday`, tone: "default", detail };
  return {
    text: job.is_web ? `Posted ${days} days ago` : `Last seen ${days} days ago`,
    tone: "muted",
    detail,
  };
}

// --- sender and requirements -------------------------------------------------

/** "Marco · via NJ Movers Loads" | "Unnamed sender" | "via MoverMesh". */
export function senderLine(job: Pick<PublicLoadRow, "contact_name" | "group_name" | "is_web">): string {
  if (job.is_web) return "via MoverMesh";
  const name = job.contact_name?.trim() || "Unnamed sender";
  return job.group_name ? `${name} · via ${job.group_name}` : name;
}

/**
 * "posted by 2 senders" — the cross-sender twin badge, or null for the normal
 * case of one posting.
 *
 * Read straight off `dup_count`, which the server computes from `dup_group_id`
 * (`query.ts`, and the same grouping `findCrossSenderTwins` was written for).
 * It is NOT recomputed in the browser. A second copy of the rule over the public
 * row would have to guess at the sender difference the SQL tests directly --
 * `sender_key` is null on the public wire by design -- and the day the two
 * copies disagreed, the board and the admin console would be telling a driver
 * different things about the same two rows. One rule, one answer.
 *
 * How loud: a chip, in the same quiet register as "Unverified" and
 * "approximate", and both rows carry it. Not a merge and not a hidden row --
 * the two postings can differ on price, readiness and requirements, and picking
 * one for the driver would be the board making a call it has no basis for. But
 * loud enough that nobody rings two brokers about one truckload, or reads two
 * rows as two jobs.
 */
export function twinLabel(dupCount: number): { label: string; title: string } | null {
  if (!Number.isFinite(dupCount) || dupCount < 2) return null;
  return {
    label: `posted by ${dupCount} senders`,
    title: `${dupCount} senders posted a job with the same pickup, delivery ZIP and size within a week of each other. They are shown separately, as posted — MoverMesh does not merge them, and has no way to confirm they are the same freight.`,
  };
}

const REQUIREMENT_RULES: Array<{ re: RegExp; label: string }> = [
  { re: /\bno\s+brokers?\b/i, label: "No brokers" },
  { re: /\b(dot|mc)\b/i, label: "DOT & MC" },
  { re: /\binsur/i, label: "Insurance" },
  { re: /\b(cash|zelle|venmo|cod)\b/i, label: "Cash/Zelle" },
];

/** A one-word chip for a sender's requirements, with the full text as the tooltip. */
export function requirementChip(text: string | null): { label: string; title: string } | null {
  const t = text?.trim();
  if (!t) return null;
  const hit = REQUIREMENT_RULES.find((r) => r.re.test(t));
  return { label: hit ? hit.label : "Requirements", title: t };
}

// --- sizes -------------------------------------------------------------------

/**
 * "≈ 2.6 truckloads (1,500 cf)" · "2.6× your 1,500 cf truck" ·
 * "61% of your 1,500 cf truck".
 *
 * The personalised forms name the divisor because it is the viewer's own truck.
 * The default has to name it too: "≈ 28.3 truckloads" is on the board header of
 * every visit, and a reader with a 2,400 cf trailer reading it as 28 of THEIR
 * trucks is out by nearly half. The basis was documented only in a comment on
 * TRUCK_CF, which is not somewhere a driver can look.
 *
 * "(1,500 cf)" and not "(1,500 cf each)", which is what it wants to say: the
 * board header's second line is one line inside a 56 px bottom-sheet handle, and
 * the longer form wrapped it at 360 px and pushed the text under the drag pill.
 * The gloss sits directly against "truckloads" and directly under the set's own
 * total in 20 px type, so there is nothing else it can be read as.
 *
 * The plural agrees with the number that is PRINTED, not the raw ratio: 1,499 cf
 * rounds to "1.0" and used to read "1.0 truckloads".
 */
export function truckLine(cf: number, truckCf: number | null): string {
  const size = truckCf && truckCf > 0 ? truckCf : TRUCK_CF;
  const ratio = cf / size;
  if (truckCf && truckCf > 0) {
    const yours = `your ${truckCf.toLocaleString("en-US")} cf truck`;
    return ratio >= 1 ? `${ratio.toFixed(1)}× ${yours}` : `${Math.round(ratio * 100)}% of ${yours}`;
  }
  const shown = ratio.toFixed(1);
  return `≈ ${shown} truckload${shown === "1.0" ? "" : "s"} (${TRUCK_CF.toLocaleString("en-US")} cf)`;
}

// --- one-line summary --------------------------------------------------------

type SummaryJob = PlaceJob & PricedJob & ReadyJob;

/**
 * "Kearny, NJ → Aventura, FL 33180 · 200 cf · $3.50/cf · Ready now"
 *
 * Used by the map's hover popup and as the clipboard fallback. Price and ready
 * are dropped when the post did not state them rather than padded with "No
 * price" -- a one-line summary should read like something a person would say.
 */
export function jobSummary(job: SummaryJob): string {
  const price = formatPrice(job);
  const ready = job.ready_now
    ? "Ready now"
    : job.ready_date
      ? `Ready ${shortDate(job.ready_date)}`
      : null;
  return [
    `${placeLabel(job, "pickup").text} → ${placeLabel(job, "delivery").text}`,
    job.cubic_feet != null ? formatCf(job.cubic_feet) : "Size not stated",
    price.tone === "muted" ? null : price.headline,
    ready,
  ]
    .filter(Boolean)
    .join(" · ");
}

// --- option tables -----------------------------------------------------------

export const TAG_LABELS: Record<string, { label: string; tone: Tone }> = {
  bulky: { label: "Bulky", tone: "default" },
  urgent: { label: "Urgent", tone: "warn" },
  hot_tub: { label: "Hot tub", tone: "default" },
  piano: { label: "Piano", tone: "default" },
  safe: { label: "Safe", tone: "default" },
  stairs: { label: "Stairs", tone: "default" },
  elevator: { label: "Elevator", tone: "default" },
  no_elevator: { label: "No elevator", tone: "default" },
  shuttle: { label: "Shuttle", tone: "default" },
  long_carry: { label: "Long carry", tone: "default" },
  packing: { label: "Packing", tone: "default" },
  partial: { label: "Partial", tone: "default" },
  full: { label: "Full load", tone: "default" },
  fragile: { label: "Fragile", tone: "default" },
  motorcycle: { label: "Motorcycle", tone: "default" },
  pool_table: { label: "Pool table", tone: "default" },
  treadmill: { label: "Treadmill", tone: "default" },
  storage: { label: "Storage", tone: "default" },
  cod: { label: "COD", tone: "warn" },
  ground_floor: { label: "Ground floor", tone: "default" },
};

export const SORT_OPTIONS: Array<{ value: SortKey | ""; label: string; needsViewer?: boolean }> = [
  { value: "", label: "Auto" },
  { value: "distance", label: "Nearest pickup", needsViewer: true },
  { value: "last_seen", label: "Freshest" },
  { value: "ready", label: "Ready soonest" },
  { value: "cf", label: "Biggest (cf)" },
  { value: "rate", label: "Highest $/cf" },
  { value: "deliver_by", label: "Deadline soonest" },
  { value: "newest", label: "Newest" },
];

export const READY_OPTIONS = [
  { value: "any", label: "Any" },
  { value: "now", label: "Ready now" },
  { value: "by", label: "Ready by date" },
] as const;

export const SEEN_OPTIONS = [
  { value: "", label: "Any" },
  { value: "1", label: "Today" },
  { value: "3", label: "Last 3 days" },
  { value: "7", label: "Last 7 days" },
] as const;
