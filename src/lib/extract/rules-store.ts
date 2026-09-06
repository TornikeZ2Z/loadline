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
  places: Record<string, LearnedPlace>;                  // key = normalizeRuleKey(header text)
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

/**
 * Narrow a rule set to one sender: sender-scoped rules first, then global
 * (precedence sender > global > code).
 *
 * Phase 0a: identity. The extractor that consumes the precedence order does not
 * exist yet, and a half-applied ordering would be worse than none -- callers
 * already pass EMPTY_RULES.
 */
export function scopedRules(rules: RuleSet, _senderKey: string | null): RuleSet {
  return rules;
}

/**
 * Compile a taught line template into a regex, built from the tokenizer's own
 * sub-patterns. Raw regex is never accepted from an admin: a rule saved in the
 * console must not be able to hang the pipeline on a catastrophic backtrack.
 */
export function compileTemplate(_t: LineTemplate): RegExp {
  throw new Error("compileTemplate: not implemented until the inventory-v1 tokenizer lands");
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
