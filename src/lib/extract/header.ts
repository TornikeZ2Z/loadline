/**
 * Origin headers (inventory-v1, A §3.3 annotations, §3.5 parseHeader, §6.1 offline part).
 *
 * "FROM Los Angeles", "📍 Kearny", "From:Kent ,Seattle ,WA", "FROM PHOENIX AZ
 * (3 JOBS):", "From 45 Schuyler Ave Kearny NJ 07032 call 201-555-0199",
 * "Rochester, Minnesota": one header, many spellings. The place text is
 * stripped of everything that is not the place (counts, parentheticals, ready
 * words, dates, phones, a street address), split into comma groups, and read
 * with the header-context state rules -- the LAST token of a header is a state
 * whatever its case ("From Portland OR", "Kearny nj"), a LONE two-letter token
 * is an alias first ("FROM LA" is Los Angeles; "LA 70119" on a job line is
 * Louisiana, but that is the destination grammar's business).
 *
 * City -> state resolution here is what makes `npm run score` pass with no
 * network: gazetteer and alias tables answer "Grand Junction" -> CO and
 * "Los Angeles" under a California title -> CA. Coordinates come later, from
 * the geocoder (src/lib/geo/geocode.ts).
 */
import { ALIASES } from "@/lib/geo/aliases";
import { CITY_BY_KEY, CITY_BY_NAME, PREFERRED_HOMONYM } from "@/lib/geo/cities";
import { STATE_BY_ABBR, STATE_BY_NAME, stateForZip } from "@/lib/geo/states";
import { NAME_STOP, type Lexicon } from "./lexicon";
import { normalizePhone } from "./phone";
import type { OriginRef } from "./schema";
import type { RuleSet } from "./rules-store";
import { normalizeRuleKey } from "./rules-store";
import { tokenizeLine, type Token } from "./tokens";

export interface HeaderContact {
  name: string | null;
  phone: string | null;
}

export interface HeaderParse {
  ok: boolean;
  /** Title-cased city words, null for a state-only header. */
  city: string | null;
  /** Explicit state (written), or the ZIP's state when only a ZIP was given. */
  state: string | null;
  stateExplicit: boolean;
  /** Written as a full name ("Minnesota") rather than an abbreviation. */
  stateAsName: boolean;
  stateSource: OriginRef["state_source"];
  zip: string | null;
  context: string | null;
  address: string | null;
  altCity: string | null;
  /** A bare state ("NEW JERSEY", "FL:", "From California"). */
  stateOnly: boolean;
  /** The written city was a nickname ("LA", "NYC") resolved through the alias table. */
  aliasCity: string | null;
  blockReady: boolean;
  blockReadyDate: string | null;
  contacts: HeaderContact[];
  placeText: string;
  flags: string[];
}

