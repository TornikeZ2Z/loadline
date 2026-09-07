/**
 * The five real-world facts about the operating entity, and where they live.
 *
 * WHAT THIS IS FOR. Six public pages -- /contact, /terms, /privacy, /cookies,
 * plus the footer on every page -- have to name the company, its address, its
 * support mailbox, the law the terms run under and the date they were
 * published. None of those is a fact this codebase can derive, so until now
 * each one was written into the JSX as a `[[PLACEHOLDER]]`. This module turns
 * the five of them into stored values the CTO fills in at /admin/settings, and
 * keeps the placeholders as what a reader sees while a value is still unset.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE: an unset value stays VISIBLY unset.
 *
 * There is no default, no fallback, no "MoverMesh Inc" and no empty string. A
 * value that has not been filled in renders as the same bracketed token it
 * rendered as before this module existed, because a legal page that quietly
 * omits the entity it binds is worse than one that admits it does not know.
 * `settingText()` is the only way to get a value onto a page, and it returns
 * the token when the row is absent. Storing an empty string is not possible --
 * `sanitiseSetting` turns blank input into `null`, which DELETES the row.
 *
 * WHAT IT IS NOT. Filling these in does not make the legal pages reviewed.
 * /terms and /privacy carry standing notices saying counsel has not read them;
 * those come off when a lawyer says so, never as a side effect of a form. See
 * .design/impl/legal-placeholders.md.
 *
 * SAFETY. These values land inside legal prose on pages anybody can read, so
 * they are sanitised on the way in (below) and escaped on the way out. The
 * escaping is React's: every caller renders a value as a JSX text child, and
 * nothing in this codebase passes one to `dangerouslySetInnerHTML`. The write
 * side does not rely on that alone -- `<` and `>` are refused outright, because
 * no registered name, address or jurisdiction contains one and refusing them
 * removes the question.
 *
 * SERVER ONLY: this module imports the database. A client component that needs
 * the field list takes it as a prop and its type with `import type`, which is
 * erased at compile time.
 */
import { cache } from "react";
import { query } from "@/lib/db";

/** The five values. The string is the primary key in `site_settings`. */
export type SettingKey =
  | "company_legal_name"
  | "support_email"
  | "registered_address"
  | "governing_law"
  | "effective_date";

/**
 * How a value is checked on write and drawn in the form.
 *
 *   line   one line of prose -- whitespace collapsed, newlines included
 *   email  one address, checked for shape only (no mailbox is verified)
 *   date   stored as YYYY-MM-DD, rendered by `formatEffectiveDate`
 */
export type SettingKind = "line" | "email" | "date";

export interface SiteSettingField {
  key: SettingKey;
  /** The token a reader sees while this value is unset. Rendered verbatim. */
  placeholder: string;
  /** The form's label. */
  label: string;
  /** What the value has to be, in the admin's words, not the schema's. */
  hint: string;
  /** A shape, not a suggestion -- never prefilled, never rendered publicly. */
  example: string;
  kind: SettingKind;
  maxLength: number;
  /** The pages this value appears on, so the form says what it is about to change. */
  appearsOn: string;
}

/**
 * The five fields, in the order the form asks for them: who you are, how to
 * reach you, where you are, when this was published, whose law it runs under.
 *
 * `placeholder` must stay byte-identical to the token the pages used before
 * this module: it is the string a reader sees today, and changing it would
 * change six public pages by accident.
 */
