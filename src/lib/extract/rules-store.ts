/**
 * Learned extraction rules: the value shapes, and the pure helpers that read
 * them. Solve an unknown format once in the admin queue, keep it forever.
 *
 * This half is deliberately database-free so the extractor, the eval harness
 * and (in principle) a browser preview can all import it. The loader that
 * reads `extraction_rules` lives in src/lib/pipeline/rules.ts and re-exports
 * these types.
 */
import type { OriginRef } from "./schema";

export interface LearnedPlace {
  city: string | null;
  state: string | null;
  zip: string | null;
  lat: number;
  lng: number;
  precision: "zip" | "city" | "state";
  label: string;
}

export type KeywordAs =
  | "CF_UNIT"
  | "RFD"
  | "TO"
  | "FROM"
  | "PERCF"
  | "NOTE"
  | `TAG:${string}`
  | `CITY:${string}`;

/** scope: 'global' | 'sender:<sender_key>' */
export interface KeywordRule {
  word: string;
  as: KeywordAs;
  scope: string;
}

/**
 * A line the classifier misread. "contact" means a line that is only a contact
 * (name or handle); an origin line is a `place` rule, not an ignore.
 * C's "Ignore line as ..." menu offers exactly this union.
 */
export interface IgnoreLineRule {
  text: string;
  as: "chatter" | "requirement" | "title" | "decoration" | "contact";
  scope: string;
}

/**
 * Placeholders {CF} {ST} {ZIP} {CITY} {PRICE} {DATE} {RFD} {NOTES} {WORD};
 * literals; `?` marks an optional group; whitespace means \s*.
 */
export interface LineTemplate {
  id: string;
  template: string;
  kind: "destination" | "header" | "lane";
  scope: string;
}

export interface SenderFormat {
  default_origin?: OriginRef | null;
  price_mode?: "per_cf" | "flat" | null;                 // forces PRICE interpretation for this sender
  bare_number_is?: "cf" | "note" | null;                 // a bare NUM on a destination line
  state_from_zip_only?: boolean;                         // ignore written 2-letter states when a ZIP is present
}

export interface RuleSet {
  /**
   * key = normalizeRuleKey(header text). A sender-scoped place is stored under
   * "sender:<key>|<normalized>" and folded onto the plain key by scopedRules.
   */
  places: Record<string, LearnedPlace>;
  ignoreLines: IgnoreLineRule[];
  keywords: KeywordRule[];
  lineTemplates: LineTemplate[];
  senderFormats: Record<string, SenderFormat>;           // key = sender_key
}

export const EMPTY_RULES: RuleSet = {
  places: {},
  ignoreLines: [],
  keywords: [],
  lineTemplates: [],
  senderFormats: {},
};

const SENDER_PLACE_SEP = "|";

/** The `places` key under which a sender-scoped place rule is stored. */
export function senderPlaceKey(scope: string, normalizedKey: string): string {
  return scope === "global" ? normalizedKey : `${scope}${SENDER_PLACE_SEP}${normalizedKey}`;
}

/**
 * Narrow a rule set to one sender: sender-scoped rules first, then global
 * (precedence sender > global > code). Rules scoped to other senders are
 * dropped. The result is a new value; the input is never mutated.
 */
export function scopedRules(rules: RuleSet, senderKey: string | null): RuleSet {
  const scope = senderKey ? `sender:${senderKey}` : null;
  const inScope = (s: string) => s === "global" || (scope !== null && s === scope);
  const rank = (s: string) => (s === "global" ? 1 : 0);

  const places: Record<string, LearnedPlace> = {};
  // Global first, then sender entries override.
  for (const [k, v] of Object.entries(rules.places)) {
    if (!k.startsWith("sender:")) places[k] = v;
  }
  if (scope) {
    const prefix = `${scope}${SENDER_PLACE_SEP}`;
    for (const [k, v] of Object.entries(rules.places)) {
      if (k.startsWith(prefix)) places[k.slice(prefix.length)] = v;
    }
  }

  return {
    places,
    ignoreLines: rules.ignoreLines.filter((r) => inScope(r.scope)).sort((a, b) => rank(a.scope) - rank(b.scope)),
    keywords: rules.keywords.filter((r) => inScope(r.scope)).sort((a, b) => rank(a.scope) - rank(b.scope)),
    lineTemplates: rules.lineTemplates.filter((r) => inScope(r.scope)).sort((a, b) => rank(a.scope) - rank(b.scope)),
    senderFormats: rules.senderFormats,
  };
}

