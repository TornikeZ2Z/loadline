/**
 * The tokenizer (inventory-v1, A §3.1).
 *
 * One sticky scanner, tried in a fixed order at the current index; the first
 * pattern that matches wins. There is deliberately NO placeholder substitution:
 * the v1 extractor masked phones as "p1" and then re-read the digit as cubic
 * feet. Every token keeps its offsets into the original line, so the admin
 * gutter can point at the exact characters.
 *
 * Numbers are only *classified* here (5 digits -> ZIP candidate, 1-4 digits ->
 * NUM). Whether a 5-digit run is a ZIP or a very large CF, and whether a bare
 * NUM is the cubic feet, is decided per line in ./lines.ts with the whole line
 * as context.
 */
import { hasContactWord } from "./lexicon";

export type TokenClass =
  | "ARROW"
  | "PHONE"
  | "PHONE7"
  | "PRICE"
  | "DATE"
  | "CF_PREFIX"
  | "CF_UNIT"
  | "CF_FT"
  | "WEIGHT"
  | "LENGTH"
  | "TIME"
  | "ORDWORD"
  | "MULT"
  | "ZIP"
  | "BIGNUM"
  | "DECIMAL"
  | "NUM"
  | "WORD"
  | "PUNCT";

export interface Token {
  cls: TokenClass;
  raw: string;
  /** Lowercased; trailing "." / ":" stripped for WORDs. */
  norm: string;
  /** Numeric value for NUM/ZIP(candidate)/CF/PRICE/WEIGHT..., the phrase for DATE. */
  value?: number | string | null;
  start: number;
  end: number;
  /** WORD has letters and none of them lowercase. */
  isUpper: boolean;
  /** DATE: which sub-pattern matched. */
  dateForm?: "mon" | "dmon" | "num";
  /** DATE_NUM separator ("/" or "-"). */
  dateSep?: string;
}

export interface ScannedLine {
  n: number;
  text: string;
  tokens: Token[];
  pin: boolean;
  emojiCount: number;
  emojiOnly: boolean;
  readMore: boolean;
  blankBefore: boolean;
}

const MONTHS =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

const NOT_DATE_NOUN =
  "house|home|bdrm?|bd|br|beds?|baths?|ba|rooms?|truck|loads?|days?|weeks?|hrs?|hours?|floors?|stops?";

