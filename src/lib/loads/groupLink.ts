/**
 * Group links -- the only two WhatsApp URLs that actually exist.
 *
 * WhatsApp has NO public deep link to a single message. There is no scheme, no
 * query string and no fragment that opens one post in a group from a web page,
 * so nothing in this repo may pretend otherwise. What genuinely works:
 *
 *   https://chat.whatsapp.com/<invite code>   the group's join screen, and only
 *                                             if a group admin produced the
 *                                             invite -- it cannot be derived
 *   https://wa.me/<E.164 digits>              a 1:1 chat with that number
 *
 * So a stored group link is one of those two, and this module is the one place
 * that decides which. Pure and client-safe: no database, no session, no imports.
 *
 * SAFETY: a `wa.me` link IS a phone number written as a URL. `kind` says so, and
 * the caller is expected to keep both kinds behind the contact gate -- see
 * `groupLinkCarriesPhone` in ./redact and the note at the top of publicView.ts.
 */

export type GroupLinkKind = "invite" | "wa";

export interface GroupLink {
  /** Canonical form, safe to put in an href. */
  url: string;
  kind: GroupLinkKind;
}

/** WhatsApp invite codes are 22 URL-safe characters today; accept 6..64 to be future-proof. */
const INVITE_RE = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * Validate and canonicalize what an admin typed.
 *
 * Accepts, case-insensitively and with or without the scheme:
 *   chat.whatsapp.com/<code>          -> https://chat.whatsapp.com/<code>
 *   wa.me/<digits> · +1 786 555 0128  -> https://wa.me/<digits>
 *
 * Returns null for anything else -- including api.whatsapp.com/send?text=,
 * a bare group name, and every invented "open this message" URL. Callers
 * surface that as a 400 rather than storing a link that will not open.
 */
export function parseGroupLink(input: string | null | undefined): GroupLink | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;

  // A bare number an admin pasted instead of a link. Tested BEFORE the URL
  // parse, because "786.555.0128" is a perfectly valid hostname to `new URL`
  // and would otherwise be rejected as a foreign host.
  if (/^[+()\s.\-\d]+$/.test(raw)) return digitsLink(raw.replace(/\D/g, ""));

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/^\/+|\/+$/g, "");

  if (host === "chat.whatsapp.com") {
    // Tolerate the /invite/<code> form some clients copy.
    const code = path.replace(/^invite\//i, "");
    if (!INVITE_RE.test(code)) return null;
    return { url: `https://chat.whatsapp.com/${code}`, kind: "invite" };
  }

  if (host === "wa.me" || host === "api.whatsapp.com" || host === "whatsapp.com") {
    const digits = (host === "wa.me" ? path : (url.searchParams.get("phone") ?? "")).replace(/\D/g, "");
    return digitsLink(digits);
  }

  return null;
}

/**
 * E.164 digits, no "+" -- wa.me's own format. 10 digits are assumed NANP and
 * get the country code, exactly as `normalizePhone` does; nothing shorter is
 * dialable and nothing longer than 15 is a phone number.
 */
function digitsLink(digits: string): GroupLink | null {
  const e164 = digits.length === 10 ? `1${digits}` : digits;
  if (e164.length < 11 || e164.length > 15) return null;
  return { url: `https://wa.me/${e164}`, kind: "wa" };
}

/** The kind of a link already stored, without re-validating it. */
export function groupLinkKind(url: string | null | undefined): GroupLinkKind | null {
  return parseGroupLink(url)?.kind ?? null;
}
