/**
 * Line classification (inventory-v1, A §3.2-§3.4).
 *
 * A batch post is a list of lines and each line is one of a small number of
 * things: an origin header, a destination, a lane, a title, a footer flag, a
 * contact, a requirement, chatter, decoration. The classifier reads each line
 * as a bag of typed tokens (P3: keyword phrases, place phrases, state names,
 * two-letter states with their acceptance rules) and decides the class in two
 * passes -- context-free first (P4), then the rules that need to know what the
 * neighbouring lines are (P5) -- followed by the demotion of headers that own
 * no jobs (P6) and the message-level pass (P7: contacts, requirements, ready
 * flags, signatures, truncation).
 *
 * Every decision is recorded on the line (class, rule id, flags, tokens) so the
 * admin console's gutter can show exactly why a line became what it became.
 */
import { ALIASES } from "@/lib/geo/aliases";
import { CITY_BY_NAME, type City } from "@/lib/geo/cities";
import { AMBIGUOUS_ABBR } from "@/lib/geo/match";
import { STATE_BY_ABBR, STATE_BY_NAME, stateForZip } from "@/lib/geo/states";
import { resolveDatePhrase, toLocalDate, isoOf } from "./dates";
import {
  nameRunAfter,
  nameRunBefore,
  parseHeader,
  resolveCityState,
  stripAnnotations,
  titleCase,
  type HeaderContact,
  type HeaderParse,
} from "./header";
import { fuzzyTag, NAME_STOP, type LexEntry, type Lexicon } from "./lexicon";
import { normalizePhone } from "./phone";
import type { LineAudit, LineClass } from "./schema";
import { compileTemplate, normalizeRuleKey, type RuleSet, type SenderFormat } from "./rules-store";
import { isBlank, isDecoration, tokenizeLine, type ScannedLine, type Token } from "./tokens";

// ---------------------------------------------------------------------------
// Annotated tokens
// ---------------------------------------------------------------------------

export type Role =
  | "ZIP" | "CF" | "CF_EXTRA" | "ORDINAL" | "SMALLNUM" | "UNKNOWN_NUM" | "NOTE" | "ZIP4"
  | "PRICE_PERCF" | "PRICE_FLAT" | "PRICE_NOTE"
  | "DATE_READY" | "DATE_DEADLINE" | "DATE_NOTE"
  | "PHONE" | "NAME" | "TAG" | "KW";

export interface CityHit {
  name: string;
  state: string | null;
  source: "gazetteer" | "alias" | "learned";
  cands: City[];
  ambiguous: boolean;
}

export interface Ann {
  kw?: LexEntry;
  kwHead?: boolean;
  kwLen?: number;
  /** A two-letter word that could be a state. */
  stCand?: string;
  /** Accepted as a state on this line (destination context). */
  st?: string;
  stname?: string;
  stnameLen?: number;
  city?: CityHit;
  cityLen?: number;
  /** Part of a multi-token phrase (not its head). */
  covered?: boolean;
  role?: Role;
  tag?: string;
}

export type ATok = Token & Ann;

export interface PriceHit {
  value: number;
  kind: "per_cf" | "flat";
  basis: "marker" | "threshold" | "ambiguous";
  idx: number;
}

export interface Evidence {
  hasFrom: boolean;
  /** Character offset where the header's place text starts. */
  fromAt: number;
  fromRfd: boolean;
  hasPin: boolean;
  toIdx: number[];
  hasArrow: boolean;
  cfUnits: number[];
  cfCands: number[];
  cf: { value: number; source: "unit" | "bare"; idx: number } | null;
  extraCf: number[];
  zips: number[];
  states: number[];
  stnames: number[];
  cities: number[];
  phones: number[];
  contactTrig: boolean;
  dm: boolean;
  reqHit: boolean;
  titleHit: boolean;
  footerHit: boolean;
  chatterHit: boolean;
  capacityIdx: number;
  paymentHit: boolean;
  partialHit: string | null;
  rfdIdx: number[];
  dateReady: number;
  dateDeadline: number;
  price: PriceHit | null;
  tags: string[];
  wordsOnly: boolean;
  hasComma: boolean;
  nameOnly: boolean;
  onlyCf: boolean;
  onlyRfd: boolean;
  onlyPrice: boolean;
  onlyDate: boolean;
  unknownNum: boolean;
  keywordHit: boolean;
  /** Two cubic-feet figures separated by another place: two destinations, not two jobs. */
  twoDests: boolean;
  wordCount: number;
  flags: string[];
}

export interface DestParse {
  state: string | null;
  zip: string | null;
  city: string | null;
  citySource: "gazetteer" | "alias" | "learned" | "adjacent" | null;
  written: string;
  stateOnly: boolean;
  unresolvedCity: boolean;
  cf: number | null;
  cfSource: "unit" | "bare" | null;
  extraCf: number[];
  price: PriceHit | null;
  rfd: boolean;
  readyDateText: string | null;
  deliverByText: string | null;
  tags: string[];
  notes: string | null;
  flags: string[];
  sig: string;
  leftoverWords: number;
  /** Written state and ZIP disagree. */
  zipStateMismatch: boolean;
}

export interface Line {
  s: ScannedLine;
  toks: ATok[];
  ev: Evidence;
  cls: LineClass;
  sub: LineAudit["sub"];
  reason: string | null;
  flags: string[];
  header?: { parse: HeaderParse; kind: "from" | "pin" | "bare" | "state" | "city"; sig: string; rawPlace: string };
  dest?: DestParse;
  lane?: { origin: HeaderParse; setsOrigin: boolean; dest: DestParse; rawOrigin: string };
  contact?: { name: string | null; phone: string | null; mode: "public" | "dm"; phoneOnly: boolean };
  /** Every phone/name found on the line, in order. */
  contacts: HeaderContact[];
  continuation?: { cf?: number; rfd?: boolean; price?: PriceHit; dateText?: string };
  noteTags?: string[];
  jobIndex: number | null;
  /** Set by the orchestrator before pass A: the line directly above is a DESTINATION. */
  prevIsDestination?: boolean;
}

export interface LineContext {
  lex: Lexicon;
  rules: RuleSet;
  format: SenderFormat | null;
  sentAt: Date;
}

const REQUIRES_CAPS = new Set([
  "mobile", "reading", "salem", "aurora", "riverside", "ontario", "orange", "independence",
  "normal", "warren", "florence", "hollywood", "sunrise", "kent", "greece", "buffalo",
]);

const isWord = (t: ATok | undefined): t is ATok => !!t && t.cls === "WORD";
const isPunct = (t: ATok | undefined, ch?: string) => !!t && t.cls === "PUNCT" && (ch === undefined || t.raw === ch);

function kindOf(t: ATok | undefined, kind: string): boolean {
  return !!t?.kw?.kinds.has(kind as never);
}

function prevNonPunct(toks: ATok[], i: number): ATok | undefined {
  for (let j = i - 1; j >= 0; j--) if (toks[j].cls !== "PUNCT") return toks[j];
  return undefined;
}

function nextNonPunct(toks: ATok[], i: number): ATok | undefined {
  for (let j = i + 1; j < toks.length; j++) if (toks[j].cls !== "PUNCT") return toks[j];
  return undefined;
}

// ---------------------------------------------------------------------------
// P3: tagging
// ---------------------------------------------------------------------------

function tagKeywords(toks: ATok[], lex: Lexicon) {
  for (let i = 0; i < toks.length; i++) {
    if (!isWord(toks[i]) || toks[i].kw) continue;
    for (let len = Math.min(lex.maxWords, toks.length - i); len >= 1; len--) {
      const slice = toks.slice(i, i + len);
      if (!slice.every((t) => isWord(t) && !t.kw)) continue;
      const key = slice.map((t) => t.norm).join(" ");
      const e = lex.phrases.get(key);
      if (!e) continue;
      // Conditional markers.
      if (e.cond === "pu" && e.kinds.size === 1) {
        const nx = toks[i + len];
        const ok = !!nx && (isPunct(nx, ":") || (isWord(nx) && !lex.phrases.has(nx.norm)));
        if (!ok) continue;
      }
      if (e.cond === "del") {
        const nx = toks[i + len];
        const ok =
          !!nx &&
          (isPunct(nx, ":") || nx.cls === "ZIP" || (isWord(nx) && nx.norm.length === 2 && STATE_BY_ABBR.has(nx.norm.toUpperCase())));
        if (!ok) continue;
      }
      toks[i].kw = e;
      toks[i].kwHead = true;
      toks[i].kwLen = len;
      for (let k = 1; k < len; k++) {
        toks[i + k].kw = e;
        toks[i + k].covered = true;
      }
      i += len - 1;
      break;
    }
  }
  // "per c/f" and "$3.75/cf" style per-cf markers.
  for (let i = 0; i + 2 < toks.length; i++) {
    if (isWord(toks[i]) && toks[i].norm === "c" && isPunct(toks[i + 1], "/") && isWord(toks[i + 2]) && toks[i + 2].norm === "f") {
      const e: LexEntry = { kinds: new Set(["PERCF"]) };
      toks[i].kw = e; toks[i].kwHead = true; toks[i].kwLen = 1;
      toks[i + 2].kw = e; toks[i + 2].covered = true;
    }
  }
}

