/**
 * Phone masking -- the only phone-masking code in the repo.
 *
 * The whole access model rests on one invariant: a phone number reaches a
 * browser through exactly one endpoint (POST /api/loads/:id/contact), and that
 * reveal is logged. Everything else -- list rows, detail rows, duplicate rows,
 * the original WhatsApp text, the author name, the sender key -- goes through
 * this module first, for every caller, anonymous or signed in.
 *
 * Pure and client-safe: no database, no session, no imports beyond the row type.
 * B's src/lib/loads/publicView.ts wraps it for the wire; C's present.ts
 * re-exports redactPhones as maskPhones for a second line of defence in the DOM.
 */
import type { LoadRow } from "./types";

export const PHONE_MASK = "[phone hidden]";

/**
 * Every NANP form: +1 (786) 555-0128 · 786-555-0128 · 786.555.0128 · 786 555 0128 · 7865550128 · +17865550128;
 * the 7-digit shorthand ONLY with a hyphen/dot separator (555-0128) so "NY 11217 1200" and "33435 350" are never touched;
 * international +447700900123. Word-bounded on both sides so "38558 1700" cannot be read as 385-58-1700.
 */
export const PHONE_RE = new RegExp(
  [
    String.raw`(?<![\d\w])(?:\+?1[\s.\-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.\-]?)\d{3}[\s.\-]?\d{4}(?![\d\w])`,
    String.raw`(?<![\d\w])\d{3}[.\-]\d{4}(?![\d\w])`,
    String.raw`(?<![\d\w])\+\d{10,15}(?![\d\w])`,
  ].join("|"),
  "g",
);

/**
 * Replace every phone-shaped run with PHONE_MASK. Idempotent (the mask itself
 * contains no digits), null-preserving.
 */
export function redactPhones(text: string | null | undefined): string | null {
  if (text == null) return null;
  // A fresh RegExp per call: PHONE_RE is global and therefore stateful, and a
  // shared lastIndex across callers would skip matches at random.
  return text.replace(new RegExp(PHONE_RE.source, "g"), PHONE_MASK);
}

/** True when the whole string is one phone: "+1 (786) 555-0128", "7865550128", "+17865550128". */
export function isPhoneOnly(text: string | null | undefined): boolean {
  if (text == null) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return redactPhones(trimmed) === PHONE_MASK;
}

/**
 * A stored group link that IS a phone number.
 *
 * `https://chat.whatsapp.com/<code>` is an opaque invite: it names a group, not
 * a person, and leaks nothing. `https://wa.me/17865550128` is the sender's
 * number written as a URL -- the exact thing the contact gate exists to
 * protect, and one `.replace(/\D/g, "")` away from being dialled.
 *
 * The deliberate decision (see db/schema.sql and publicView.ts) is that BOTH
 * kinds stay behind the gate, so no public payload has to be trusted to tell
 * them apart. This predicate exists so the redaction check can prove the
 * distinction is understood rather than assumed, and so any future caller
 * tempted to publish a link has to answer the question explicitly.
 */
export function groupLinkCarriesPhone(url: string | null | undefined): boolean {
  if (!url) return false;
  return redactPhones(url) !== url;
}

/**
 * A copy of the row with every phone stripped.
 *
 * `sender_key` goes too: for phone-keyed senders it is literally
 * "phone:<E.164>", i.e. the number the contact gate exists to protect.
 * A `contact_name` that is only a phone (WhatsApp's fallback display name for
 * an unknown contact) becomes null rather than "[phone hidden]" -- the UI then
 * says "Unnamed sender". `contact_mode` and every other field pass through.
 */
export function redactJob<
  T extends Pick<
    LoadRow,
    "contact_phone" | "sender_key" | "contact_name" | "line_text" | "job_notes" | "notes" | "requirements"
  >,
>(row: T): T {
  return {
    ...row,
    contact_phone: null,
    sender_key: null,
    contact_name: isPhoneOnly(row.contact_name) ? null : redactPhones(row.contact_name),
    line_text: redactPhones(row.line_text),
    job_notes: redactPhones(row.job_notes),
    notes: redactPhones(row.notes),
    requirements: redactPhones(row.requirements),
  };
}