/** Sub-patterns the template placeholders compile to (from the tokenizer's rules, A §3.1). */
const PLACEHOLDERS: Record<string, string> = {
  CF: String.raw`(?<CF>(?:\d{1,3}(?:,\d{3})+|\d{1,5})\s*(?:c\s*\/\s*f|c\.f\.?|cf|cu\.?\s*ft\.?|cuft|cubic(?:\s*(?:feet|ft|foot))?|cubes?|cubos?)?)`,
  ST: String.raw`(?<ST>[A-Za-z]{2})`,
  ZIP: String.raw`(?<ZIP>\d{5})`,
  CITY: String.raw`(?<CITY>[\p{L}][\p{L}.'’-]*(?:\s+[\p{L}][\p{L}.'’-]*){0,4})`,
  PRICE: String.raw`(?<PRICE>\$\s?\d{1,3}(?:[,.]\d{1,3})*|\d+(?:\.\d{1,2})?\$)`,
  DATE: String.raw`(?<DATE>\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s*\d{1,2})`,
  RFD: String.raw`(?<RFD>rfd|r\.f\.d|ready(?:\s+for\s+del(?:ivery)?)?(?:\s+now)?|listos?|lista|disponibles?)`,
  NOTES: String.raw`(?<NOTES>.*?)`,
  WORD: String.raw`(?<WORD>[\p{L}][\p{L}.'’-]*)`,
};

/**
 * Compile a taught line template into a regex, built from the tokenizer's own
 * sub-patterns. Raw regex is never accepted from an admin: a rule saved in the
 * console must not be able to hang the pipeline on a catastrophic backtrack.
 *
 *   "{CF} - {ST} {ZIP} {PRICE}?"  ->  ^\s*(?<CF>...)\s*-\s*(?<ST>..)\s*(?<ZIP>...)\s*(?:(?<PRICE>...))?\s*$
 */
export function compileTemplate(t: LineTemplate): RegExp {
  const src = t.template.normalize("NFKC").trim();
  if (!src) throw new Error("compileTemplate: empty template");
  let out = "";
  let i = 0;
  const seen = new Map<string, number>();
  while (i < src.length) {
    const ch = src[i];
    if (ch === "{") {
      const close = src.indexOf("}", i);
      if (close < 0) throw new Error("compileTemplate: unclosed placeholder");
      const name = src.slice(i + 1, close).trim().toUpperCase();
      let pat = PLACEHOLDERS[name];
      if (!pat) throw new Error(`compileTemplate: unknown placeholder {${name}}`);
      // A placeholder used twice ("{ZIP}/{CF}, {ZIP}/{CF}") gets numbered groups.
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      if (n > 1) pat = pat.replace(`(?<${name}>`, `(?<${name}_${n}>`);
      i = close + 1;
      if (src[i] === "?") {
        out += `(?:${pat})?`;
        i++;
      } else out += pat;
      continue;
    }
    if (/\s/.test(ch)) {
      out += String.raw`\s*`;
      while (i < src.length && /\s/.test(src[i])) i++;
      continue;
    }
    if (ch === "?") throw new Error("compileTemplate: '?' may only follow a placeholder");
    out += ch.replace(/[.*+^${}()|[\]\\\/]/g, "\\$&");
    i++;
  }
  return new RegExp(`^\\s*${out}\\s*$`, "iu");
}

/**
 * The ONE normalization for `places`, `ignoreLines` and `keywords` keys.
 *
 * NFKC, lowercased, emoji and punctuation stripped, whitespace collapsed. The
 * admin rules endpoint applies it server-side (the console sends raw line text)
 * and geocodeOrigin looks up with it, so "📍 KEARNY, NJ:" and "kearny nj" are
 * the same key.
 */
export function normalizeRuleKey(text: string): string {
  return (text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    // Keep letters, digits and whitespace; everything else (emoji, punctuation,
    // pictographs, variation selectors) is decoration around the same key.
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