function tagPlaces(toks: ATok[], lex: Lexicon) {
  // Cities (learned -> gazetteer -> aliases), longest phrase first.
  for (let i = 0; i < toks.length; i++) {
    if (!isWord(toks[i]) || toks[i].city || toks[i].covered) continue;
    for (let len = Math.min(5, toks.length - i); len >= 1; len--) {
      const slice = toks.slice(i, i + len);
      if (!slice.every((t) => isWord(t) && !t.city && !t.covered)) continue;
      // A keyword head inside a city phrase is fine ("Post Falls"), but a
      // marker as the whole phrase is not.
      if (len === 1 && slice[0].kw && !slice[0].kw.kinds.has("CITY")) continue;
      const key = slice.map((t) => t.norm).join(" ");
      let hit: CityHit | null = null;
      const learned = lex.phrases.get(key);
      if (learned?.kinds.has("CITY") && learned.city) {
        const [c, s] = learned.city.split(", ");
        hit = { name: c, state: s ?? null, source: "learned", cands: [], ambiguous: false };
      } else {
        const cands = CITY_BY_NAME.get(key);
        if (cands?.length) {
          if (len === 1 && REQUIRES_CAPS.has(key) && !/^\p{Lu}/u.test(slice[0].raw)) continue;
          hit = {
            name: cands[0].city,
            state: cands.length === 1 ? cands[0].state : null,
            source: "gazetteer",
            cands,
            ambiguous: cands.length > 1,
          };
        } else if (key.length >= 3) {
          const alias = ALIASES[key];
          if (alias?.city && !STATE_BY_ABBR.has(key.toUpperCase())) {
            const [c, s] = alias.city.split(", ");
            hit = { name: c, state: s, source: "alias", cands: [], ambiguous: false };
          }
        }
      }
      if (!hit) continue;
      toks[i].city = hit;
      toks[i].cityLen = len;
      for (let k = 1; k < len; k++) toks[i + k].covered = true;
      i += len - 1;
      break;
    }
  }
  // State names on uncovered words, not followed by a plain word.
  for (let i = 0; i < toks.length; i++) {
    if (!isWord(toks[i]) || toks[i].city || toks[i].covered || toks[i].kw) continue;
    for (let len = 2; len >= 1; len--) {
      const slice = toks.slice(i, i + len);
      if (slice.length < len || !slice.every((t) => isWord(t) && !t.city && !t.covered)) continue;
      const key = slice.map((t) => t.norm).join(" ");
      let abbr: string | null = null;
      if (key === "washington state") abbr = "WA";
      else {
        const s = STATE_BY_NAME.get(key);
        if (s) abbr = s.abbr;
      }
      if (!abbr) continue;
      const nx = toks[i + len];
      if (isWord(nx) && !nx.kw && !nx.city && !nx.covered && !(nx.norm.length === 2 && STATE_BY_ABBR.has(nx.norm.toUpperCase()))) {
        continue;
      }
      toks[i].stname = abbr;
      toks[i].stnameLen = len;
      for (let k = 1; k < len; k++) toks[i + k].covered = true;
      i += len - 1;
      break;
    }
  }
  // Two-letter state candidates.
  for (const t of toks) {
    if (!isWord(t) || t.covered || t.city || t.stname) continue;
    const n = t.norm.replace(/\./g, "");
    if (n.length === 2 && STATE_BY_ABBR.has(n.toUpperCase())) t.stCand = n.toUpperCase();
  }
}

function classifyNumbers(toks: ATok[], ev: Evidence, format: SenderFormat | null) {
  const fives = toks.map((t, i) => (t.cls === "ZIP" ? i : -1)).filter((i) => i >= 0);
  const stIdx = toks.map((t, i) => (t.stCand ? i : -1)).filter((i) => i >= 0);

  // Which 5-digit tokens are ZIPs.
  const accepted = new Set<number>();
  for (const i of fives) {
    const v = String(toks[i].value);
    if (!stateForZip(v)) continue;
    if (fives.length === 1 || v.startsWith("0")) {
      accepted.add(i);
      continue;
    }
    // Adjacent to a state: prefer the token directly after it.
    const after = stIdx.some((s) => i === s + 1);
    const near = stIdx.some((s) => Math.abs(i - s) <= 1);
    if (after) accepted.add(i);
    else if (near && !fives.some((o) => o !== i && stIdx.some((s) => o === s + 1))) accepted.add(i);
  }
  for (const i of fives) {
    if (accepted.has(i)) toks[i].role = "ZIP";
    else {
      toks[i].role = "UNKNOWN_NUM";
      ev.flags.push("large_number");
      ev.unknownNum = true;
    }
  }
  for (const [i, t] of toks.entries()) if (t.cls === "BIGNUM") { t.role = "UNKNOWN_NUM"; ev.unknownNum = true; if (!ev.flags.includes("large_number")) ev.flags.push("large_number"); void i; }

  // Bare numbers.
  const firstContent = toks.findIndex((t) => t.cls !== "PUNCT");
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.cls !== "NUM") continue;
    const v = Number(t.value);
    if (v > 5000) { t.role = "UNKNOWN_NUM"; ev.unknownNum = true; ev.flags.push("large_number"); continue; }
    if (v < 10) { t.role = "SMALLNUM"; continue; }
    t.role = "CF";
  }
  // Line-initial ordinal "10." / "12)".
  const f = toks[firstContent];
  if (f && f.cls === "NUM" && Number(f.value) <= 30 && (isPunct(toks[firstContent + 1], ".") || isPunct(toks[firstContent + 1], ")"))) {
    const another = toks.some((t, i) => i !== firstContent && (t.cls === "CF_UNIT" || t.cls === "CF_PREFIX" || t.cls === "CF_FT" || (t.cls === "NUM" && t.role === "CF")));
    if (another) f.role = "ORDINAL";
  }
  // Leading-zero restore: "NJ 7102 200".
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.cls !== "NUM" || t.raw.length !== 4 || t.role !== "CF") continue;
    const neighbour = [toks[i - 1], toks[i + 1]].find((n) => n?.stCand);
    if (!neighbour?.stCand) continue;
    const st = STATE_BY_ABBR.get(neighbour.stCand)!;
    if (!st.zip3.some(([lo]) => lo < 100)) continue;
    const guess = stateForZip("0" + t.raw);
    const another = toks.some((o, j) => j !== i && (o.cls === "CF_UNIT" || o.cls === "CF_PREFIX" || o.cls === "CF_FT" || (o.cls === "NUM" && o.role === "CF")));
    if (guess && guess.abbr === neighbour.stCand && another) {
      t.role = "ZIP";
      t.value = "0" + t.raw;
      ev.flags.push("zip_leading_zero_restored");
    }
  }
  // ZIP+4: "33435-1234 350".
  for (let i = 2; i < toks.length; i++) {
    const t = toks[i];
    if (t.cls !== "NUM" || t.role !== "CF") continue;
    if (isPunct(toks[i - 1], "-") && toks[i - 2].role === "ZIP") {
      const another = toks.some((o, j) => j !== i && (o.cls === "CF_UNIT" || o.cls === "CF_PREFIX" || o.cls === "CF_FT" || (o.cls === "NUM" && o.role === "CF")));
      if (another) { t.role = "ZIP4"; ev.flags.push("zip_plus4_suspect"); }
    }
  }
  if (format?.bare_number_is === "note") {
    for (const t of toks) if (t.cls === "NUM" && t.role === "CF") t.role = "NOTE";
  }
}

