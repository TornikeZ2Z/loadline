/**
 * The contract between extraction and the rest of the pipeline (inventory-v1).
 * Pure data; no DB, no network. Dates are carried as the verbatim phrase and
 * resolved in ./dates.ts against the message send time.
 */
import type { SenderFormat } from "./rules-store";

export interface OriginRef {
  label: string;                        // "Kearny, NJ" | "Cortez, CO 81321" | "New Jersey" | "Grand Junction"
  city: string | null;
  state: string | null;
  zip: string | null;
  context: string | null;               // "Seattle" for "Kent ,Seattle ,WA"
  address: string | null;               // leading street address stripped from a header
  source:
    | "from_header"
    | "pin_header"
    | "bare_header"
    | "state_header"
    | "title"
    | "lane"
    | "sender_default"
    | "sender_last";
  state_source: "explicit" | "zip" | "block" | "title" | "gazetteer" | "alias" | "learned" | null;
  raw_text: string;
  line_no: number;
  flags: string[];
}

export interface MessageContext {
  body: string;
  authorName?: string | null;
  authorPhone?: string | null;
  groupName?: string | null;
  sentAt: Date;
  /** Filled by process.ts from the senders table; absent in eval. */
  senderHints?: {
    lastOrigin?: OriginRef | null;      // last header origin of this sender's previous snapshot (< 24 h old)
    defaultOrigin?: OriginRef | null;   // admin-set fixed warehouse for senders who never write a header
    format?: SenderFormat | null;       // sender-scoped overrides
  } | null;
}

export type CfSource = "unit" | "bare" | "next_line";
/** WHERE the readiness marker was found. Absence of a marker is not a source. */
export type ReadySource = "line" | "header" | "footer" | "title";
/**
 * WHAT the post said about readiness -- the four states, and no fifth.
 *
 * 'unknown' is the one that matters (review L01): a post with no marker used to
 * be written down as ready, which is the product inventing a fact it does not
 * have. Unknown stays unknown all the way to the card, the filter and the
 * count.
 */
export type ReadyState = "now" | "date" | "not_ready" | "unknown";

export interface ExtractedJob {
  /** Kept under these names because scripts/score-fixture.ts reads them. */
  pickup_location: string;              // = origin.label
  delivery_location: string;            // "ST ZIP" | "ST City" | "City, ST" | "ST" | "State Name" | "City" -- as written, normalized

  origin: OriginRef;
  dest_state: string | null;
  dest_zip: string | null;
  dest_city: string | null;

  cubic_feet: number | null;
  cf_source: CfSource | null;
  price_per_cf: number | null;
  price_flat: number | null;
  price_basis: "marker" | "threshold" | "ambiguous" | null;

  /** True ONLY when the post said so. Never a stand-in for "nothing was said". */
  ready_now: boolean;
  ready_date_text: string | null;
  ready_source: ReadySource | null;
  /** What the post said about readiness; 'date' before the phrase is resolved. */
  ready_state: ReadyState;
  deliver_by_text: string | null;

  tags: string[];
  notes: string | null;
  contact_name: string | null;          // sender primary, never per job
  contact_phone: string | null;

  line_no: number;
  line_text: string;
  ordinal: number;                      // 1-based among identical (origin_key, dest_key, cf) in the message
  flags: string[];
  confidence: number;                   // 0..1

  /** Legacy v1 fields: optional, never emitted by inventory-v1. */
  pickup_address?: string | null;
  delivery_address?: string | null;
  pickup_date_text?: string | null;
  pickup_date_iso?: string | null;
  pickup_time_text?: string | null;
  delivery_date_text?: string | null;
  load_type?: string | null;
  weight_lbs?: number | null;
  pallets?: number | null;
  pieces?: number | null;
  rate_usd?: number | null;
}
export type ExtractedLoad = ExtractedJob;

/**
 * The readiness state a row is STORED with, given the extraction and the date
 * phrase once it has been resolved against the send time.
 *
 * One function because three writers store the same fact -- the batch pipeline,
 * the reconciler and the website form -- and the day two of them disagreed, the
 * board and the admin console would say different things about one job.
 *
 * A date phrase nobody could resolve ("ready end of month") is stored as
 * `unknown`, not as `date`: we know the sender said something, but we do not
 * know which day, and a state called 'date' with no date in `ready_date` would
 * be a promise the row cannot keep. The phrase itself survives in
 * `ready_date_text` for the admin queue.
 */
export function readyStateOf(
  job: Pick<ExtractedJob, "ready_now" | "ready_state">,
  resolvedReadyDate: string | null,
): ReadyState {
  if (job.ready_now) return "now";
  if (resolvedReadyDate) return "date";
  return job.ready_state === "not_ready" ? "not_ready" : "unknown";
}

export type LineClass =
  | "BLANK"
  | "DECORATION"
  | "READMORE"
  | "LANE"
  | "CHATTER"
  | "REQUIREMENT"
  | "HEADER"
  | "TITLE"
  | "FOOTER_FLAG"
  | "DESTINATION"
  | "CONTACT"
  | "CONTACT_NAME"
  | "CONTINUATION"
  | "NOTE"
  | "UNKNOWN";

export interface LineAudit {
  n: number;                            // 1-based line number
  text: string;
  class: LineClass;
  sub?: "state-only" | "city-only" | "bare" | "incomplete" | "cf-null" | null;
  tokens: Array<{
    cls: string;
    raw: string;
    norm: string;
    value?: number | string | null;
    start: number;
    end: number;
  }>;
  flags: string[];
  reason: string | null;                // why it got this class (rule id, e.g. "A7", "B12")
  job_index: number | null;             // index into ExtractionOutcome.loads, when the line produced a job
}

export interface ExtractionResult {
  /** False for chatter, capacity offers, requirement-only and status replies. */
  is_load_post: boolean;
  /** Skip code when is_load_post is false: not_a_load | no_origin | unknown_format. */
  reason: string | null;
  loads: ExtractedJob[];
}

export interface ExtractionOutcome extends ExtractionResult {
  extractor: "inventory-v1";
  contact: { name: string | null; phone: string | null; source: "footer" | "author" | null; mode: "public" | "dm" };
  contacts: Array<{ name: string | null; phone: string | null }>;
  requirements: string[];
  flags: string[];
  attention: string | null;
  parse_status: "clean" | "partial" | "unknown";
  truncated: boolean;
  rfd_anywhere: boolean;
  message_ready: { ready_now: boolean; source: "footer" | "title" | null };
  partial_marker: string | null;
  format_signature: string;
  lines: LineAudit[];
  orphans: number[];                    // line numbers of destinations with no origin
  last_origin: OriginRef | null;        // for senders.last_origin
}