export const SITE_SETTING_FIELDS: readonly SiteSettingField[] = [
  {
    key: "company_legal_name",
    placeholder: "[[COMPANY LEGAL NAME]]",
    label: "Company legal name",
    hint: "The registered name of the operating entity, exactly as it is registered — not a trading name and not the product name.",
    example: "Acme Logistics LLC",
    kind: "line",
    maxLength: 120,
    appearsOn: "the footer of every page, /contact, /terms, /privacy",
  },
  {
    key: "support_email",
    placeholder: "[[SUPPORT EMAIL]]",
    label: "Support email",
    hint: "One address that reaches a person. Support, legal notices and takedown requests all point here today. It is printed on public pages, so it will be scraped.",
    example: "support@example.com",
    kind: "email",
    maxLength: 160,
    appearsOn: "/contact, /terms, /privacy, /cookies",
  },
  {
    key: "registered_address",
    placeholder: "[[REGISTERED ADDRESS]]",
    label: "Registered address",
    hint: "The entity's registered or postal address, on one line. It is read inside a sentence, so write it with commas.",
    example: "1 Example Street, Newark, NJ 07102",
    kind: "line",
    maxLength: 200,
    appearsOn: "/contact, /terms",
  },
  {
    key: "effective_date",
    placeholder: "[[EFFECTIVE DATE]]",
    label: "Effective date",
    hint: "The date the legal pages were published. Stored as a date and printed the same way on all three pages, so they cannot drift apart.",
    example: "2026-09-07",
    kind: "date",
    maxLength: 10,
    appearsOn: "/terms, /privacy, /cookies",
  },
  {
    key: "governing_law",
    placeholder: "[[GOVERNING LAW]]",
    label: "Governing law",
    hint: "The law the terms run under. It is read inside one sentence — “These terms are governed by …, and disputes go to the courts of that jurisdiction” — so write it to follow “governed by”.",
    example: "the laws of the State of New Jersey",
    kind: "line",
    maxLength: 160,
    appearsOn: "/terms",
  },
];

const FIELD_BY_KEY = new Map<SettingKey, SiteSettingField>(
  SITE_SETTING_FIELDS.map((f) => [f.key, f]),
);

/** Every key, or `null` where nothing has been stored. Never an empty string. */
export type SiteSettings = Record<SettingKey, string | null>;

/** What a database with no `site_settings` rows means. Also the SSG fallback. */
export const UNSET_SITE_SETTINGS: SiteSettings = {
  company_legal_name: null,
  support_email: null,
  registered_address: null,
  governing_law: null,
  effective_date: null,
};

// --- reading -----------------------------------------------------------------

interface SettingRow {
  key: string;
  value: string;
}

/**
 * One trip to the database, uncached.
 *
 * Use this only where a value written earlier in the SAME request has to be
 * read back -- the settings PUT handler, which answers with what a visitor will
 * now see. Everywhere else wants `readSiteSettings`.
 *
 * A database that cannot be reached is NOT an error here. The footer is on
 * every page including the board, and a settings table that is briefly
 * unavailable must degrade to the placeholders -- which is the honest reading
 * of "we do not know this value" -- rather than take the whole site down for a
 * copyright line. The failure is logged, not swallowed silently.
 */
export async function loadSiteSettings(): Promise<SiteSettings> {
  const out: SiteSettings = { ...UNSET_SITE_SETTINGS };
  let rows: SettingRow[];
  try {
    rows = await query<SettingRow>(`SELECT key, value FROM site_settings`);
  } catch (err) {
    console.error("[settings] could not read site_settings; falling back to placeholders", err);
    return out;
  }
  for (const row of rows) {
    if (!(row.key in out)) continue; // a key this build does not know about
    const value = typeof row.value === "string" ? row.value.trim() : "";
    if (value) out[row.key as SettingKey] = value;
  }
  return out;
}

/**
 * The stored values, once per request.
 *
 * `cache()` is doing real work here rather than being decoration: a legal page
 * reads these for its own prose AND renders a footer that reads them for the
 * copyright line, so the naive version is two queries per page view. React
 * dedupes them to one for the lifetime of the request.
 */
export const readSiteSettings = cache(loadSiteSettings);

// --- rendering ---------------------------------------------------------------

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * "2026-09-07" -> "September 7, 2026".
 *
 * Built from the ISO parts rather than `new Date(...).toLocaleDateString()`:
 * a bare ISO date parses as midnight UTC, so a server west of Greenwich renders
 * the day before, and the locale would make the format depend on the host. One
 * stored date has to print identically on /terms, /privacy and /cookies, which
 * is the whole reason it is stored as a date and not as free text.
 */
export function formatEffectiveDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso; // stored before this format existed; print it as it is
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return iso;
  return `${month} ${Number(m[3])}, ${Number(m[1])}`;
}

/**
 * The string to put on the page: the stored value, or the bracketed token.
 *
 * This is the ONLY way a page should reach a setting. Reading `settings.key`
 * directly is how an unset value becomes an empty string in the middle of a
 * sentence -- "MoverMesh is operated by , 1 Example Street" -- which is exactly
 * the outcome the placeholders exist to prevent.
 */