function acceptStates(toks: ATok[], ev: Evidence) {
  const zips = toks.filter((t) => t.role === "ZIP").map((t) => String(t.value));
  const hasCfOrZip =
    zips.length > 0 || toks.some((t) => t.cls === "CF_UNIT" || t.cls === "CF_PREFIX" || t.cls === "CF_FT" || (t.cls === "NUM" && t.role === "CF"));
  const isCf = (t: ATok | undefined) => !!t && (t.cls === "CF_UNIT" || t.cls === "CF_PREFIX" || t.cls === "CF_FT" || (t.cls === "NUM" && (t.role === "CF" || t.role === "ORDINAL")));

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t.stCand) continue;
    const st = t.stCand;
    const prevT = toks[i - 1];
    const nextT = toks[i + 1];
    const prevNP = prevNonPunct(toks, i);
    const isKeyword = !!t.kw;

    const A = zips.some((z) => stateForZip(z)?.abbr === st);
    const B = !!prevNP && kindOf(prevNP, "TO");
    const C = isPunct(prevT, ",") && isWord(toks[i - 2]);
    const prevOk =
      !prevT || kindOf(prevT, "TO") || isCf(prevT) || prevT.cls === "NUM" || prevT.role === "ZIP" || prevT.cls === "PRICE" ||
      prevT.cls === "PUNCT" || prevT.cls === "ARROW" || prevT.cls === "DATE" || kindOf(prevT, "RFD");
    const nextOk =
      !nextT || nextT.role === "ZIP" || isCf(nextT) || nextT.cls === "NUM" || nextT.cls === "PRICE" || kindOf(nextT, "RFD") ||
      nextT.cls === "DATE" || nextT.cls === "PUNCT" || nextT.cls === "ARROW" || nextT.cls === "MULT";
    const D = t.isUpper && prevOk && nextOk;
    const E = !AMBIGUOUS_ABBR.has(st.toLowerCase()) && hasCfOrZip;

    const ok = A || B || C || (!isKeyword && (D || E));
    if (!ok) continue;
    t.st = st;
    if (st === "LA" && !A) ev.flags.push("ambiguous_la");
  }
}

/** A ZIP or an accepted state sits strictly between two token indices. */
function placeBetween(toks: ATok[], a: number, b: number): boolean {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (let i = lo + 1; i < hi; i++) {
    if (toks[i].role === "ZIP" || toks[i].st || toks[i].stname) return true;
  }
  return false;
}

function selectCf(toks: ATok[], ev: Evidence) {
  const units = toks.map((t, i) => (t.cls === "CF_UNIT" || t.cls === "CF_PREFIX" || t.cls === "CF_FT" ? i : -1)).filter((i) => i >= 0);
  // A learned CF_UNIT keyword after a bare number.
  for (let i = 0; i + 1 < toks.length; i++) {
    if (toks[i].cls === "NUM" && toks[i].role === "CF" && kindOf(toks[i + 1], "CF_UNIT")) units.push(i);
  }
  units.sort((a, b) => a - b);
  ev.cfUnits = units;

  const cands: number[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.cls !== "NUM" || t.role !== "CF") continue;
    const nx = toks[i + 1];
    // "2 bdrm", "3 stops": a count, not cubic feet (unless the "noun" is a state).
    if (isWord(nx) && kindOf(nx, "NOTE_NOUN") && !nx.st && !nx.city) { t.role = "NOTE"; continue; }
    cands.push(i);
  }
  ev.cfCands = cands;

  if (units.length) {
    const first = units[0];
    ev.cf = { value: Number(toks[first].value), source: "unit", idx: first };
    if (toks[first].cls === "CF_FT") ev.flags.push("unit_ft");
    for (const u of units.slice(1)) {
      // A second CF figure is a second job to the SAME destination only when no
      // other place stands between the two. "NC 28202 250cf + SC 29201 180cf"
      // is two destinations written on one line: cloning the first one would
      // invent a delivery nobody posted and drop a real one, so refuse to guess
      // and let A10x send the line to the admin queue instead.
      if (placeBetween(toks, first, u)) { ev.twoDests = true; continue; }
      ev.extraCf.push(Number(toks[u].value));
      toks[u].role = "CF_EXTRA";
    }
    if (ev.extraCf.length) ev.flags.push("multi_job_line");
    for (const c of cands) { if (!units.includes(c)) { toks[c].role = "NOTE"; ev.flags.push("extra_number"); } }
  } else if (cands.length === 1) {
    ev.cf = { value: Number(toks[cands[0]].value), source: "bare", idx: cands[0] };
  } else if (cands.length > 1) {
    const best = cands.reduce((a, b) => (Number(toks[b].value) > Number(toks[a].value) ? b : a));
    ev.cf = { value: Number(toks[best].value), source: "bare", idx: best };
    ev.flags.push("multi_number");
    for (const c of cands) if (c !== best) toks[c].role = "NOTE";
  }
  if (ev.cf) {
    toks[ev.cf.idx].role = "CF";
    if (ev.cf.value < 20) ev.flags.push("low_cf");
    // "350cf x2" -> one more job.
    const nx = toks[ev.cf.idx + 1];
    if (nx?.cls === "MULT") {
      const n = Number(nx.value);
      for (let k = 1; k < n; k++) ev.extraCf.push(ev.cf.value);
      if (n > 1) ev.flags.push("multi_job_line");
    }
  }
}

function classifyPrices(toks: ATok[], ev: Evidence, format: SenderFormat | null) {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.cls !== "PRICE" && t.cls !== "DECIMAL") continue;
    const v = Number(t.value);
    let marker = false;
    let flatWord = false;
    for (let j = i + 1; j <= i + 3 && j < toks.length; j++) {
      const n = toks[j];
      if (kindOf(n, "PERCF")) marker = true;
      if (isWord(n) && /^(flat|total|lump)$/.test(n.norm)) flatWord = true;
      if (isWord(n) && n.norm === "all" && isWord(toks[j + 1]) && toks[j + 1].norm === "in") flatWord = true;
    }
    if (t.cls === "DECIMAL") {
      if (marker) { t.role = "PRICE_PERCF"; if (!ev.price) ev.price = { value: v, kind: "per_cf", basis: "marker", idx: i }; }
      else { t.role = "PRICE_NOTE"; ev.flags.push("unmarked_number"); }
      continue;
    }
    let kind: PriceHit["kind"];
    let basis: PriceHit["basis"];
    if (format?.price_mode === "per_cf") { kind = "per_cf"; basis = "marker"; }
    else if (format?.price_mode === "flat") { kind = "flat"; basis = "marker"; }
    else if (marker) { kind = "per_cf"; basis = "marker"; }
    else if (flatWord) { kind = "flat"; basis = "marker"; }
    else if (v <= 20) { kind = "per_cf"; basis = "threshold"; }
    else if (v >= 100) { kind = "flat"; basis = "threshold"; }
    else { kind = "flat"; basis = "ambiguous"; ev.flags.push("price_ambiguous"); }
    t.role = kind === "per_cf" ? "PRICE_PERCF" : "PRICE_FLAT";
    if (!ev.price) ev.price = { value: v, kind, basis, idx: i };
  }
}

function classifyDates(toks: ATok[], ev: Evidence) {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.cls !== "DATE") continue;
    let deadline = false;
    let note = false;
    for (let j = i - 1; j >= Math.max(0, i - 2); j--) {
      const p = toks[j];
      if (kindOf(p, "DEADLINE")) deadline = true;
      if (isWord(p) && /^(pu|pickup|loading)$/.test(p.norm)) note = true;
    }
    if (deadline) { t.role = "DATE_DEADLINE"; if (ev.dateDeadline < 0) ev.dateDeadline = i; }
    else if (note) t.role = "DATE_NOTE";
    else { t.role = "DATE_READY"; if (ev.dateReady < 0) ev.dateReady = i; }
  }
}

