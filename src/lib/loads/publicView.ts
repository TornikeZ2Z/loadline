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
import type { TruckRow, TruckSearchResult } from "@/lib/loads/truckTypes";
import type { Role } from "@/lib/session";
import { redactJob, redactTruck, redactPhones, isPhoneOnly, PHONE_MASK } from "@/lib/loads/redact";
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

/**
 * The same wire contract for a truck: phone-free always, `sender_key` gone
 * because it IS the number, and `has_phone` telling the UI whether the contact
 * gate has anything behind it.
 *
 * A separate function rather than a generic one over both kinds. The two rows
 * mask different field lists -- a truck's `truck_text` and `equipment_notes`
 * carry numbers a job's shape has no column for -- and a shared implementation
 * would have to be told which list to use, which is the same forgettable
 * argument this file exists to remove.
 */
export interface PublicTruckRow extends Omit<TruckRow, "contact_phone" | "sender_key"> {
  /** Always null on the public wire. */
  contact_phone: null;
  /** Always null: "phone:<E.164>" is the driver's own number. */
  sender_key: null;
  /** A usable phone exists behind the contact gate (drives the Show contact button). */
  has_phone: boolean;
  /** The server row had `sender_key === null`: a website post, not a WhatsApp one. */
  is_web: boolean;
}

/**
 * Strip and mask one truck. `has_phone` and `is_web` are read from the ORIGINAL
 * row -- after `redactTruck` both fields they derive from are gone.
 */
export function toPublicTruck(row: TruckRow): PublicTruckRow {
  const phone = normalizePhone(row.contact_phone);
  const has_phone = phone.e164 != null || phone.display != null;
  const is_web = row.sender_key === null;
  return {
    ...redactTruck(row),
    contact_phone: null,
    sender_key: null,
    has_phone,
    is_web,
  };
}

export function toPublicTrucks(rows: TruckRow[]): PublicTruckRow[] {
  return rows.map(toPublicTruck);
}

export interface PublicTruckSearchResult extends Omit<TruckSearchResult, "rows"> {
  rows: PublicTruckRow[];
}

export interface PublicTruckDetailResponse {
  truck: PublicTruckRow;
  source: PublicSource | null;
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
 * `POST /api/loads/:id/contact` -- the one endpoint that returns a phone, and
 * the one endpoint that returns a group link.
 *
 * The group link is here rather than on `PublicLoadRow` deliberately. An
 * invite code is not personal data, but the stored link may be a `wa.me` line
 * for a dispatcher whose "group" is really a DM, and that link IS a phone
 * number (see `groupLinkCarriesPhone` in ./redact). Publishing the harmless
 * kind would mean trusting every future caller to tell the two apart, and the
 * whole point of the gate is that reaching the sender takes an account -- so
 * both kinds travel only in this response.
 *
 * The type lives here so client code can import it without reaching a route.
 */
export interface ContactResponse {
  id: number;
  contact: {
    name: string | null;
    /** E.164, e.g. "+12015550199". Null when neither the post nor the sender has one. */
    phone: string | null;
    /** "(201) 555-0199", or the 7-digit shorthand exactly as it was written. */
    display: string | null;
    /** The post gave no area code -- `tel` and `whatsapp` are null. */
    incomplete: boolean;
    /** "dm" -- the sender asked to be messaged privately; WhatsApp leads. */
    mode: "public" | "dm";
    tel: string | null;
    whatsapp: string | null;
    /**
     * Where the number came from. "post" -- this post carried it. "sender" --
     * it is this sender's usual line, known from another of their posts or
     * attached by an admin. Null when there is no number at all. A driver
     * calling the wrong line wastes a call, so the UI says which it is.
     */
    source: "post" | "sender" | null;
  };
  /**
   * The group the post was made in, and the only WhatsApp URL that can reach
   * it. `url` is null unless an admin stored one -- WhatsApp invite links
   * cannot be derived, and there is NO link to an individual message at all.
   */
  group: {
    name: string | null;
    url: string | null;
    kind: "invite" | "wa" | null;
  };
  /** The job as plain text, for the clipboard: what a driver pastes into the group. */
  jobText: string;
  /** The original WhatsApp text, unmasked. */
  sourceBody: string | null;
  viewer: { id: number; name: string; role: Role };
}