export function settingText(settings: SiteSettings, key: SettingKey): string {
  const field = FIELD_BY_KEY.get(key)!;
  const value = settings[key];
  if (!value) return field.placeholder;
  return field.kind === "date" ? formatEffectiveDate(value) : value;
}

/** True when this value has been filled in. */
export function isSettingFilled(settings: SiteSettings, key: SettingKey): boolean {
  return Boolean(settings[key]);
}

/** The fields still showing a placeholder, in form order. */
export function unfilledSettings(settings: SiteSettings): SiteSettingField[] {
  return SITE_SETTING_FIELDS.filter((f) => !settings[f.key]);
}

// --- writing -----------------------------------------------------------------

export type SanitiseResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

/**
 * C0 and C1 control characters, plus the bidirectional-override marks.
 *
 * The overrides are the reason this is more than whitespace normalisation:
 * U+202E and its family reverse the visual order of everything after them, so a
 * name stored with one reads on the page as something other than what is in the
 * database. These values sit in legal prose, where what the reader sees is the
 * whole point of storing them.
 */
const CONTROL = /[\p{Cc}\p{Cf}]/gu;

/**
 * A conservative address shape: one `@`, a dot in the domain, no spaces, no
 * angle brackets, no comment syntax. It proves nothing about whether the
 * mailbox exists -- nothing here can -- it only stops a typo or a sentence
 * being published as the one route to a human.
 */
const EMAIL = /^[^\s@<>",;()[\]\\]+@[^\s@<>",;()[\]\\.]+(?:\.[^\s@<>",;()[\]\\.]+)+$/;

/**
 * Check and normalise one value on its way into the database.
 *
 * Blank input is not an error: it returns `{ value: null }`, which the route
 * stores as a deleted row and the pages render as the placeholder again. That
 * is the undo, and it has to work, because a wrong company name on a Terms page
 * is worse than an obviously missing one.
 */
export function sanitiseSetting(key: SettingKey, raw: unknown): SanitiseResult {
  const field = FIELD_BY_KEY.get(key);
  if (!field) return { ok: false, error: `Unknown setting "${String(key)}"` };
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: `${field.label} must be text` };

  // Collapse first, then trim: a value pasted out of a document arrives with
  // newlines and non-breaking spaces in it, and all of these are read inside a
  // sentence on a public page.
  const value = raw.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  if (!value) return { ok: true, value: null };

  if (value.length > field.maxLength) {
    return { ok: false, error: `${field.label} is longer than ${field.maxLength} characters` };
  }
  if (/[<>]/.test(value)) {
    return {
      ok: false,
      error: `${field.label} cannot contain < or >. These values are printed on public pages.`,
    };
  }
  // A stored value that LOOKS like an unset one would make "filled in" and
  // "never filled in" indistinguishable to every reader of the page, which is
  // the one distinction this whole module exists to keep.
  if (value.includes("[[") || value.includes("]]")) {
    return { ok: false, error: `${field.label} cannot contain [[ or ]] — that is how an unfilled value is shown.` };
  }

  if (field.kind === "email") {
    if (!EMAIL.test(value)) {
      return { ok: false, error: `${field.label} does not look like an email address` };
    }
  }

  if (field.kind === "date") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return { ok: false, error: `${field.label} must be a date, as YYYY-MM-DD` };
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    // Round-trip through UTC so 2026-02-30 is refused rather than silently
    // becoming 2026-03-02.
    const utc = new Date(Date.UTC(y, mo - 1, d));
    if (
      utc.getUTCFullYear() !== y ||
      utc.getUTCMonth() !== mo - 1 ||
      utc.getUTCDate() !== d ||
      y < 2000 ||
      y > 2999
    ) {
      return { ok: false, error: `${field.label} is not a real date` };
    }
  }

  return { ok: true, value };
}

/** True when `key` is one of the five. Narrows an untrusted string from a body. */
export function isSettingKey(key: unknown): key is SettingKey {
  return typeof key === "string" && FIELD_BY_KEY.has(key as SettingKey);
}