function tagTags(toks: ATok[], ev: Evidence, lex: Lexicon) {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kwHead && t.kw?.kinds.has("TAG") && t.kw.tag) {
      // "hot tub" (hot_tub) beats "hot" (urgent) by phrase length already.
      t.tag = t.kw.tag; t.role = "TAG";
      ev.tags.push(t.kw.tag);
      continue;
    }
    if (t.cls === "ORDWORD" && Number(t.value) === 1 && isWord(toks[i + 1]) && toks[i + 1].norm === "floor") {
      t.tag = "ground_floor"; ev.tags.push("ground_floor");
      continue;
    }
    if (isWord(t) && !t.kw && !t.city && !t.stname && !t.st && !t.stCand && !t.covered) {
      const fz = fuzzyTag(t.norm, lex);
      if (fz) { t.tag = fz; t.role = "TAG"; ev.tags.push(fz); }
    }
  }
  ev.tags = [...new Set(ev.tags)];
}

const FOOTER_RE = /^\s*(all|every|everything|todos?|jobs|loads)\b.*\b(ready|rfd|available|listo)/i;
/**
 * Words that can follow a FROM marker but can never start a place name. Only
 * the first FROM phrase on a line sets fromAt, so a stacked marker ("Loading
 * out of Houston", "Pickup from Houston") leaves its tail in front of the
 * place text; without this the header parses as the city "Out Of Houston",
 * which is both the wrong label and a different origin key for the same
 * warehouse. No US city name is one of these words.
 */
const FROM_CONNECTOR = new Set(["out", "of", "in", "from", "at", "up"]);
const FOOTER_FILLER = new Set(["all", "jobs", "loads", "are", "is", "everything", "todo", "todos", "for", "delivery", "now", "the", "these", "them", "ready"]);