const ADDRESS_RE =
  /^\s*\d{1,6}\s+(?:[\p{L}\d.'-]+\s+){1,4}?(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|hwy|highway|pkwy|parkway|ct|court|pl|place|ter|terrace|cir|circle|unit|suite|ste)\.?,?\s+/iu;

const TRAILING_TITLE_RE =
  /\s*[-–—:]?\s*(?:ready for delivery|rfd|ready now|ready|available|inventory|list|update|loads?|jobs?)\s*[:!]*$/i;

const MONTHS =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const TRAILING_DATE_RE = new RegExp(
  String.raw`\s*[-–—:]?\s*((?:\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)|(?:(?:${MONTHS})\.?\s*\d{1,2}(?:st|nd|rd|th)?))\s*$`,
  "i",
);

/**
 * Strip everything that is not the place from a header's place text, and
 * remember what was stripped (ready words, a date, phones, a street address).
 */
export function stripAnnotations(
  input: string,
  lex: Lexicon,
): {
  text: string;
  blockReady: boolean;
  blockReadyDate: string | null;
  contacts: HeaderContact[];
  address: string | null;
} {
  let t = input.replace(/\s+/g, " ").trim();
  let blockReady = false;
  let blockReadyDate: string | null = null;
  const contacts: HeaderContact[] = [];

  // Contact info at the tail: everything from the first contact trigger word or
  // phone onwards belongs to the sender, not the place.
  const cut = cutContact(t, lex);
  t = cut.text;
  contacts.push(...cut.contacts);

  for (let i = 0; i < 8; i++) {
    const before = t;
    t = t.replace(/[\s:;]+$/, "");
    t = t.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    t = t.replace(/^\s*\d{1,3}\s+(?:jobs?|loads?|trucks?)\s+(?=(?:from|desde|ready|available|rfd)\b)/i, "");
    t = t.replace(/\s*[-–—(]?\s*\d{1,3}\s+(?:jobs?|loads?|trucks?)\)?\s*$/i, "");
    const m = t.match(TRAILING_TITLE_RE);
    if (m && m.index !== undefined && m.index > 0) {
      if (/ready|rfd|available/i.test(m[0])) blockReady = true;
      t = t.slice(0, m.index);
    }
    const d = t.match(TRAILING_DATE_RE);
    if (d && d.index !== undefined && d.index > 0) {
      blockReadyDate = d[1];
      t = t.slice(0, d.index);
    }
    t = t.replace(/\s*[-–—]?\s*(?:to|para)\s*:?\s*$/i, "");
    t = t.replace(/\s*[-–—,;:]+$/, "").trim();
    t = t.replace(/^[\s:;,\-–—]+/, "").trim();
    if (t === before) break;
  }

  let address: string | null = null;
  const a = t.match(ADDRESS_RE);
  if (a && a.index === 0) {
    address = a[0].replace(/,?\s+$/, "").trim();
    t = t.slice(a[0].length).trim();
  }

  return { text: t, blockReady, blockReadyDate, contacts, address };
}

/** Cut a header's place text at its contact info; return the contacts found. */
function cutContact(text: string, lex: Lexicon): { text: string; contacts: HeaderContact[] } {
  const toks = tokenizeLine(text, 0).tokens;
  const contacts: HeaderContact[] = [];
  let cutAt = -1;
  let phoneIdx = -1;
  let trigIdx = -1;
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if ((tk.cls === "PHONE" || tk.cls === "PHONE7") && phoneIdx < 0) phoneIdx = i;
    if (tk.cls === "WORD" && trigIdx < 0 && lex.phrases.get(tk.norm)?.kinds.has("CONTACT")) trigIdx = i;
  }
  if (phoneIdx < 0 && trigIdx < 0) return { text, contacts };

  const phone = phoneIdx >= 0 ? toks[phoneIdx] : null;
  let name: string | null = null;
  if (trigIdx >= 0 && (phoneIdx < 0 || trigIdx < phoneIdx)) {
    cutAt = trigIdx;
    name = nameRunAfter(toks, trigIdx, phoneIdx);
  } else if (phoneIdx >= 0) {
    cutAt = phoneIdx;
    // "Kearny NJ 07032 – Alonso (201) 555-0199": a short name run directly before
    // the phone, but only when something separates it from the place.
    const run = nameRunBefore(toks, phoneIdx);
    if (run) {
      name = run.name;
      cutAt = run.start;
    }
  }
  if (phone) {
    const p = normalizePhone(phone.raw);
    contacts.push({ name, phone: p.e164 ?? p.display });
  } else if (name) {
    contacts.push({ name, phone: null });
  }
  const at = toks[cutAt]?.start ?? text.length;
  return { text: text.slice(0, at), contacts };
}

function isNameWord(tk: Token, lex: Lexicon): boolean {
  if (tk.cls !== "WORD") return false;
  if (NAME_STOP.has(tk.norm)) return false;
  if (lex.phrases.has(tk.norm)) return false;
  if (tk.norm.length === 2 && STATE_BY_ABBR.has(tk.norm.toUpperCase())) return false;
  return /^[\p{L}][\p{L}'’.-]*$/u.test(tk.raw);
}

/** Up to three name words after a contact trigger, stopping at a phone or non-name. */
export function nameRunAfter(toks: Token[], from: number, stopAt = -1, lex?: Lexicon): string | null {
  const words: string[] = [];
  for (let i = from + 1; i < toks.length && words.length < 3; i++) {
    if (stopAt >= 0 && i >= stopAt) break;
    const tk = toks[i];
    if (tk.cls === "PUNCT") {
      if (words.length) break;
      continue;
    }
    if (tk.cls !== "WORD") break;
    if (NAME_STOP.has(tk.norm) || (lex ?? NO_LEX).phrases.has(tk.norm)) {
      if (words.length) break;
      continue;
    }
    if (tk.norm.length === 2 && STATE_BY_ABBR.has(tk.norm.toUpperCase()) && tk.isUpper) break;
    words.push(tk.raw.replace(/[.:]+$/, ""));
  }
  return words.length ? words.join(" ") : null;
}

const NO_LEX: Lexicon = { phrases: new Map(), maxWords: 1 };

/** A short name run directly before a phone, separated from the place by punctuation or a ZIP/state. */
export function nameRunBefore(
  toks: Token[],
  phoneIdx: number,
  lex?: Lexicon,
): { name: string; start: number } | null {
  const words: string[] = [];
  let i = phoneIdx - 1;
  let start = phoneIdx;
  while (i >= 0 && words.length < 3 && isNameWord(toks[i], lex ?? NO_LEX)) {
    words.unshift(toks[i].raw.replace(/[.:]+$/, ""));
    start = i;
    i--;
  }
  if (!words.length) return null;
  const before = toks[i];
  const separated =
    !before ||
    before.cls === "PUNCT" ||
    before.cls === "ZIP" ||
    before.cls === "NUM" ||
    before.cls === "CF_UNIT" ||
    (before.cls === "WORD" && before.norm.length === 2 && STATE_BY_ABBR.has(before.norm.toUpperCase())) ||
    (before.cls === "WORD" && (lex ?? NO_LEX).phrases.get(before.norm)?.kinds.has("CONTACT") === true);
  // At line start there is nothing to separate from: that is a contact line,
  // and the caller decides whether a leading run is a name (contact lines) or
  // the place (headers). `before` undefined only happens at line start.
  if (!before) return { name: words.join(" "), start: -1 };
  return separated ? { name: words.join(" "), start } : null;
}

export function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => {
      if (!w) return w;
      // Keep deliberate mixed case ("McAllen", "DeSoto"); normalize shouting and lowercase.
      const hasLower = /\p{Ll}/u.test(w);
      const hasUpper = /\p{Lu}/u.test(w);
      if (hasLower && hasUpper && !/^[A-Z][a-z]/.test(w)) return w;
      const lower = w.toLowerCase();
      return lower.replace(/(^|[-'’])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
    })
    .join(" ");
}

interface Group {
  words: Token[];
  text: string;
}

function isStateAbbr(t: Token): string | null {
  if (t.cls !== "WORD") return null;
  const n = t.norm.replace(/\./g, "");
  if (n.length === 2 && STATE_BY_ABBR.has(n.toUpperCase())) return n.toUpperCase();
  return null;
}

function groupStateName(words: Token[]): string | null {
  const key = words.map((w) => w.norm).join(" ");
  const s = STATE_BY_NAME.get(key);
  if (s) return s.abbr;
  // "Washington state"
  if (words.length === 2 && words[1].norm === "state") {
    const s2 = STATE_BY_NAME.get(words[0].norm);
    if (s2) return s2.abbr;
  }
  return null;
}

/** State names that are also gazetteer cities: bare, they are the city (A §3.2.2). */
const HOMONYM_CITY: Record<string, string> = { "new york": "NY", washington: "DC" };

/**
 * Parse a header's place text ("Kent ,Seattle ,WA", "Cortez CO 81321", "LA",
 * "New Jersey", "Kearny") with the header-context state rules.
 */
export function parseHeader(placeText: string, lex: Lexicon, rules?: RuleSet): HeaderParse {
  const stripped = stripAnnotations(placeText, lex);
  const flags: string[] = [];
  const base: HeaderParse = {
    ok: false,
    city: null,
    state: null,
    stateExplicit: false,
    stateAsName: false,
    stateSource: null,
    zip: null,
    context: null,
    address: stripped.address,
    altCity: null,
    stateOnly: false,
    aliasCity: null,
    blockReady: stripped.blockReady,
    blockReadyDate: stripped.blockReadyDate,
    contacts: stripped.contacts,
    placeText: stripped.text,
    flags,
  };
  if (!stripped.text) return base;

  const toks = tokenizeLine(stripped.text, 0).tokens;

  // ZIP: the first 5-digit token that is a real ZIP; a 4-digit number next to
  // a state whose ZIPs start with 0 is a ZIP that lost its leading zero.
  let zip: string | null = null;
  const stateToks = toks.filter((t) => isStateAbbr(t));
  const rest: Token[] = [];
  for (const t of toks) {
    if (!zip && t.cls === "ZIP" && stateForZip(String(t.value))) {
      zip = String(t.value);
      continue;
    }
    if (!zip && t.cls === "NUM" && t.raw.length === 4 && stateToks.length) {
      const st = isStateAbbr(stateToks[0])!;
      const guess = stateForZip("0" + t.raw);
      if (guess && guess.abbr === st) {
        zip = "0" + t.raw;
        flags.push("zip_leading_zero_restored");
        continue;
      }
    }
    rest.push(t);
  }

  // Groups: comma, slash and dash separate parts; other punctuation is noise.
  const groups: Group[] = [];
  let cur: Token[] = [];
  const flush = () => {
    if (cur.length) groups.push({ words: cur, text: cur.map((w) => w.raw).join(" ") });
    cur = [];
  };
  let sawSlash = false;
  for (const t of rest) {
    if (t.cls === "PUNCT") {
      if (t.raw === "," || t.raw === "/" || t.raw === "-" || t.raw === "–" || t.raw === "—") {
        if (t.raw === "/") sawSlash = true;
        flush();
      }
      continue;
    }
    if (t.cls === "WORD") cur.push(t);
    else if (t.cls === "NUM" || t.cls === "ZIP" || t.cls === "BIGNUM") {
      // Leftover numbers make the header unparseable rather than a city.
      return { ...base, flags: [...flags, "header_unparsed"] };
    }
  }
  flush();

  if (!groups.length) {
    if (zip) {
      const s = stateForZip(zip)!;
      return { ...base, ok: true, zip, state: s.abbr, stateSource: "zip", stateOnly: true, city: null };
    }
    return { ...base, flags: [...flags, "header_unparsed"] };
  }

  let state: string | null = null;
  let stateExplicit = false;
  let stateAsName = false;
  let stateSource: OriginRef["state_source"] = null;
  let cityWords: Token[] | null = null;
  let contextGroups: Group[] = [];
  let aliasCity: string | null = null;

  const homonym = (g: Group) => HOMONYM_CITY[g.words.map((w) => w.norm).join(" ")] ?? null;

  const last = groups[groups.length - 1];
  const first = groups[0];

  if (groups.length === 1 && last.words.length === 1 && isStateAbbr(last.words[0])) {
    // Lone two-letter token: alias first ("LA", "DC"), else a bare state.
    const key = last.words[0].norm.replace(/\./g, "");
    const alias = ALIASES[key];
    if (alias?.city) {
      const [c, s] = alias.city.split(", ");
      aliasCity = c;
      cityWords = last.words;
      state = s;
      stateExplicit = false;
      stateSource = "alias";
    } else {
      state = isStateAbbr(last.words[0]);
      stateExplicit = true;
      stateSource = "explicit";
    }
  } else if (groups.length === 1 && groupStateName(last.words) && !homonym(last)) {
    state = groupStateName(last.words);
    stateExplicit = true;
    stateAsName = true;
    stateSource = "explicit";
  } else if (groups.length >= 2 && last.words.length === 1 && isStateAbbr(last.words[0])) {
    state = isStateAbbr(last.words[0]);
    stateExplicit = true;
    stateSource = "explicit";
    cityWords = first.words;
    contextGroups = groups.slice(1, -1);
  } else if (groups.length >= 2 && groupStateName(last.words) && !homonym(last)) {
    state = groupStateName(last.words);
    stateExplicit = true;
    stateAsName = true;
    stateSource = "explicit";
    cityWords = first.words;
    contextGroups = groups.slice(1, -1);
  } else if (
    groups.length >= 2 &&
    ((first.words.length === 1 && isStateAbbr(first.words[0])) || (groupStateName(first.words) && !homonym(first)))
  ) {
    // State-first: "NJ - Kearny", "New Jersey, Kearny".
    state = first.words.length === 1 && isStateAbbr(first.words[0]) ? isStateAbbr(first.words[0]) : groupStateName(first.words);
    stateExplicit = true;
    stateAsName = !(first.words.length === 1 && isStateAbbr(first.words[0]));
    stateSource = "explicit";
    cityWords = groups[1].words;
    contextGroups = groups.slice(2);
  } else {
    // "San Jose CA", "DENVER CO", "Kearny nj": the last token of the last group
    // is a state whatever its case; "Kansas City Missouri": the last 1-2 words.
    const lw = last.words;
    const lastTok = lw[lw.length - 1];
    let lastCityPart: Token[] = lw;
    if (lw.length >= 2 && isStateAbbr(lastTok)) {
      state = isStateAbbr(lastTok);
      stateExplicit = true;
      stateSource = "explicit";
      lastCityPart = lw.slice(0, -1);
    } else if (lw.length >= 3 && groupStateName(lw.slice(-2))) {
      state = groupStateName(lw.slice(-2));
      stateExplicit = true;
      stateAsName = true;
      stateSource = "explicit";
      lastCityPart = lw.slice(0, -2);
    } else if (lw.length >= 2 && groupStateName(lw.slice(-1)) && !homonym({ words: lw.slice(-1), text: "" })) {
      state = groupStateName(lw.slice(-1));
      stateExplicit = true;
      stateAsName = true;
      stateSource = "explicit";
      lastCityPart = lw.slice(0, -1);
    }
    if (groups.length === 1) {
      cityWords = lastCityPart;
    } else {
      // "Kent, Seattle WA": the first group is the city, the rest is context.
      cityWords = first.words;
      contextGroups = groups.slice(1, -1);
      if (lastCityPart.length) {
        contextGroups.push({ words: lastCityPart, text: lastCityPart.map((w) => w.raw).join(" ") });
      }
    }
  }

  // An initialism in front of its own state ("LA CA", "NYC NY", "ATL GA") is
  // the alias's city; a real-word nickname ("Philly PA") keeps its spelling.
  if (cityWords && cityWords.length === 1 && !aliasCity) {
    const key = cityWords[0].norm.replace(/\./g, "");
    const alias = key.length <= 4 ? ALIASES[key] : undefined;
    if (alias?.city) {
      const [c, s] = alias.city.split(", ");
      if (!state || state === s) {
        aliasCity = c;
        if (!state) {
          state = s;
          stateSource = "alias";
        }
      }
    }
  }

  // The ZIP's state wins for geocoding when it disagrees with the written one.
  if (zip) {
    const zs = stateForZip(zip)!.abbr;
    if (!state) {
      state = zs;
      stateSource = "zip";
    } else if (state !== zs) {
      flags.push("origin_zip_state_conflict");
    }
  }

  const alt = sawSlash && contextGroups.length ? contextGroups[0].text : null;
  const context = contextGroups
    .filter((g) => g.text && g.text !== alt)
    .map((g) => titleCase(g.text))
    .join(", ") || null;

  const cityText = cityWords?.length ? titleCase(cityWords.map((w) => w.raw.replace(/[.:]+$/, "")).join(" ")) : null;
  const stateOnly = !cityText;

  const parsed: HeaderParse = {
    ...base,
    ok: true,
    city: aliasCity ?? cityText,
    state,
    stateExplicit,
    stateAsName,
    stateSource,
    zip,
    context,
    altCity: alt ? titleCase(alt) : null,
    stateOnly,
    aliasCity,
    flags,
  };

  // Homonym state names as bare cities: "New York" -> New York, NY.
  if (!parsed.state && parsed.city) {
    const h = HOMONYM_CITY[parsed.city.toLowerCase()];
    if (h) {
      parsed.state = h;
      parsed.stateSource = "gazetteer";
      parsed.flags.push("homonym_state_city");
    }
  }

  // Learned place rules answer by the normalized header text.
  if (rules) {
    const learned = rules.places[normalizeRuleKey(placeText)] ?? rules.places[normalizeRuleKey(stripped.text)];
    if (learned) {
      parsed.city = learned.city ?? parsed.city;
      parsed.state = learned.state ?? parsed.state;
      parsed.zip = learned.zip ?? parsed.zip;
      parsed.stateSource = "learned";
      parsed.stateOnly = !parsed.city;
      parsed.flags.push("learned_place");
    }
  }

  return parsed;
}

export interface CityResolution {
  state: string;
  source: OriginRef["state_source"];
  /** The canonical city when an alias supplied it ("NYC" -> "New York"). */
  city?: string;
  flags: string[];
}

/**
 * Which state a bare city name is in (A §6.1 step 4, the offline part).
 * `hint` is the block state from a state-only header or title.
 */
export function resolveCityState(
  city: string,
  hint: string | null,
  opts: { hintSource?: "block" | "title"; allowShortAlias?: boolean } = {},
): CityResolution | null {
  const key = city.toLowerCase().trim();
  const hintSource = opts.hintSource ?? "block";
  if (!key) return null;

  if (hint && CITY_BY_KEY.has(`${key}, ${hint.toLowerCase()}`)) {
    return { state: hint, source: hintSource, flags: [] };
  }
  const cands = CITY_BY_NAME.get(key);
  if (cands && cands.length === 1) {
    const st = cands[0].state;
    const flags = hint && hint !== st ? ["state_hint_overridden"] : [];
    return { state: st, source: "gazetteer", flags };
  }
  if (cands && cands.length >= 2) {
    // A block state is the sender's own word; a curated gazetteer that lacks
    // "Springfield, OH" is not evidence against it.
    if (hint) return { state: hint, source: hintSource, flags: [] };
    const preferred = PREFERRED_HOMONYM[key];
    return { state: preferred ?? cands[0].state, source: "gazetteer", flags: ["ambiguous_city"] };
  }
  const alias = key.length >= 3 || opts.allowShortAlias ? ALIASES[key] : undefined;
  if (alias?.city) {
    const [c, s] = alias.city.split(", ");
    return { state: s, source: "alias", city: c, flags: [] };
  }
  if (alias?.state && !alias.city) {
    return { state: alias.state, source: "alias", flags: [] };
  }
  if (hint) return { state: hint, source: hintSource, flags: [] };
  return null;
}

/** "Kearny, NJ 07032" | "New Jersey" | "Grand Junction" -- always from the header text. */
export function originLabel(city: string | null, state: string | null, zip: string | null): string {
  if (city && state) return zip ? `${city}, ${state} ${zip}` : `${city}, ${state}`;
  if (city) return city;
  if (state) return STATE_BY_ABBR.get(state)?.name ?? state;
  return zip ?? "";
}
