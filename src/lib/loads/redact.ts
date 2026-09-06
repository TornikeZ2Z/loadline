/**
 * Phone masking -- the ONLY phone-masking code in the repo (D §1.1 O8).
 *
 * Pure and client-safe: no db, no auth, no node built-ins. B's
 * `publicView.ts` wraps `redactJob` / `redactPhones` for every public payload
 * and C's `present.ts` re-exports `redactPhones as maskPhones` for the DOM.
 */
import type { LoadRow } from "./types";

export const PHONE_MASK = "[phone hidden]";

const PHONE_ALTERNATIVES = [
  String.raw`(?<![\d\w])(?:\+?1[\s.\-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.\-]?)\d{3}[\s.\-]?\d{4}(?![\d\w])`,
  String.raw`(?<![\d\w])\d{3}[.\-]\d{4}(?![\d\w])`,
  String.raw`(?<![\d\w])\+\d{10,15}(?![\d\w])`,
];

/**
 * Every NANP form: +1 (786) 555-0128 · 786-555-0128 · 786.555.0128 · 786 555 0128 · 7865550128 · +17865550128;
 * the 7-digit shorthand ONLY with a hyphen/dot separator (555-0128) so "NY 11217 1200" and "33435 350" are never touched;
 * international +447700900123. Word-bounded on both sides so "38558 1700" cannot be read as 385-58-1700.
 */
export const PHONE_RE = new RegExp(PHONE_ALTERNATIVES.join("|"), "g");

/** Anchored, non-global twin of PHONE_RE for whole-string tests (a global regex carries lastIndex state). */
const PHONE_ONLY_RE = new RegExp(`^(?:${PHONE_ALTERNATIVES.join("|")})$`);

/** Replaces every phone-shaped run with PHONE_MASK. Idempotent; null → null. */
export function redactPhones(text: string | null | undefined): string | null {
  if (text == null) return null;
  return text.replace(PHONE_RE, PHONE_MASK);
}

/** True when the whole string is one phone (after trimming): "+1 (786) 555-0128", "7865550128", "+17865550128". */
export function isPhoneOnly(text: string | null | undefined): boolean {
  if (text == null) return false;
  const t = text.trim();
  return t.length > 0 && PHONE_ONLY_RE.test(t);
}

/**
 * Copy of the row with `contact_phone = null`, `sender_key = null` (the key embeds
 * the author's E.164 phone), a `contact_name` that is only a phone → null (else
 * phone-masked), and the four free-text fields passed through `redactPhones`.
 * `contact_mode`, `posted_by` and every other field pass through untouched.
 */
export function redactJob<
  T extends Pick<
    LoadRow,
    "contact_phone" | "sender_key" | "contact_name" | "line_text" | "job_notes" | "notes" | "requirements"
  >,
>(row: T): T {
  const name = row.contact_name;
  return {
    ...row,
    contact_phone: null,
    sender_key: null,
    contact_name: isPhoneOnly(name) ? null : redactPhones(name),
    line_text: redactPhones(row.line_text),
    job_notes: redactPhones(row.job_notes),
    notes: redactPhones(row.notes),
    requirements: redactPhones(row.requirements),
  };
}