export function annotate(L: ScannedLine, ctx: LineContext): { toks: ATok[]; ev: Evidence } {
  const toks = L.tokens as ATok[];
  const ev: Evidence = {
    hasFrom: false, fromAt: 0, fromRfd: false, hasPin: L.pin, toIdx: [], hasArrow: false,
    cfUnits: [], cfCands: [], cf: null, extraCf: [], zips: [], states: [], stnames: [], cities: [],
    phones: [], contactTrig: false, dm: false, reqHit: false, titleHit: false, footerHit: false,
    chatterHit: false, capacityIdx: -1, paymentHit: false, partialHit: null, rfdIdx: [],
    dateReady: -1, dateDeadline: -1, price: null, tags: [], wordsOnly: false, hasComma: false,
    nameOnly: false, onlyCf: false, onlyRfd: false, onlyPrice: false, onlyDate: false,
    unknownNum: false, keywordHit: false, twoDests: false, wordCount: 0, flags: [],
  };
  if (!toks.length) return { toks, ev };

  tagKeywords(toks, ctx.lex);
  tagPlaces(toks, ctx.lex);
  classifyNumbers(toks, ev, ctx.format);
  acceptStates(toks, ev);
  selectCf(toks, ev);
  classifyPrices(toks, ev, ctx.format);
  classifyDates(toks, ev);
  tagTags(toks, ev, ctx.lex);

  const firstIdx = toks.findIndex((t) => t.cls !== "PUNCT");
  const first = toks[firstIdx];

  // Markers.
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t.kwHead || !t.kw) continue;
    ev.keywordHit = true;
    const k = t.kw.kinds;
    const phraseEnd = toks[i + (t.kwLen ?? 1) - 1].end;
    if (k.has("FROM") && (i === firstIdx || k.has("FROM_ANY")) && !ev.hasFrom) {
      ev.hasFrom = true;
      ev.fromAt = phraseEnd;
      if (/ready|rfd|available/.test(toks.slice(i, i + (t.kwLen ?? 1)).map((x) => x.norm).join(" "))) ev.fromRfd = true;
    }
    if (k.has("TO")) ev.toIdx.push(i);
    if (k.has("RFD")) ev.rfdIdx.push(i);
    if (k.has("TITLE")) ev.titleHit = true;
    if (k.has("CONTACT")) {
      ev.contactTrig = true;
      if (/^(dm|inbox|private|privately|privado)$/.test(t.norm)) ev.dm = true;
    }
    if (k.has("CHATTER")) ev.chatterHit = true;
    if (k.has("PAYMENT")) ev.paymentHit = true;
    if (k.has("CAPACITY") && ev.capacityIdx < 0) ev.capacityIdx = i;
    if (k.has("PARTIAL") && !ev.partialHit) ev.partialHit = toks.slice(i, i + (t.kwLen ?? 1)).map((x) => x.raw).join(" ");
  }
  // "1 more" as a partial marker.
  for (let i = 0; i + 1 < toks.length; i++) {
    if (toks[i].cls === "NUM" && Number(toks[i].value) === 1 && isWord(toks[i + 1]) && toks[i + 1].norm === "more" && !ev.partialHit) ev.partialHit = "1 more";
  }
  if (ev.hasFrom) {
    for (const t of toks) {
      if (t.start < ev.fromAt || t.cls === "PUNCT") continue;
      if (t.cls !== "WORD" || !FROM_CONNECTOR.has(t.norm)) break;
      ev.fromAt = t.end;
    }
  }
  if (L.pin && !ev.hasFrom) ev.fromAt = 0;

  const reqWords = toks.filter((t) => kindOf(t, "REQ")).length;
  const reqObjs = toks.filter((t) => kindOf(t, "REQ_OBJ")).length;
  const reqPhrase = toks.some((t) => t.kwHead && kindOf(t, "REQ_PHRASE"));
  ev.reqHit = reqPhrase || (reqWords > 0 && reqObjs > 0);

  ev.hasArrow = toks.some((t) => t.cls === "ARROW");
  ev.hasComma = toks.some((t) => isPunct(t, ","));
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.role === "ZIP") ev.zips.push(i);
    if (t.st) ev.states.push(i);
    if (t.stname) ev.stnames.push(i);
    if (t.city) ev.cities.push(i);
    if (t.cls === "PHONE" || t.cls === "PHONE7") { ev.phones.push(i); t.role = "PHONE"; }
  }

  const words = toks.filter((t) => t.cls === "WORD");
  ev.wordCount = words.length;
  ev.wordsOnly = words.length > 0 && toks.every((t) => t.cls === "WORD" || t.cls === "PUNCT");
  ev.nameOnly = ev.wordsOnly && words.length <= 3 && !ev.keywordHit && !toks.some((t) => t.cls === "PUNCT" && !/^[.,'’-]$/.test(t.raw));

  const content = toks.filter((t) => t.cls !== "PUNCT");
  ev.onlyCf = content.length === 1 && (content[0].cls === "CF_UNIT" || content[0].cls === "CF_PREFIX" || content[0].cls === "CF_FT" || (content[0].cls === "NUM" && content[0].role === "CF"));
  ev.onlyRfd = content.length > 0 && content.every((t) => kindOf(t, "RFD"));
  ev.onlyPrice = content.length === 1 && content[0].cls === "PRICE";
  ev.onlyDate = content.length === 1 && content[0].cls === "DATE";

  // Footer flag: "All jobs are ready for delivery", "All RFD", "Ready for delivery all".
  const text = L.text.replace(/[^\p{L}\p{N}\s]/gu, " ");
  if (FOOTER_RE.test(text)) ev.footerHit = true;
  else if (ev.onlyRfd) ev.footerHit = true;
  else if (ev.rfdIdx.length && words.every((w) => w.kw?.kinds.has("RFD") || FOOTER_FILLER.has(w.norm)) && !ev.zips.length && !ev.cf) ev.footerHit = true;

  void first;
  return { toks, ev };
}

// ---------------------------------------------------------------------------
// Destination parsing
// ---------------------------------------------------------------------------

/** Read a destination out of a token range. */
export function parseDestination(toks: ATok[], ev: Evidence, from: number, to: number, ctx: LineContext): DestParse {
  const range = toks.slice(from, to);
  const flags: string[] = [];
  const zipTok = range.find((t) => t.role === "ZIP");
  const zip = zipTok ? String(zipTok.value) : null;
  const stTok = range.find((t) => t.st);
  const stnameTok = range.find((t) => t.stname);
  const cityTok = range.find((t) => t.city && (t.isUpper || /^\p{Lu}/u.test(t.raw) || kindOf(prevNonPunct(toks, toks.indexOf(t)), "TO") || t.city.source === "learned"));

  let state: string | null = stTok?.st ?? stnameTok?.stname ?? null;
  let zipStateMismatch = false;
  if (zip) {
    const zs = stateForZip(zip)!.abbr;
    if (state && state !== zs) {
      if (ctx.format?.state_from_zip_only) state = zs;
      else { zipStateMismatch = true; flags.push("zip_state_mismatch"); }
    }
    if (!state) state = zs;
  }

  let city: string | null = null;
  let citySource: DestParse["citySource"] = null;
  let unresolvedCity = false;
  if (cityTok?.city) {
    const hit = cityTok.city;
    citySource = hit.source;
    if (hit.source === "alias" || hit.source === "learned") {
      city = hit.name;
      if (!state && hit.state) state = hit.state;
    } else {
      city = titleCase(range.slice(range.indexOf(cityTok), range.indexOf(cityTok) + (cityTok.cityLen ?? 1)).map((t) => t.raw).join(" "));
      if (!state) {
        if (hit.state) state = hit.state;
        else {
          const r = resolveCityState(city, null);
          if (r) { state = r.state; flags.push(...r.flags); }
          else { unresolvedCity = true; flags.push("dest_unresolved_city"); }
        }
      }
    }
  } else if (!zip && stTok) {
    // A capitalized word run right next to the state that is nothing else.
    const si = range.indexOf(stTok);
    const run = (dir: 1 | -1) => {
      const out: string[] = [];
      for (let j = si + dir; j >= 0 && j < range.length && out.length < 3; j += dir) {
        const t = range[j];
        if (t.cls === "PUNCT" && out.length === 0) continue;
        if (!isWord(t) || t.kw || t.st || t.stname || t.role || !/^\p{Lu}/u.test(t.raw) || NAME_STOP.has(t.norm)) break;
        if (dir === 1) out.push(t.raw); else out.unshift(t.raw);
      }
      return out;
    };
    const after = run(1);
    const before = run(-1);
    const pick = after.length ? after : before;
    if (pick.length) { city = titleCase(pick.join(" ")); citySource = "adjacent"; }
  }

  // Written form, as the post had it.
  const stWritten = stTok ? stTok.raw.toUpperCase() : stnameTok ? titleCase(range.slice(range.indexOf(stnameTok), range.indexOf(stnameTok) + (stnameTok.stnameLen ?? 1)).map((t) => t.raw).join(" ")) : null;
  let written: string;
  if (zip) written = city && stTok ? `${city}, ${stTok.raw.toUpperCase()} ${zip}` : `${state} ${zip}`;
  else if (city && stTok) {
    const stIdx = range.indexOf(stTok);
    const cIdx = range.indexOf(cityTok ?? stTok);
    written = cityTok && cIdx > stIdx ? `${stTok.raw.toUpperCase()} ${city}` : cityTok ? `${city}, ${stTok.raw.toUpperCase()}` : `${stTok.raw.toUpperCase()} ${city}`;
    if (!cityTok) {
      const idxOfCity = range.findIndex((t) => t.raw === city!.split(" ")[0]);
      written = idxOfCity > stIdx ? `${stTok.raw.toUpperCase()} ${city}` : `${city}, ${stTok.raw.toUpperCase()}`;
    }
  } else if (city && state && !unresolvedCity) written = `${city}, ${state}`;
  else if (city) written = city;
  else written = stWritten ?? state ?? "";

  // Notes and leftover words: everything that is not structure.
  const noteParts: string[] = [];
  let leftover = 0;
  let stop = false;
  for (const t of range) {
    if (stop) break;
    if (t.role === "PHONE" || (t.kw?.kinds.has("CONTACT") && t.kwHead)) { stop = true; break; }
    if (t.cls === "PUNCT" || t.cls === "ARROW") continue;
    if (t.role === "ZIP" || t.role === "CF" || t.role === "CF_EXTRA" || t.role === "ORDINAL" || t.role === "ZIP4") continue;
    if (t.cls === "CF_UNIT" || t.cls === "CF_PREFIX" || t.cls === "CF_FT" || t.cls === "MULT") continue;
    if (t.role === "PRICE_PERCF" || t.role === "PRICE_FLAT") continue;
    if (t.role === "DATE_READY" || t.role === "DATE_DEADLINE") continue;
    if (t.st || t.stname || t.city) continue;
    // Words inside a tag phrase ("HOT TUBE") stay in the notes verbatim; words
    // inside a city/state phrase or a marker do not.
    if (t.covered && !t.kw?.kinds.has("TAG")) continue;
    if (t.kw && (t.kw.kinds.has("TO") || t.kw.kinds.has("RFD") || t.kw.kinds.has("PERCF") || t.kw.kinds.has("DEADLINE") || t.kw.kinds.has("FROM"))) continue;
    if (t.cls === "WORD" && citySource === "adjacent" && city && city.split(" ").some((w) => w.toLowerCase() === t.norm)) continue;
    noteParts.push(t.raw);
    if (t.cls === "WORD" && !t.tag) leftover++;
  }

  const rfd = range.some((t) => kindOf(t, "RFD") && t.kwHead);
  const readyDateTok = range.find((t) => t.role === "DATE_READY");
  const deadlineTok = range.find((t) => t.role === "DATE_DEADLINE");
  const priceTok = ev.price && range.includes(toks[ev.price.idx]) ? ev.price : null;

  const sig = destSig(range, ev, priceTok);
  const cf = ev.cf && range.includes(toks[ev.cf.idx]) ? ev.cf : null;

  return {
    state, zip, city, citySource, written,
    stateOnly: !zip && !city && !!state,
    unresolvedCity,
    cf: cf?.value ?? null,
    cfSource: cf?.source ?? null,
    extraCf: [...ev.extraCf],
    price: priceTok,
    rfd,
    readyDateText: readyDateTok ? String(readyDateTok.value) : null,
    deliverByText: deadlineTok ? String(deadlineTok.value) : null,
    tags: [...new Set(range.filter((t) => t.tag).map((t) => t.tag!))],
    notes: noteParts.length ? noteParts.join(" ") : null,
    flags,
    sig,
    leftoverWords: leftover,
    zipStateMismatch,
  };
}

/** Structural signature of a destination line: classes in order of appearance. */
function destSig(range: ATok[], ev: Evidence, price: PriceHit | null): string {
  const parts: string[] = [];
  let words = false;
  for (const t of range) {
    let p: string | null = null;
    if (t.kwHead && kindOf(t, "TO")) p = "TO";
    else if (t.st) p = "ST";
    else if (t.stname) p = "ST";
    else if (t.role === "ZIP") p = "ZIP";
    else if (t.cls === "CF_UNIT" || t.cls === "CF_PREFIX" || t.cls === "CF_FT") p = "CFu";
    else if (t.cls === "NUM" && t.role === "CF") p = "CF";
    else if (t.role === "PRICE_PERCF" || t.role === "PRICE_FLAT") p = "PRICE";
    else if (t.kwHead && kindOf(t, "RFD")) p = "RFD";
    else if (t.role === "DATE_READY" || t.role === "DATE_DEADLINE") p = "DATE";
    else if (t.city) p = "CITY";
    else if (t.cls === "WORD" && !t.covered && !t.kw && !t.stCand) words = true;
    else if (t.tag) words = true;
    if (p && parts[parts.length - 1] !== p) parts.push(p);
  }
  if (words) parts.push("WORDS");
  void ev; void price;
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Pass A (context-free)
// ---------------------------------------------------------------------------

/**
 * Does the FROM/pin place text carry its own job ("📍 FL 33435 350cf")?
 * Decided on the place text AFTER annotation stripping, so a street number
 * ("From 45 Schuyler Ave Kearny NJ 07032") or a count ("FROM PHOENIX AZ 10
 * LOADS") is never read as cubic feet.
 */
function placeTextHasJob(L: Line, raw: string, ctx: LineContext): boolean {
  const stripped = stripAnnotations(raw, ctx.lex).text;
  if (!stripped) return false;
  const toks = tokenizeLine(stripped, 0).tokens;
  if (toks.some((t) => t.cls === "CF_UNIT" || t.cls === "CF_PREFIX" || t.cls === "CF_FT")) return true;
  const bare = toks.some((t, i) => {
    if (t.cls !== "NUM") return false;
    const v = Number(t.value);
    const nx = toks[i + 1];
    if (v < 10 || v > 5000) return false;
    if (nx && nx.cls === "WORD" && /^(jobs?|loads?|trucks?)$/.test(nx.norm)) return false;
    return true;
  });
  const hasPlace = toks.some((t) => (t.cls === "ZIP" && stateForZip(String(t.value))) || (t.cls === "WORD" && t.norm.length === 2 && STATE_BY_ABBR.has(t.norm.toUpperCase())));
  void L;
  return bare && hasPlace;
}

/** LANE: two place groups on one line. */
function detectLane(L: Line, ctx: LineContext): Line["lane"] | null {
  const toks = L.toks;
  const text = L.s.text;
  // Candidate separators, left to right.
  const seps: Array<{ idx: number; kind: "arrow" | "to" | "dash" | "colon" }> = [];
  const fromEnd = L.ev.hasFrom ? L.ev.fromAt : -1;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.cls === "ARROW") seps.push({ idx: i, kind: "arrow" });
    else if (t.kwHead && kindOf(t, "TO") && i > 0 && t.start > fromEnd) seps.push({ idx: i, kind: "to" });
    else if (t.cls === "PUNCT" && /^[-–—]$/.test(t.raw) && i > 0 && /\s/.test(text[t.start - 1] ?? "") && /\s/.test(text[t.end] ?? "")) seps.push({ idx: i, kind: "dash" });
    else if (t.cls === "PUNCT" && t.raw === ":" && L.ev.hasFrom && t.start > fromEnd + 1 && i > 0) seps.push({ idx: i, kind: "colon" });
  }
  for (const sep of seps) {
    const leftToks = toks.slice(0, sep.idx).filter((t) => t.start >= Math.max(0, fromEnd));
    const rightToks = toks.slice(sep.idx + (sep.kind === "to" ? (toks[sep.idx].kwLen ?? 1) : 1));
    if (!leftToks.length || !rightToks.length) continue;
    // Left: a place, no cubic feet.
    if (leftToks.some((t) => t.cls === "CF_UNIT" || t.cls === "CF_PREFIX" || t.cls === "CF_FT" || (t.cls === "NUM" && t.role === "CF") || t.cls === "PRICE")) continue;
    if (!leftToks.some((t) => t.cls === "WORD")) continue;
    const leftText = text.slice(leftToks[0].start, leftToks[leftToks.length - 1].end).replace(/^[\s:]+/, "");
    const origin = parseHeader(leftText, ctx.lex, ctx.rules);
    if (!origin.ok || (!origin.city && !origin.state)) continue;
    // Right: a place with ZIP/ST/CITY (+ CF for the FROM/colon form).
    const rightHasPlace = rightToks.some((t) => t.role === "ZIP" || t.st || t.stname || (t.city && (t.isUpper || /^\p{Lu}/u.test(t.raw))));
    if (!rightHasPlace) continue;
    const rightHasCf = rightToks.some((t) => t.cls === "CF_UNIT" || t.cls === "CF_PREFIX" || t.cls === "CF_FT" || (t.cls === "NUM" && t.role === "CF"));
    if ((L.ev.hasFrom || sep.kind === "colon") && !rightHasCf) continue;
    const from = toks.indexOf(rightToks[0]);
    const dest = parseDestination(toks, L.ev, from, toks.length, ctx);
    if (!dest.state && !dest.zip && !dest.city) continue;
    return { origin, setsOrigin: L.ev.hasFrom, dest, rawOrigin: leftText };
  }
  return null;
}

