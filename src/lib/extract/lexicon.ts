/**
 * The vocabulary of a moving-industry batch post (inventory-v1, A §3.2.3).
 *
 * Every phrase is lowercase; the longest phrase wins where several start on
 * the same word ("ready for delivery from" is a FROM marker, "ready for
 * delivery" is a ready flag, "ready" alone is a ready flag). One phrase may
 * carry several kinds: "ready for delivery" is both an RFD flag and a title
 * word, and which one matters is the line classifier's call.
 *
 * Learned `keyword` rules (A §8.2) are merged in by `buildLexicon`, so an
 * admin's "Add word" is indistinguishable from a word shipped here.
 */
import type { KeywordRule, RuleSet } from "./rules-store";

export type KeywordKind =
  | "FROM"        // origin marker at line start
  | "FROM_ANY"    // origin marker accepted anywhere on the line
  | "TO"
  | "RFD"
  | "TITLE"
  | "REQ"
  | "REQ_OBJ"
  | "REQ_PHRASE"
  | "CONTACT"
  | "TAG"
  | "PERCF"
  | "DEADLINE"
  | "CAPACITY"
  | "CHATTER"
  | "PAYMENT"
  | "NOTE_NOUN"
  | "PARTIAL"
  | "CF_UNIT"     // learned: a word that means cubic feet
  | "NOTE"        // learned: a word that is never a place
  | "CITY";       // learned: a word/phrase that is a city ("City, ST")

export interface LexEntry {
  kinds: Set<KeywordKind>;
  /** For TAG entries: the canonical tag. */
  tag?: string;
  /** For CITY entries: "City, ST". */
  city?: string;
  /**
   * Markers that only count with the right neighbour: "pu"/"pickup" need a
   * ":" or a place after them (so "Puyallup" and "pickup truck" survive),
   * "del" needs ":", a state or a ZIP (so "Del Mar" survives).
   */
  cond?: "pu" | "del";
}

export interface Lexicon {
  phrases: Map<string, LexEntry>;
  /** Longest phrase, in words. */
  maxWords: number;
}

/** Words that cannot be a contact's name even when they sit next to a phone. */
export const NAME_STOP = new Set(
  "me us only please private in for direct now anytime back the or and at to text call office dispatch dispatcher driver owner".split(
    " ",
  ),
);

/** Single-word tag keys eligible for fuzzy matching (Damerau-Levenshtein <= 1). */
const TAGS: Array<[string, string]> = [
  ["bulky", "bulky"],
  ["urgent", "urgent"], ["urgente", "urgent"], ["asap", "urgent"], ["rush", "urgent"],
  ["hot job", "urgent"], ["hot load", "urgent"],
  ["hot tub", "hot_tub"], ["hot tube", "hot_tub"], ["jacuzzi", "hot_tub"], ["spa", "hot_tub"],
  ["piano", "piano"],
  ["safe", "safe"], ["gun safe", "safe"],
  ["stairs", "stairs"], ["stair", "stairs"], ["flights", "stairs"],
  ["elevator", "elevator"],
  ["no elevator", "no_elevator"],
  ["shuttle", "shuttle"],
  ["long carry", "long_carry"],
  ["pack", "packing"], ["packing", "packing"], ["packed", "packing"],
  ["partial", "partial"],
  ["full", "full"], ["full truck", "full"],
  ["fragile", "fragile"],
  ["motorcycle", "motorcycle"], ["moto", "motorcycle"],
  ["pool table", "pool_table"],
  ["treadmill", "treadmill"],
  ["storage", "storage"], ["sit", "storage"],
  ["cod", "cod"],
  ["ground floor", "ground_floor"], ["1st floor", "ground_floor"],
];

/** The closed tag vocabulary (also what web posts and keyword rules are filtered to). */
export const TAG_VOCABULARY: ReadonlySet<string> = new Set(TAGS.map(([, t]) => t));

