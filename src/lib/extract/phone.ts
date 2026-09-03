/** Phone normalization. WhatsApp posts carry every format people can type. */

/**
 * Normalize to E.164 where possible, else return null.
 * Handles: 5551234567, (555) 123-4567, 555.123.4567, +1 555 123 4567,
 * 1-555-123-4567, and the shorthand "555-1234" that appears in group chat
 * (kept as-is, flagged incomplete, since the area code is genuinely missing).
 */
export function normalizePhone(raw: string | null | undefined): {
  e164: string | null;
  display: string | null;
  incomplete: boolean;
} {
  if (!raw) return { e164: null, display: null, incomplete: false };
  const trimmed = raw.trim();
  if (!trimmed) return { e164: null, display: null, incomplete: false };

  const digits = trimmed.replace(/\D/g, "");

  if (digits.length === 11 && digits.startsWith("1")) {
    return { e164: `+${digits}`, display: formatUs(digits.slice(1)), incomplete: false };
  }
  if (digits.length === 10) {
    return { e164: `+1${digits}`, display: formatUs(digits), incomplete: false };
  }
  if (digits.length > 11 && trimmed.startsWith("+")) {
    return { e164: `+${digits}`, display: `+${digits}`, incomplete: false };
  }
  if (digits.length === 7) {
    // Area code missing -- surface it verbatim rather than inventing one.
    return { e164: null, display: `${digits.slice(0, 3)}-${digits.slice(3)}`, incomplete: true };
  }
  return { e164: null, display: trimmed, incomplete: true };
}

function formatUs(ten: string): string {
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

/** Pull every phone-shaped token out of free text. Used by the fallback extractor. */
export function findPhones(text: string): string[] {
  const matches = text.match(
    /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}|\b\d{3}[\s.-]\d{4}\b/g,
  );
  return matches ? Array.from(new Set(matches.map((m) => m.trim()))) : [];
}
