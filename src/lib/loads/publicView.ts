/**
 * The public wire shapes -- what leaves the server for the board, for every
 * caller, signed in or not.
 *
 * One invariant holds the whole access model up: `GET /api/loads` and
 * `GET /api/loads/:id` are phone-free. Not "phone-free for anonymous users" --
 * phone-free, always. A number reaches a browser through exactly one endpoint,
 * `POST /api/loads/:id/contact`, and that reveal is logged. Enforcing it here,
 * at the route boundary, rather than in the query builder means A's
 * `SELECT_COLUMNS` can keep selecting `contact_phone` for the admin and test
 * consoles without any risk of it slipping into a public payload.
 *
 * `sender_key` goes the same way: for a phone-keyed sender it is literally
 * "phone:+17865550128", i.e. the number the gate exists to protect. C reads
 * `is_web` where it would have tested `sender_key === null`.
 *
 * Pure and client-safe (no db, no session): C imports the types from here.
 * The masking itself is A's single implementation in `./redact`; no regex
 * lives in this file.
 */

import type { LoadRow, LoadSearchResult } from "@/lib/loads/types";
import type { Role } from "@/lib/session";
import { redactJob, redactPhones, isPhoneOnly, PHONE_MASK } from "@/lib/loads/redact";
import { normalizePhone } from "@/lib/extract/phone";

export { PHONE_MASK };

export interface PublicLoadRow extends Omit<LoadRow, "contact_phone" | "sender_key"> {
  /** Always null on the public wire. */
  contact_phone: null;
  /** Always null: "phone:<E.164>" is the author's own number. */
  sender_key: null;
  /** A usable phone exists behind the contact gate (drives the Show phone button). */
  has_phone: boolean;
  /** The server row had `sender_key === null`: a website post, not a WhatsApp one. */
  is_web: boolean;
}

/**
 * Strip and mask one row. `has_phone` and `is_web` are read from the ORIGINAL
 * row -- after `redactJob` both fields it derives from are gone.
 */
export function toPublicLoad(row: LoadRow): PublicLoadRow {
  const phone = normalizePhone(row.contact_phone);
  const has_phone = phone.e164 != null || phone.display != null;
  const is_web = row.sender_key === null;
  return {
    ...redactJob(row),
    contact_phone: null,
    sender_key: null,
    has_phone,
    is_web,
  };
}

export function toPublicLoads(rows: LoadRow[]): PublicLoadRow[] {
  return rows.map(toPublicLoad);
}

/** The original WhatsApp message shown under a job. */
export interface PublicSource {
  body: string;
  author_name: string | null;
  sent_at: string;
  group_name: string | null;
}

/**
 * Mask the message body, and drop an author name that is nothing but a phone --
 * WhatsApp uses the raw number as the display name for anyone not in the
 * reader's contacts, so "+1 (786) 555-0128" arrives as a *name*. The UI then
 * reads "Unnamed sender".
 */
export function toPublicSource(src: PublicSource | null): PublicSource | null {
  if (!src) return null;
  return {
    ...src,
    body: redactPhones(src.body) ?? "",
    author_name: isPhoneOnly(src.author_name) ? null : redactPhones(src.author_name),
  };
}

export interface RoadLeg {
  miles: number;
  minutes: number;
}

export interface PublicSearchResult extends Omit<LoadSearchResult, "rows"> {
  rows: PublicLoadRow[];
}

export interface PublicDetailResponse {
  load: PublicLoadRow;
  duplicates: PublicLoadRow[];
  source: PublicSource | null;
  distances: { trip: RoadLeg | null; toPickup: RoadLeg | null; unavailable: boolean };
}

/**
 * `POST /api/loads/:id/contact` -- the one endpoint that returns a phone.
 * The type lives here so client code can import it without reaching a route.
 */
export interface ContactResponse {
  id: number;
  contact: {
    name: string | null;
    /** E.164, e.g. "+12015550199". Null when the post carried no usable number. */
    phone: string | null;
    /** "(201) 555-0199", or the 7-digit shorthand exactly as it was written. */
    display: string | null;
    /** The post gave no area code -- `tel` and `whatsapp` are null. */
    incomplete: boolean;
    /** "dm" -- the sender asked to be messaged privately; WhatsApp leads. */
    mode: "public" | "dm";
    tel: string | null;
    whatsapp: string | null;
    /** One line for the clipboard, built server-side. */
    summary: string;
  };
  /** The original WhatsApp text, unmasked. */
  sourceBody: string | null;
  viewer: { id: number; name: string; role: Role };
}