const LISTS: Array<[KeywordKind, string[]]> = [
  [
    "FROM",
    [
      "from", "frm", "desde", "origin", "origen", "pickup", "pick up", "pu",
      "loading", "loading in", "loading from", "out of", "leaving",
      "ready for delivery from", "rfd from", "loads from", "jobs from", "available from",
      "inventory from", "delivering from", "deliver from", "coming from", "located in",
      "warehouse in", "warehouse",
    ],
  ],
  ["FROM_ANY", ["ready for delivery from", "rfd from", "loads from", "jobs from", "available from"]],
  [
    "TO",
    [
      "to", "para", "hacia", "dest", "destination", "delivery to", "deliver to", "delivering to",
      "going to", "going", "drop", "dropoff", "drop off", "to go to", "del",
    ],
  ],
  [
    "RFD",
    [
      "rfd", "r.f.d", "ready for delivery", "ready for del", "ready now", "ready", "available now",
      "listo", "listos", "lista", "disponible", "disponibles", "in warehouse", "in storage",
      "at warehouse",
    ],
  ],
  [
    "TITLE",
    [
      "load post", "loads post", "post", "posting", "inventory", "list", "new list", "update",
      "updated", "available loads", "available jobs", "jobs available", "loads available",
      "new loads", "new jobs", "more loads", "more jobs", "backhaul", "backhauls", "hhg loads",
      "ready for delivery",
    ],
  ],
  ["REQ", ["must", "required", "require", "requirement", "active", "valid"]],
  [
    "REQ_OBJ",
    [
      "dot", "mc", "hhg", "insurance", "insured", "authority", "coi", "w9", "w-9", "license",
      "permit", "cargo", "liability", "bond", "bonded", "carriers", "brokers", "brokering",
    ],
  ],
  [
    "REQ_PHRASE",
    [
      "no brokers", "no double brokering", "double brokering", "carriers only", "serious carriers",
      "serious inquiries", "good business", "direct carriers", "must have", "dot & mc", "dot mc",
      "dot and mc", "active dot", "hhg authority",
    ],
  ],
  [
    "CONTACT",
    [
      "call", "text", "contact", "whatsapp", "wa", "msg", "message", "dm", "pm", "inbox",
      "private", "privately", "ask for", "reach", "llamar", "mensaje", "privado", "hmu",
      "hit me up", "ping",
    ],
  ],
  [
    "PERCF",
    [
      "por cube", "por cubo", "per cube", "per cubo", "per cf", "per c/f", "/cf", "a cube",
      "x cube", "each cube", "per cubic", "per cubic foot", "per cubic feet", "per cubic ft",
      "cube", "cubo", "pc", "cf",
    ],
  ],
  [
    "DEADLINE",
    ["by", "before", "until", "deadline", "due", "no later", "no later than", "deliver by", "delivery by", "must deliver"],
  ],
  [
    "CAPACITY",
    [
      "need", "needs", "needed", "looking for", "want", "wanted", "min", "minimum", "max", "maximum",
      "book", "to book", "have room", "room for", "space for", "free space", "space available",
      "truck available", "available truck", "can take", "can fit", "empty", "going empty",
      "heading", "driving",
    ],
  ],
  [
    "CHATTER",
    [
      "hi", "hello", "hey", "guys", "all", "everyone", "thanks", "thank", "please", "pls", "ok",
      "okay", "good morning", "good evening", "good afternoon", "up", "me", "us", "you",
    ],
  ],
  ["PAYMENT", ["cash", "zelle", "venmo", "paypal", "cashapp", "payment", "deposit", "cod", "wire", "check"]],
  [
    "NOTE_NOUN",
    [
      "bdrm", "bd", "br", "bed", "beds", "bedroom", "bedrooms", "bath", "baths", "ba", "room",
      "rooms", "floor", "floors", "stop", "stops", "pcs", "pieces", "items", "boxes", "box",
      "truck", "trucks", "job", "jobs", "load", "loads", "men", "guys", "hrs", "hours", "days",
      "weeks", "miles", "mi", "flights",
    ],
  ],
  [
    "PARTIAL",
    [
      "still available", "still have", "also have", "added", "new job", "new jobs", "new load",
      "new loads", "just got", "just added", "one more", "1 more",
    ],
  ],
];