const RE = {
  ws: /\s+/y,
  arrow: /(?:-->|->|=>|→|➜|➡|⇒|>>|»)/y,
  phone: /(?:\+?1[\s.\-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.\-])\d{3}[\s.\-]\d{4}(?!\d)|(?<!\d)\+?1?\d{10}(?!\d)/y,
  phone7: /(?<!\d)\d{3}[\s.\-]\d{4}(?!\d)/y,
  // The two-digit comma form ("$3,50" = 3.50) is tried first so "$3,500" cannot
  // be cut down to "$3".
  price: /\$\s?(\d{1,3}),(\d{2})(?!\d)|\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?!\d)|(?<![\d.])(\d+(?:\.\d{1,2})?)\$(?![\d.])/y,
  dateMon: new RegExp(
    String.raw`(?<![\p{L}])(${MONTHS})\.?\s*(\d{1,2})(?:st|nd|rd|th)?(?![\d\p{L}])(?!\s*(?:days?|weeks?|hrs?|hours?)\b)`,
    "iuy",
  ),
  dateDmon: new RegExp(
    String.raw`(?<![\d.])(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s+)?(${MONTHS})(?![\p{L}])`,
    "iuy",
  ),
  dateNum: new RegExp(
    String.raw`(?<![\d\/\-])(\d{1,2})([\/\-])(\d{1,2})(?:\2(\d{2,4}))?(?![\d\/\-])(?!\s*(?:${NOT_DATE_NOUN})\b)`,
    "iy",
  ),
  cfPrefix: /(?<![\p{L}])(?:cf|c\/f|cubic\s*(?:feet|ft)|cubes?)\s*[:=]\s*(\d{1,3}(?:,\d{3})+|\d{1,5})(?!\d)/iuy,
  // Four digits, not five: "33101 CF" would otherwise be eaten whole as 33101
  // cubic feet before the scanner ever reaches the ZIP, and a five-digit run's
  // ZIP-vs-CF question belongs to lines.ts, which has the whole line to read.
  // The comma form keeps five figures working ("12,000 cf"), and a bare number
  // over 5000 is already refused as cubic feet in classifyNumbers.
  cfUnit: /(?<![\d.])(\d{1,3}(?:,\d{3})+|\d{1,4})\s*\.?\s*(c\s*\/\s*f|c\.f\.?|cf|cu\.?\s*ft\.?|cuft|cubic(?:\s*(?:feet|ft|foot))?|cubes?|cubos?|pies(?:\s*c[uú]bicos)?|cu)(?![\p{L}])/iuy,
  cfFt: /(?<![\d.])(\d{3,4})\s*(?:ft|feet)(?![\p{L}])/iuy,
  weight: /(?<![\d.])(\d{1,3}(?:,\d{3})+|\d{1,6})\s*(?:lbs?|pounds?|kgs?|kilos?)(?![\p{L}])/iuy,
  length: /(?<![\d.])(\d{2})\s*(?:ft|feet|')(?![\p{L}\d])/iuy,
  time: /(?<![\d.])(\d{1,2})(?::\d{2})?\s*(?:am|pm)(?![\p{L}])/iuy,
  ordword: /(?<![\d.])(\d{1,2})(?:st|nd|rd|th)(?![\p{L}])/iuy,
  mult: /(?:x|×)\s?(\d)(?!\d)|\((\d)\)/iy,
  stZip: /([A-Za-z]{2})(\d{5})(?!\d)/y,
  bignum: /(?<![\d.])\d{6,}(?!\d)/y,
  zip: /(?<![\d.])(\d{5})(?!\d)/y,
  decimal: /(?<![\d.])(\d{1,4})\.(\d{1,2})(?!\d)/y,
  num: /(?<![\d.])(\d{1,3}(?:,\d{3})+|\d{1,4})(?!\d)/y,
  word: /[\p{L}][\p{L}'’.]*(?:-[\p{L}]+)*/uy,
  punct: /[:;,\-–—\/().!?*_~+@#|\[\]{}"“”'‘’&<>=]/y,
  other: /[\s\S]/uy,
};

// Pictographs, flag halves, and the invisible joiners/selectors/keycaps that
// travel with them (ZWJ, VS16, combining keycap).
const EMOJI_RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[‍️⃣])/gu;
const PIN_RE = /^\s*[📍📌]/u;
export const READ_MORE_RE = /^\s*(read more|…|\.\.\.)\s*$/i;

function num(s: string): number {
  return Number(s.replace(/,/g, ""));
}

function tryAt(re: RegExp, s: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(s);
}

/** Emoji replaced by same-length runs of spaces so offsets stay valid. */
function stripEmoji(line: string): { clean: string; count: number } {
  let count = 0;
  const clean = line.replace(EMOJI_RE, (m) => {
    count++;
    return " ".repeat(m.length);
  });
  return { clean, count };
}

function wordToken(raw: string, start: number, end: number): Token {
  const norm = raw.toLowerCase().replace(/[.:]+$/, "");
  return {
    cls: "WORD",
    raw,
    norm,
    start,
    end,
    isUpper: /\p{L}/u.test(raw) && !/\p{Ll}/u.test(raw),
  };
}

function scan(clean: string, phone7: boolean): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = clean.length;
  const push = (t: Token) => out.push(t);
  const prev = () => out[out.length - 1];

  while (i < n) {
    let m: RegExpExecArray | null;

    if ((m = tryAt(RE.ws, clean, i))) { i += m[0].length; continue; }

    if ((m = tryAt(RE.arrow, clean, i))) {
      push({ cls: "ARROW", raw: m[0], norm: "->", start: i, end: i + m[0].length, isUpper: false });
      i += m[0].length; continue;
    }
    if ((m = tryAt(RE.phone, clean, i))) {
      push({ cls: "PHONE", raw: m[0], norm: m[0].replace(/\D/g, ""), value: m[0], start: i, end: i + m[0].length, isUpper: false });
      i += m[0].length; continue;
    }
    if (phone7 && (m = tryAt(RE.phone7, clean, i))) {
      push({ cls: "PHONE7", raw: m[0], norm: m[0].replace(/\D/g, ""), value: m[0], start: i, end: i + m[0].length, isUpper: false });
      i += m[0].length; continue;
    }
    if ((m = tryAt(RE.price, clean, i))) {
      let value: number;
      if (m[1] != null) value = Number(`${m[1]}.${m[2]}`);
      else if (m[3] != null) value = Number(`${m[3].replace(/,/g, "")}${m[4] ? "." + m[4] : ""}`);
      else value = Number(m[5]);
      push({ cls: "PRICE", raw: m[0], norm: String(value), value, start: i, end: i + m[0].length, isUpper: false });
      i += m[0].length; continue;
    }
    if ((m = tryAt(RE.dateMon, clean, i))) {
      push({ cls: "DATE", raw: m[0], norm: m[0].toLowerCase(), value: m[0], start: i, end: i + m[0].length, isUpper: false, dateForm: "mon" });
      i += m[0].length; continue;
    }
    if ((m = tryAt(RE.dateDmon, clean, i))) {
      push({ cls: "DATE", raw: m[0], norm: m[0].toLowerCase(), value: m[0], start: i, end: i + m[0].length, isUpper: false, dateForm: "dmon" });
      i += m[0].length; continue;
    }
    if ((m = tryAt(RE.dateNum, clean, i))) {
      const mo = Number(m[1]);
      const dy = Number(m[3]);
      const p = prev();
      const afterCfUnit = m[2] === "-" && p && (p.cls === "CF_UNIT" || p.cls === "CF_PREFIX");
      if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31 && !afterCfUnit) {
        push({ cls: "DATE", raw: m[0], norm: m[0], value: m[0], start: i, end: i + m[0].length, isUpper: false, dateForm: "num", dateSep: m[2] });
        i += m[0].length; continue;
      }
    }
    if ((m = tryAt(RE.cfPrefix, clean, i))) {
      push({ cls: "CF_PREFIX", raw: m[0], norm: m[0].toLowerCase(), value: num(m[1]), start: i, end: i + m[0].length, isUpper: false });
      i += m[0].length; continue;
    }
    if ((m = tryAt(RE.cfUnit, clean, i))) {
      push({ cls: "CF_UNIT", raw: m[0], norm: m[0].toLowerCase(), value: num(m[1]), start: i, end: i + m[0].length, isUpper: false });
      i += m[0].length; continue;
    }
    if ((m = tryAt(RE.cfFt, clean, i))) {
      push({ cls: "CF_FT", raw: m[0], norm: m[0].toLowerCase(), value: num(m[1]), start: i, end: i + m[0].length, isUpper: false });
      i += m[0].length; continue;
    }
    if ((m = tryAt(RE.weight, clean, i))) {
      push({ cls: "WEIGHT", raw: m[0], norm: m[0].toLowerCase(), value: num(m[1]), start: i, end: i + m[0].length, isUpper: false });
      i += m[0].length; continue;
    }
    if ((m = tryAt(RE.length, clean, i))) {
      push({ cls: "LENGTH", raw: m[0], norm: m[0].toLowerCase(), value: num(m[1]), start: i, end: i + m[0].length, isUpper: false });
      i += m[0].length; continue;
    }
    if ((m = tryAt(RE.time, clean, i))) {
      push({ cls: "TIME", raw: m[0], norm: m[0].toLowerCase(), value: m[0], start: i, end: i + m[0].length, isUpper: false });
      i += m[0].length; continue;
    }
    if ((m = tryAt(RE.ordword, clean, i))) {
      push({ cls: "ORDWORD", raw: m[0], norm: m[0].toLowerCase(), value: num(m[1]), start: i, end: i + m[0].length, isUpper: false });
      i += m[0].length; continue;
    }
    if ((m = tryAt(RE.mult, clean, i))) {
      push({ cls: "MULT", raw: m[0], norm: m[0].toLowerCase(), value: Number(m[1] ?? m[2]), start: i, end: i + m[0].length, isUpper: false });
      i += m[0].length; continue;
    }
    if ((m = tryAt(RE.stZip, clean, i))) {
      push(wordToken(m[1], i, i + 2));
      push({ cls: "ZIP", raw: m[2], norm: m[2], value: m[2], start: i + 2, end: i + m[0].length, isUpper: false });
      i += m[0].length; continue;
    }
    if ((m = tryAt(RE.bignum, clean, i))) {
      push({ cls: "BIGNUM", raw: m[0], norm: m[0], value: Number(m[0]), start: i, end: i + m[0].length, isUpper: false });
      i += m[0].length; continue;
    }
    if ((m = tryAt(RE.zip, clean, i))) {
      push({ cls: "ZIP", raw: m[0], norm: m[0], value: m[1], start: i, end: i + m[0].length, isUpper: false });
      i += m[0].length; continue;
    }
    if ((m = tryAt(RE.decimal, clean, i))) {
      push({ cls: "DECIMAL", raw: m[0], norm: m[0], value: Number(m[0]), start: i, end: i + m[0].length, isUpper: false });
      i += m[0].length; continue;
    }
    if ((m = tryAt(RE.num, clean, i))) {
      push({ cls: "NUM", raw: m[0], norm: m[0].replace(/,/g, ""), value: num(m[1]), start: i, end: i + m[0].length, isUpper: false });
      i += m[0].length; continue;
    }
    if ((m = tryAt(RE.word, clean, i))) {
      push(wordToken(m[0], i, i + m[0].length));
      i += m[0].length; continue;
    }
    if ((m = tryAt(RE.punct, clean, i))) {
      push({ cls: "PUNCT", raw: m[0], norm: m[0], start: i, end: i + m[0].length, isUpper: false });
      i += m[0].length; continue;
    }
    // OTHER: dropped.
    m = tryAt(RE.other, clean, i);
    i += m ? m[0].length : 1;
  }
  return out;
}

