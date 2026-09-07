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
    approx: precision === "state" || precision === "region",
  };
}

// --- price -------------------------------------------------------------------

type PricedJob = Pick<LoadRow, "price_per_cf" | "price_flat" | "cubic_feet">;

/**
 * "$3.75/cf" + "est. $7,500", or "$1,500 flat" + "$5.00/cf", or "No price".
 *
 * Movers quote per cubic foot, so that is the headline whenever the post gave
 * one; the estimated total is the derived number and stays subordinate. When
 * only a flat price exists the two swap, because the per-cf figure is then ours,
 * not the sender's.
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
  return { headline: "No price", sub: null, tone: "muted" };
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

/** "≈ 2.6 truckloads" · "2.6× your 1,500 cf truck" · "61% of your 1,500 cf truck". */
export function truckLine(cf: number, truckCf: number | null): string {
  const size = truckCf && truckCf > 0 ? truckCf : TRUCK_CF;
  const ratio = cf / size;
  if (truckCf && truckCf > 0) {
    const yours = `your ${truckCf.toLocaleString("en-US")} cf truck`;
    return ratio >= 1 ? `${ratio.toFixed(1)}× ${yours}` : `${Math.round(ratio * 100)}% of ${yours}`;
  }
  return `≈ ${ratio.toFixed(1)} truckload${ratio === 1 ? "" : "s"}`;
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