function ignoreRule(L: Line, ctx: LineContext): LineClass | null {
  if (!ctx.rules.ignoreLines.length) return null;
  const key = normalizeRuleKey(L.s.text);
  const r = ctx.rules.ignoreLines.find((x) => normalizeRuleKey(x.text) === key);
  if (!r) return null;
  switch (r.as) {
    case "chatter": return "CHATTER";
    case "requirement": return "REQUIREMENT";
    case "title": return "TITLE";
    case "decoration": return "DECORATION";
    case "contact": return "CONTACT";
  }
}

function templateRule(L: Line, ctx: LineContext): boolean {
  for (const t of ctx.rules.lineTemplates) {
    let re: RegExp;
    try { re = compileTemplate(t); } catch { continue; }
    const m = re.exec(L.s.text.trim());
    if (!m) continue;
    const g = m.groups ?? {};
    if (t.kind === "destination") {
      // Pre-label: the named groups decide the roles; the normal parse continues.
      for (const tok of L.toks) {
        if (g.ZIP && tok.raw === g.ZIP) tok.role = "ZIP";
        if (g.ST && tok.norm.toUpperCase() === g.ST.toUpperCase()) tok.st = g.ST.toUpperCase();
        if (g.CF && tok.cls === "NUM" && tok.raw.replace(/,/g, "") === g.CF.replace(/[^\d]/g, "")) tok.role = "CF";
      }
      L.ev.zips = L.toks.map((x, i) => (x.role === "ZIP" ? i : -1)).filter((i) => i >= 0);
      L.ev.states = L.toks.map((x, i) => (x.st ? i : -1)).filter((i) => i >= 0);
      const cfTok = L.toks.find((x) => x.role === "CF");
      if (cfTok && !L.ev.cf) L.ev.cf = { value: Number(cfTok.value), source: "bare", idx: L.toks.indexOf(cfTok) };
      L.flags.push("template:" + t.id);
      return true;
    }
    if (t.kind === "header" && !L.ev.hasFrom) {
      L.ev.hasFrom = true;
      L.ev.fromAt = 0;
      L.flags.push("template:" + t.id);
      return true;
    }
  }
  return false;
}

function contactOf(L: Line, ctx: LineContext, contactLine: boolean): { name: string | null; phone: string | null; phoneOnly: boolean } {
  const toks = L.toks;
  const phoneIdx = L.ev.phones[0] ?? -1;
  const trigIdx = toks.findIndex((t) => t.kwHead && kindOf(t, "CONTACT"));
  let name: string | null = null;
  if (trigIdx >= 0) name = nameRunAfter(toks, trigIdx + (toks[trigIdx].kwLen ?? 1) - 1, phoneIdx, ctx.lex);
  if (!name && phoneIdx >= 0) {
    const before = nameRunBefore(toks, phoneIdx, ctx.lex);
    if (before && (before.start >= 0 || contactLine)) name = before.name;
    if (!name) {
      const after = nameRunAfter(toks, phoneIdx, -1, ctx.lex);
      if (after && contactLine) name = after;
    }
  }
  if (name && /^\p{Lu}/u.test(name) === false && !contactLine) name = null;
  let phone: string | null = null;
  if (phoneIdx >= 0) {
    const p = normalizePhone(toks[phoneIdx].raw);
    phone = p.e164 ?? p.display;
  }
  const phoneOnly = phoneIdx >= 0 && !name && toks.filter((t) => t.cls !== "PUNCT").length === L.ev.phones.length;
  return { name, phone, phoneOnly };
}