function add(map: Map<string, LexEntry>, phrase: string, kind: KeywordKind, extra?: Partial<LexEntry>) {
  const key = phrase.toLowerCase().trim();
  let e = map.get(key);
  if (!e) {
    e = { kinds: new Set() };
    map.set(key, e);
  }
  e.kinds.add(kind);
  if (extra?.tag) e.tag = extra.tag;
  if (extra?.city) e.city = extra.city;
  if (extra?.cond) e.cond = extra.cond;
}

function build(): Lexicon {
  const phrases = new Map<string, LexEntry>();
  for (const [kind, words] of LISTS) for (const w of words) add(phrases, w, kind);
  for (const [phrase, tag] of TAGS) add(phrases, phrase, "TAG", { tag });
  phrases.get("pu")!.cond = "pu";
  phrases.get("pickup")!.cond = "pu";
  phrases.get("pick up")!.cond = "pu";
  phrases.get("del")!.cond = "del";
  let maxWords = 1;
  for (const k of phrases.keys()) maxWords = Math.max(maxWords, k.split(" ").length);
  return { phrases, maxWords };
}

export const BASE_LEXICON: Lexicon = build();

/** Which lexicon kind a learned keyword rule maps to. */
function kindOfRule(as: KeywordRule["as"]): { kind: KeywordKind; extra?: Partial<LexEntry> } | null {
  if (as.startsWith("TAG:")) {
    const tag = as.slice(4).trim().toLowerCase().replace(/[\s-]+/g, "_");
    return tag ? { kind: "TAG", extra: { tag } } : null;
  }
  if (as.startsWith("CITY:")) {
    const city = as.slice(5).trim();
    return city ? { kind: "CITY", extra: { city } } : null;
  }
  switch (as) {
    case "CF_UNIT": return { kind: "CF_UNIT" };
    case "RFD": return { kind: "RFD" };
    case "TO": return { kind: "TO" };
    case "FROM": return { kind: "FROM" };
    case "PERCF": return { kind: "PERCF" };
    case "NOTE": return { kind: "NOTE" };
    default: return null;
  }
}

const built = new WeakMap<RuleSet, Lexicon>();

/** The base vocabulary plus a rule set's learned keywords (memoized per rule set). */
export function buildLexicon(rules: RuleSet | null | undefined): Lexicon {
  if (!rules || !rules.keywords.length) return BASE_LEXICON;
  const cached = built.get(rules);
  if (cached) return cached;
  const phrases = new Map<string, LexEntry>();
  for (const [k, e] of BASE_LEXICON.phrases) phrases.set(k, { ...e, kinds: new Set(e.kinds) });
  let maxWords = BASE_LEXICON.maxWords;
  for (const r of rules.keywords) {
    const m = kindOfRule(r.as);
    const word = r.word.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
    if (!m || !word) continue;
    add(phrases, word, m.kind, m.extra);
    maxWords = Math.max(maxWords, word.split(" ").length);
  }
  const lex = { phrases, maxWords };
  built.set(rules, lex);
  return lex;
}

/** Damerau-Levenshtein (optimal string alignment) distance, capped at 2. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d: number[][] = [];
  for (let i = 0; i <= a.length; i++) d[i] = [i];
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** Single-word tag keys, for fuzzy matching ("URGET" -> urgent). */
export const FUZZY_TAG_KEYS: Array<[string, string]> = TAGS.filter(([k]) => !k.includes(" ") && k.length >= 4);

/**
 * A misspelt tag word: >= 5 letters, distance <= 1 from a single-word tag key,
 * and not itself a known word of any kind.
 */
export function fuzzyTag(word: string, lex: Lexicon): string | null {
  if (word.length < 5 || lex.phrases.has(word)) return null;
  for (const [key, tag] of FUZZY_TAG_KEYS) {
    if (editDistance(word, key) <= 1) return tag;
  }
  return null;
}

/** Does the raw line carry a contact trigger word? (Decides whether PHONE7 may match.) */
const CONTACT_WORD_RE = new RegExp(
  "\\b(?:" +
    LISTS.find(([k]) => k === "CONTACT")![1]
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|") +
    ")\\b",
  "i",
);
export function hasContactWord(line: string): boolean {
  return CONTACT_WORD_RE.test(line);
}
