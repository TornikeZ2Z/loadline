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
  normalizeRuleKey,
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

// ---------------------------------------------------------------------------
// Rule rows and the messages a rule change touches (the admin routes' helpers).
// ---------------------------------------------------------------------------

export const RULE_KINDS = ["place", "ignore_line", "keyword", "line_template", "sender_format", "note_word"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

/** Kinds whose key is free text the console sends raw; the route normalizes it. */
export const NORMALIZED_KEY_KINDS: ReadonlySet<string> = new Set(["place", "ignore_line", "keyword", "note_word"]);

const RULE_COLUMNS = `id, kind, scope, key, value, source_message_id, created_by, note, active, created_at::text AS created_at`;

export async function listRules(): Promise<RuleRow[]> {
  return query<RuleRow>(`SELECT ${RULE_COLUMNS} FROM extraction_rules ORDER BY active DESC, id DESC`);
}

export async function getRule(id: number): Promise<RuleRow | null> {
  const rows = await query<RuleRow>(`SELECT ${RULE_COLUMNS} FROM extraction_rules WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function saveRule(input: {
  kind: RuleKind;
  scope: string;
  /** Raw text for place/ignore_line/keyword/note_word (normalized here); an id / sender key otherwise. */
  key: string;
  value: unknown;
  note?: string | null;
  source_message_id?: number | null;
  created_by?: number | null;
}): Promise<RuleRow> {
  const key = NORMALIZED_KEY_KINDS.has(input.kind) ? normalizeRuleKey(input.key) : input.key.trim();
  if (!key) throw new Error("saveRule: key is empty after normalization");
  const rows = await query<RuleRow>(
    `INSERT INTO extraction_rules (kind, scope, key, value, source_message_id, created_by, note, active)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, true)
     ON CONFLICT (kind, scope, key) DO UPDATE SET
       value = EXCLUDED.value, source_message_id = COALESCE(EXCLUDED.source_message_id, extraction_rules.source_message_id),
       created_by = COALESCE(EXCLUDED.created_by, extraction_rules.created_by), note = COALESCE(EXCLUDED.note, extraction_rules.note),
       active = true
     RETURNING ${RULE_COLUMNS}`,
    [input.kind, input.scope, key, JSON.stringify(input.value ?? {}), input.source_message_id ?? null, input.created_by ?? null, input.note ?? null],
  );
  invalidateRuleSet();
  return rows[0];
}

export async function updateRule(id: number, patch: { active?: boolean; value?: unknown; note?: string | null }): Promise<RuleRow | null> {
  const rows = await query<RuleRow>(
    `UPDATE extraction_rules SET
       active = COALESCE($2, active),
       value = COALESCE($3::jsonb, value),
       note = COALESCE($4, note)
     WHERE id = $1
     RETURNING ${RULE_COLUMNS}`,
    [id, patch.active ?? null, patch.value === undefined ? null : JSON.stringify(patch.value), patch.note ?? null],
  );
  invalidateRuleSet();
  return rows[0] ?? null;
}

export async function deleteRule(id: number): Promise<RuleRow | null> {
  const rows = await query<RuleRow>(`DELETE FROM extraction_rules WHERE id = $1 RETURNING ${RULE_COLUMNS}`, [id]);
  invalidateRuleSet();
  return rows[0] ?? null;
}

/**
 * The messages a rule change should re-run: the rule's source message and the
 * same sender's messages of the last `days` days (by send time), oldest first.
 */
export async function messagesAffectedBy(rule: { source_message_id: number | null; scope: string }, days = 30): Promise<number[]> {
  const ids = new Set<number>();
  let senderKey: string | null = rule.scope.startsWith("sender:") ? rule.scope.slice("sender:".length) : null;
  if (rule.source_message_id != null) {
    const m = await query<{ id: number; sender_key: string | null; sent_at: string }>(
      `SELECT id, sender_key, sent_at::text AS sent_at FROM raw_messages WHERE id = $1`,
      [rule.source_message_id],
    );
    if (m[0]) {
      ids.add(m[0].id);
      senderKey = senderKey ?? m[0].sender_key;
    }
  }
  if (senderKey) {
    const rows = await query<{ id: number }>(
      `SELECT id FROM raw_messages
        WHERE sender_key = $1 AND sent_at > now() - ($2 || ' days')::interval
        ORDER BY sent_at, id`,
      [senderKey, String(days)],
    );
    for (const r of rows) ids.add(r.id);
  }
  return [...ids].sort((a, b) => a - b);
}