/** Tokenize one line. `blankBefore` is filled by the caller. */
export function tokenizeLine(text: string, n: number): ScannedLine {
  const pin = PIN_RE.test(text);
  const { clean, count } = stripEmoji(text);
  const readMore = READ_MORE_RE.test(text);

  let tokens = scan(clean, false);
  // The 7-digit shorthand ("555-0128") only when the line looks like a contact
  // line and cannot be a "ZIP CF" pair: "38558 1700" must never be read as 385-58-1700.
  const fiveDigits = /\d{5}/.test(clean);
  if (!fiveDigits && (tokens.length <= 3 || hasContactWord(clean))) {
    const again = scan(clean, true);
    if (again.some((t) => t.cls === "PHONE7")) tokens = again;
  }

  const emojiOnly = count > 0 && clean.trim().length === 0;
  return { n, text, tokens, pin, emojiCount: count, emojiOnly, readMore, blankBefore: false };
}

/** P0 + P1: normalize, detect a trailing "Read more", split into scanned lines. */
export function tokenizeBody(body: string): { lines: ScannedLine[]; truncated: boolean } {
  let text = body.normalize("NFKC").replace(/\r\n?/g, "\n").replace(/[ \t]/g, " ");
  let truncated = false;

  // "Read more" on its own last line, or glued to the last line.
  const lastLine = text.slice(text.lastIndexOf("\n") + 1);
  if (READ_MORE_RE.test(lastLine)) {
    text = text.slice(0, Math.max(0, text.lastIndexOf("\n")));
    truncated = true;
  } else {
    const glued = text.match(/\s*(read more|…|\.\.\.)\s*$/i);
    if (glued && /\S/.test(text.slice(0, glued.index))) {
      text = text.slice(0, glued.index);
      truncated = true;
    }
  }

  const raw = text.split("\n");
  const lines: ScannedLine[] = [];
  let prevBlankish = true;
  for (let i = 0; i < raw.length; i++) {
    const L = tokenizeLine(raw[i], i + 1);
    L.blankBefore = prevBlankish;
    lines.push(L);
    const blankish = L.tokens.length === 0 || !L.tokens.some((t) => t.cls !== "PUNCT");
    prevBlankish = blankish;
  }
  return { lines, truncated };
}

export function isBlank(L: ScannedLine): boolean {
  return L.text.trim().length === 0;
}

/** No WORD/NUM/ZIP/CF/PHONE tokens: an emoji row, "-----", "***". */
export function isDecoration(L: ScannedLine): boolean {
  if (isBlank(L)) return false;
  return !L.tokens.some((t) => t.cls !== "PUNCT" && t.cls !== "ARROW");
}
