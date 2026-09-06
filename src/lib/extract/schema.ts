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
export type ReadySource = "line" | "header" | "footer" | "title" | "assumed";

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

  ready_now: boolean;
  ready_date_text: string | null;
  ready_source: ReadySource | null;
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