export function classifyA(L: Line, ctx: LineContext): void {
  const { ev, toks } = L;
  const set = (cls: LineClass, reason: string, sub: Line["sub"] = null) => { L.cls = cls; L.reason = reason; L.sub = sub; };

  if (isBlank(L.s)) return set("BLANK", "A1");
  if (isDecoration(L.s)) return set("DECORATION", "A2");
  if (L.s.readMore) return set("READMORE", "A3");

  const ignored = ignoreRule(L, ctx);
  if (ignored) return set(ignored, "rule:ignore_line");
  templateRule(L, ctx);

  // A4 LANE
  const lane = detectLane(L, ctx);
  if (lane) {
    L.lane = lane;
    return set("LANE", "A4");
  }

  // A7 HEADER (FROM / pin), or a destination that carries its own pin.
  if (ev.hasFrom || ev.hasPin) {
    const placeStart = ev.hasFrom ? ev.fromAt : 0;
    let raw = L.s.text.slice(placeStart);
    if (!ev.hasFrom) raw = raw.replace(/^\s*[📍📌]/u, "");
    if (placeTextHasJob(L, raw, ctx)) {
      const from = toks.findIndex((t) => t.start >= placeStart);
      L.dest = parseDestination(toks, ev, Math.max(0, from), toks.length, ctx);
      L.contacts.push(...lineContacts(L, ctx));
      return set("DESTINATION", "A7d", L.dest.stateOnly ? "incomplete" : L.dest.cf == null ? "cf-null" : null);
    }
    // Cut at a TO marker after the place ("From Los Angeles to:" already stripped; "From NJ to FL" keeps the origin).
    const toTok = toks.find((t) => t.kwHead && kindOf(t, "TO") && t.start > placeStart);
    if (toTok) raw = L.s.text.slice(placeStart, toTok.start);
    const parse = parseHeader(raw, ctx.lex, ctx.rules);
    if (!parse.ok) {
      L.flags.push("header_unparsed");
      return set("UNKNOWN", "A7u");
    }
    L.contacts.push(...parse.contacts);
    if (ev.fromRfd) parse.blockReady = true;
    const kind = ev.hasFrom ? "from" : "pin";
    L.header = { parse, kind, sig: headerSig(parse, ev.hasFrom ? "FROM" : "PIN"), rawPlace: raw.trim() };
    return set("HEADER", "A7", parse.stateOnly ? "state-only" : parse.state ? null : "city-only");
  }

  const hasCf = !!ev.cf;
  const hasZip = ev.zips.length > 0;

  // A9 FOOTER_FLAG (before chatter: "All jobs are ready for delivery" starts with a chatter word).
  if (ev.footerHit && !hasZip && !hasCf) {
    // An RFD-only line directly under a destination is that job's continuation (B16).
    if (ev.onlyRfd && L.prevIsDestination) return set("UNKNOWN", "A9→B");
    return set("FOOTER_FLAG", "A9");
  }
  // A6 REQUIREMENT
  if (ev.reqHit && !hasZip && !ev.cfUnits.length) return set("REQUIREMENT", "A6");
  // A5 CHATTER
  if (ev.capacityIdx >= 0 && !hasZip && (!ev.cf || ev.capacityIdx < ev.cf.idx)) return set("CHATTER", "A5c");
  if ((ev.chatterHit || ev.paymentHit) && !hasZip && !hasCf) return set("CHATTER", "A5");
  // A8 TITLE
  const hasPlace = hasZip || ev.states.length > 0 || ev.stnames.length > 0 || ev.cities.some((i) => toks[i].isUpper || /^\p{Lu}/u.test(toks[i].raw));
  if (ev.titleHit && !hasZip && !hasCf && !hasPlace) return set("TITLE", "A8");

  // A10 DESTINATION
  const capCity = ev.cities.find((i) => toks[i].isUpper || /^\p{Lu}/u.test(toks[i].raw) || kindOf(prevNonPunct(toks, i), "TO"));
  const hasTo = ev.toIdx.length > 0;
  const isDest =
    hasZip ||
    (ev.states.length > 0 && hasCf) ||
    (capCity !== undefined && hasCf) ||
    (hasTo && (hasZip || ev.states.length > 0 || capCity !== undefined || ev.stnames.length > 0));
  const bare = bareShape(L, ctx);
  if (isDest && !(bare && !hasTo && !hasCf)) {
    // Two place groups with no separator.
    const placeGroups = ev.states.filter((i) => isWord(toks[i - 1]) && !toks[i - 1].kw).length + (ev.stnames.length && ev.cities.length ? 0 : 0);
    if (ev.twoDests || (ev.states.length >= 2 && placeGroups >= 2)) {
      L.flags.push("two_places");
      return set("UNKNOWN", "A10x");
    }
    L.dest = parseDestination(toks, ev, 0, toks.length, ctx);
    L.contacts.push(...lineContacts(L, ctx));
    return set("DESTINATION", "A10", L.dest.stateOnly ? "incomplete" : L.dest.cf == null ? "cf-null" : null);
  }

  // A10b CONTACT
  if (ev.phones.length && !hasZip && !hasCf) {
    const c = contactOf(L, ctx, true);
    L.contact = { ...c, mode: ev.dm ? "dm" : "public" };
    L.contacts.push({ name: c.name, phone: c.phone });
    return set("CONTACT", "A10b");
  }
  if (ev.contactTrig && !hasZip && !hasCf && capCity === undefined) {
    const c = contactOf(L, ctx, true);
    L.contact = { ...c, mode: ev.dm ? "dm" : "public" };
    if (c.name || c.phone) L.contacts.push({ name: c.name, phone: c.phone });
    return set("CONTACT", "A10b");
  }

  set("UNKNOWN", "A-", bare ? "bare" : null);
}

/** Contacts found on a job/header line: phones, and a name after a trigger. */
function lineContacts(L: Line, ctx: LineContext): HeaderContact[] {
  if (!L.ev.phones.length && !L.ev.contactTrig) return [];
  const c = contactOf(L, ctx, false);
  if (!c.phone && !c.name) return [];
  return [{ name: c.name, phone: c.phone }];
}

function headerSig(p: HeaderParse, prefix: "FROM" | "PIN" | ""): string {
  const parts: string[] = [];
  if (prefix) parts.push(prefix);
  if (p.stateOnly) parts.push(p.stateAsName ? "STNAME" : "ST");
  else {
    parts.push("CITY");
    if (p.stateExplicit) parts.push(p.stateAsName ? "STNAME" : "ST");
    if (p.zip) parts.push("ZIP");
  }
  return parts.join(" ");
}

/**
 * "Kearny, NJ 07032" / "Rochester, Minnesota" / "Toledo, OH" / "Denver CO":
 * a header-shaped line with no FROM/pin, no CF, no TO, no price.
 */
function bareShape(L: Line, ctx: LineContext): HeaderParse | null {
  const { ev, toks } = L;
  if (ev.cf || ev.toIdx.length || ev.price || ev.phones.length || ev.rfdIdx.length || ev.dateReady >= 0 || ev.keywordHit) return null;
  if (ev.wordCount === 0 || ev.wordCount > 5) return null;
  if (toks.some((t) => t.cls !== "WORD" && t.cls !== "PUNCT" && t.role !== "ZIP")) return null;
  const p = parseHeader(L.s.text, ctx.lex, ctx.rules);
  if (!p.ok) return null;
  if (!p.state && !p.city) return null;
  // A city-only shape needs a gazetteer/alias city phrase to count here (B14);
  // an unknown word run is B15's business.
  if (!p.state && !ev.cities.length) return null;
  return p;
}

// ---------------------------------------------------------------------------
// Pass B (neighbour-dependent) and P6
// ---------------------------------------------------------------------------

function prevContent(lines: Line[], i: number): Line | null {
  for (let j = i - 1; j >= 0; j--) if (lines[j].cls !== "BLANK") return lines[j];
  return null;
}
function nextContent(lines: Line[], i: number): { line: Line; blanks: number } | null {
  let blanks = 0;
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].cls === "BLANK") { blanks++; continue; }
    return { line: lines[j], blanks };
  }
  return null;
}

