/**
 * The learned-rule loader (A §8.2): `extraction_rules` -> RuleSet, cached for
 * 60 seconds and invalidated by the admin rules endpoint on every save.
 *
 * The pure half (types, EMPTY_RULES, scopedRules, compileTemplate,
 * normalizeRuleKey) lives in src/lib/extract/rules-store.ts so the extractor
 * and the eval never import the database.
 */
import { query } from "@/lib/db";
import {
  EMPTY_RULES,
  senderPlaceKey,
  type IgnoreLineRule,
  type KeywordRule,
  type LearnedPlace,
  type LineTemplate,
  type RuleSet,
  type SenderFormat,
} from "@/lib/extract/rules-store";

export type { IgnoreLineRule, KeywordRule, LearnedPlace, LineTemplate, RuleSet, SenderFormat } from "@/lib/extract/rules-store";
export { EMPTY_RULES, scopedRules, compileTemplate, normalizeRuleKey } from "@/lib/extract/rules-store";

const TTL_MS = 60_000;

let cached: { at: number; rules: RuleSet } | null = null;
let inflight: Promise<RuleSet> | null = null;

export interface RuleRow {
  id: number;
  kind: "place" | "ignore_line" | "keyword" | "line_template" | "sender_format" | "note_word";
  scope: string;
  key: string;
  value: unknown;
  source_message_id: number | null;
  created_by: number | null;
  note: string | null;
  active: boolean;
  created_at: string;
}

/** Fold active rule rows into the plain RuleSet value. */
export function rulesFromRows(rows: RuleRow[]): RuleSet {
  const out: RuleSet = { places: {}, ignoreLines: [], keywords: [], lineTemplates: [], senderFormats: {} };
  for (const r of rows) {
    if (!r.active) continue;
    const v = (r.value ?? {}) as Record<string, unknown>;
    switch (r.kind) {
      case "place": {
        if (typeof v.lat !== "number" || typeof v.lng !== "number") continue;
        const place: LearnedPlace = {
          city: (v.city as string | null) ?? null,
          state: (v.state as string | null) ?? null,
          zip: (v.zip as string | null) ?? null,
          lat: v.lat,
          lng: v.lng,
          precision: (v.precision as LearnedPlace["precision"]) ?? (v.zip ? "zip" : v.city ? "city" : "state"),
          label: (v.label as string) ?? [v.city, v.state].filter(Boolean).join(", "),
        };
        out.places[senderPlaceKey(r.scope, r.key)] = place;
        break;
      }
      case "ignore_line": {
        const as = v.as as IgnoreLineRule["as"] | undefined;
        if (!as) continue;
        out.ignoreLines.push({ text: r.key, as, scope: r.scope });
        break;
      }
      case "keyword":
      case "note_word": {
        const as = (r.kind === "note_word" ? "NOTE" : (v.as as KeywordRule["as"] | undefined)) ?? undefined;
        if (!as) continue;
        out.keywords.push({ word: r.key, as, scope: r.scope });
        break;
      }
      case "line_template": {
        const template = v.template as string | undefined;
        const kind = (v.kind as LineTemplate["kind"] | undefined) ?? "destination";
        if (!template) continue;
        out.lineTemplates.push({ id: r.key, template, kind, scope: r.scope });
        break;
      }
      case "sender_format": {
        out.senderFormats[r.key] = v as SenderFormat;
        break;
      }
    }
  }
  return out;
}

export async function loadRuleSet(): Promise<RuleSet> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.rules;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const rows = await query<RuleRow>(
        `SELECT id, kind, scope, key, value, source_message_id, created_by, note, active, created_at::text AS created_at
           FROM extraction_rules WHERE active ORDER BY id`,
      );
      const rules = rows.length ? rulesFromRows(rows) : EMPTY_RULES;
      cached = { at: Date.now(), rules };
      return rules;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function invalidateRuleSet(): void {
  cached = null;
}
