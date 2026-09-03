/**
 * The contract between extraction and the rest of the pipeline.
 *
 * Kept as an explicit interface rather than inlined into the extractor so the
 * extraction strategy stays swappable: the pipeline only knows that something
 * turns a message into zero or more of these, and everything downstream --
 * geocoding, dedup, expiry, search -- is unaffected by how they were produced.
 *
 * Dates and times are carried as the *verbatim phrase* from the message.
 * Resolving "tomorrow" needs the send time, which belongs in one place
 * (./dates.ts) rather than being repeated in every extractor.
 */

export interface MessageContext {
  body: string;
  authorName?: string | null;
  authorPhone?: string | null;
  groupName?: string | null;
  sentAt: Date;
}

export interface ExtractedLoad {
  /** Canonical "City, ST" where determinable, else the phrase as posted. */
  pickup_location: string;
  delivery_location: string;
  pickup_address: string | null;
  delivery_address: string | null;

  /** Date exactly as written: "tomorrow", "mon", "9/5". Resolved downstream. */
  pickup_date_text: string | null;
  /** Only set when the message states an unambiguous calendar date. */
  pickup_date_iso: string | null;
  pickup_time_text: string | null;
  delivery_date_text: string | null;

  load_type: string | null;
  weight_lbs: number | null;
  pallets: number | null;
  pieces: number | null;
  rate_usd: number | null;

  contact_name: string | null;
  contact_phone: string | null;
  notes: string | null;

  /** 0..1. Below 0.5 the pipeline flags the load for human review. */
  confidence: number;
}

export interface ExtractionResult {
  /** False for chatter, driver availability, and status replies. */
  is_load_post: boolean;
  /** Why nothing was extracted, when is_load_post is false. */
  reason: string | null;
  loads: ExtractedLoad[];
}

export interface ExtractionOutcome extends ExtractionResult {
  /** Recorded on the message for auditing. */
  extractor: string;
}
