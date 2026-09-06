/**
 * Learned extraction rules -- the value side of the admin "solve once, keep
 * forever" workflow (A §8.2).
 *
 * This module is PURE (no db import) so the extractor, the eval and client
 * code can all use it. `loadRuleSet()` / `invalidateRuleSet()` (the cached
 * database read) live in `src/lib/pipeline/rules.ts`.
 *
 * Phase 0a: types, `EMPTY_RULES` and `normalizeRuleKey` are final;
 * `scopedRules` returns its input and `compileTemplate` throws until the
 * extractor lands in Phase 0b.
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

export type KeywordAs = "CF_UNIT" | "RFD" | "TO" | "FROM" | "PERCF" | "NOTE" | `TAG:${string}` | `CITY:${string}`;

/** scope 'global' | 'sender:<key>' */
export interface KeywordRule { word: string; as: KeywordAs; scope: string }

/**
 * "contact" = a line that is only a contact (name/handle) the classifier
 * misread; C's "Ignore line as …" menu offers exactly this union (an origin
 * line is a `place` rule, not an ignore).
 */
export interface IgnoreLineRule {
  text: string;
  as: "chatter" | "requirement" | "title" | "decoration" | "contact";
  scope: string;
}

/**
 * placeholders {CF} {ST} {ZIP} {CITY} {PRICE} {DATE} {RFD} {NOTES} {WORD};
 * literals; `?` = optional group; whitespace = \s*
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
 * The ONE normalization for `places` / `ignoreLines` / `keywords` keys: NFKC,
 * lowercase, emoji and punctuation stripped, whitespace collapsed. The rules
 * endpoint applies it server-side (C sends raw line text) and geocodeOrigin
 * looks up with it.
 */
export function normalizeRuleKey(text: string): string {
  return (text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{Extended_Pictographic}\p{P}\p{S}\p{Cf}\u{FE0F}\u{20E3}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Sender rules first, then global (precedence: sender > global > code).
 * Phase 0a stub: returns the input unchanged; the extractor (0b) wires the
 * sender-scoped view.
 */
export function scopedRules(rules: RuleSet, senderKey: string | null): RuleSet {
  void senderKey;
  return rules;
}

/** From the tokenizer's sub-regexes; no raw regex accepted. Lands with the extractor (Phase 0b). */
export function compileTemplate(t: LineTemplate): RegExp {
  throw new Error(`compileTemplate: not implemented (Phase 0b) — template ${t.id}`);
}