export function classifyB(lines: Line[], i: number, ctx: LineContext): void {
  const L = lines[i];
  if (L.cls !== "UNKNOWN") return;
  const { ev, toks } = L;
  const set = (cls: LineClass, reason: string, sub: Line["sub"] = null) => { L.cls = cls; L.reason = reason; L.sub = sub; };
  const prev = prevContent(lines, i);
  const next = nextContent(lines, i);
  const prevKind = prev?.cls ?? "START";
  const startish = !prev || prev.cls === "DECORATION" || prev.cls === "TITLE" || (prev.cls === "HEADER" && prev.sub === "state-only");
  const isCaps = toks.filter((t) => t.cls === "WORD").every((t) => t.isUpper || /^\p{Lu}/u.test(t.raw));

  // B11 CONTACT_NAME
  if (ev.nameOnly && next && next.blanks <= 1 && next.line.cls === "CONTACT" && next.line.contact?.phoneOnly) {
    const name = toks.filter((t) => t.cls === "WORD").map((t) => t.raw.replace(/[.:]+$/, "")).join(" ");
    next.line.contact!.name = titleCase(name);
    next.line.contacts = [{ name: titleCase(name), phone: next.line.contact!.phone }];
    return set("CONTACT_NAME", "B11");
  }

  const bare = L.sub === "bare" ? bareShape(L, ctx) : null;

  // B12 DESTINATION (cf null): "Denver CO" right under jobs; "Orlando FL 32801"
  // anywhere mid-list (a ZIP with no comma and no blank line above is a job).
  if (bare && bare.state && !bare.stateOnly && !ev.hasComma && !ev.stnames.length && L.s.emojiCount === 0 && !L.s.blankBefore &&
      ((prev && (prev.cls === "DESTINATION" || prev.cls === "HEADER" || prev.cls === "LANE")) || bare.zip)) {
    L.dest = parseDestination(toks, ev, 0, toks.length, ctx);
    if (!L.dest.state) { L.dest.state = bare.state; L.dest.written = bare.city ? `${bare.city}, ${bare.state}` : bare.state!; L.dest.city = bare.city; L.dest.stateOnly = !bare.city; }
    L.flags.push("cfless_destination");
    return set("DESTINATION", "B12", "cf-null");
  }

  // B13 HEADER (state-only): "NEW JERSEY", "NJ", "FL:".
  const contentToks = toks.filter((t) => t.cls !== "PUNCT");
  if (contentToks.length && contentToks.every((t) => t.cls === "WORD") && !ev.keywordHit) {
    const stname = contentToks.length === (contentToks[0].stnameLen ?? 0) && contentToks[0].stname ? contentToks[0].stname : null;
    const abbr = contentToks.length === 1 && contentToks[0].isUpper && contentToks[0].stCand ? contentToks[0].stCand : null;
    if (stname || abbr) {
      const parse = parseHeader(L.s.text, ctx.lex, ctx.rules);
      if (parse.ok && parse.stateOnly) {
        L.header = { parse, kind: "state", sig: headerSig(parse, ""), rawPlace: L.s.text.trim() };
        return set("HEADER", "B13", "state-only");
      }
    }
  }

  // B14 HEADER (bare place)
  if (bare && (L.s.blankBefore || ev.hasComma || ev.stnames.length || L.s.emojiCount > 0 || startish || prevKind === "BLANK")) {
    L.contacts.push(...bare.contacts);
    L.header = { parse: bare, kind: "bare", sig: headerSig(bare, ""), rawPlace: L.s.text.trim() };
    return set("HEADER", "B14", bare.state ? null : "city-only");
  }

  // B15 HEADER (city-only, unresolved): "🏞Modesto 🏞", "Kearny" under "NEW JERSEY".
  if (ev.wordsOnly && ev.wordCount <= 3 && !ev.keywordHit && isCaps &&
      ((prev?.cls === "HEADER" && prev.sub === "state-only") || (next?.line.cls === "DESTINATION" && (startish || prevKind === "BLANK")))) {
    const parse = parseHeader(L.s.text, ctx.lex, ctx.rules);
    if (parse.ok && parse.city) {
      L.header = { parse, kind: "city", sig: headerSig(parse, ""), rawPlace: L.s.text.trim() };
      return set("HEADER", "B15", parse.state ? null : "city-only");
    }
  }

  // B16 CONTINUATION
  if ((ev.onlyCf || ev.onlyRfd || ev.onlyPrice || ev.onlyDate) && i > 0 && lines[i - 1].cls === "DESTINATION") {
    L.continuation = {};
    if (ev.onlyCf && ev.cf) L.continuation.cf = ev.cf.value;
    if (ev.onlyRfd) L.continuation.rfd = true;
    if (ev.onlyPrice && ev.price) L.continuation.price = ev.price;
    if (ev.onlyDate && ev.dateReady >= 0) L.continuation.dateText = String(toks[ev.dateReady].value);
    L.flags.push("continuation");
    return set("CONTINUATION", "B16");
  }
  if (ev.onlyRfd) return set("FOOTER_FLAG", "B16f");

  // B17 NOTE: tag-only lines ("Piano Included").
  const tagOnly = ev.tags.length > 0 && toks.filter((t) => t.cls === "WORD").every((t) => t.tag || t.covered || /^(included?|includes|incl|with|has|and|a|an|the|only|plus|no)$/.test(t.norm));
  if (tagOnly && !ev.cf && !ev.zips.length) {
    L.noteTags = ev.tags;
    return set("NOTE", "B17");
  }

  // B18 UNKNOWN
  if (ev.unknownNum || ev.zips.length || ev.cf || ev.cfCands.length || toks.some((t) => t.cls === "NUM" || t.cls === "ZIP")) L.flags.push("unknown_numeric");
  set("UNKNOWN", "B18");
}

/** P6: a header that owns no jobs is not a header. */
export function demoteHeaders(lines: Line[]): void {
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (L.cls !== "HEADER") continue;
    let owns = false;
    let nextIsCityHeader = false;
    let first = true;
    for (let j = i + 1; j < lines.length; j++) {
      const N = lines[j];
      if (N.cls === "BLANK" || N.cls === "DECORATION") continue;
      if (first) { nextIsCityHeader = N.cls === "HEADER" && N.sub !== "state-only"; first = false; }
      if (N.cls === "HEADER" || N.cls === "TITLE") break;
      if (N.cls === "DESTINATION" || N.cls === "LANE" || N.cls === "CONTINUATION") { owns = true; break; }
    }
    if (owns) continue;
    if (L.sub === "state-only" && nextIsCityHeader) continue;
    L.cls = "UNKNOWN";
    L.reason = "P6";
    L.flags.push("header_without_jobs");
  }
}

// ---------------------------------------------------------------------------
// Message pass (P7)
// ---------------------------------------------------------------------------

export interface MessagePass {
  contacts: HeaderContact[];
  dm: boolean;
  requirements: string[];
  messageReady: { ready_now: boolean; source: "footer" | "title" | null };
  rfdAnywhere: boolean;
  headerSigs: string[];
  destSigs: string[];
  dominant: string | null;
  formatSignature: string;
  partialMarker: string | null;
  unknownLines: number;
}

export function messagePass(lines: Line[], ctx: LineContext): MessagePass {
  const contacts: HeaderContact[] = [];
  let dm = false;
  const requirements: string[] = [];
  let messageReady: MessagePass["messageReady"] = { ready_now: false, source: null };
  let rfdAnywhere = false;
  const headerSigs = new Set<string>();
  const destSigCounts = new Map<string, number>();
  let partialMarker: string | null = null;
  let nonEmpty = 0;
  let unknownLines = 0;

  for (const L of lines) {
    if (L.cls !== "BLANK" && L.cls !== "DECORATION") nonEmpty++;
    if (nonEmpty <= 3 && L.ev.partialHit && !partialMarker) partialMarker = L.ev.partialHit;
    for (const c of L.contacts) contacts.push(c);
    if (L.cls === "CONTACT" && L.contact?.mode === "dm") dm = true;
    if (L.ev.dm) dm = true;
    if (L.cls === "REQUIREMENT") {
      requirements.push(L.s.text.replace(/[^\p{L}\p{N}\s&,.'’\-\/()]/gu, "").replace(/\s+/g, " ").trim());
      if (L.ev.footerHit) messageReady = { ready_now: true, source: "footer" };
    }
    if (L.cls === "FOOTER_FLAG") messageReady = { ready_now: true, source: "footer" };
    if (L.cls === "HEADER" && L.sub === "state-only" && L.header?.parse.blockReady) {
      if (!messageReady.ready_now) messageReady = { ready_now: true, source: "title" };
    }
    if (L.cls === "TITLE" && L.ev.rfdIdx.length) {
      if (!messageReady.ready_now) messageReady = { ready_now: true, source: "title" };
    }
    if (L.ev.rfdIdx.length || L.ev.dateReady >= 0 || (L.header?.parse.blockReady) || (L.header?.parse.blockReadyDate)) rfdAnywhere = true;
    if (L.cls === "HEADER" && L.header) headerSigs.add(L.header.sig);
    if (L.cls === "LANE") headerSigs.add("LANE");
    if (L.cls === "DESTINATION" && L.dest && !L.dest.stateOnly) {
      destSigCounts.set(L.dest.sig, (destSigCounts.get(L.dest.sig) ?? 0) + 1);
    }
    if (L.cls === "UNKNOWN") unknownLines++;
  }

  let dominant: string | null = null;
  let best = 0;
  for (const [sig, n] of destSigCounts) if (n > best) { best = n; dominant = sig; }

  const formatSignature =
    "H:" + [...headerSigs].sort().join("+") + "|D:" + [...destSigCounts.keys()].sort().join("+");

  void ctx;
  return {
    contacts, dm, requirements, messageReady, rfdAnywhere,
    headerSigs: [...headerSigs].sort(), destSigs: [...destSigCounts.keys()].sort(), dominant,
    formatSignature, partialMarker, unknownLines,
  };
}

/** Resolve a written date against the send time; null when it is not a date. */
export function resolveDate(text: string | null, sentAt: Date): string | null {
  return resolveDatePhrase(text, sentAt);
}

export function localSendDate(sentAt: Date): string {
  return isoOf(toLocalDate(sentAt));
}
