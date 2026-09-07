import { NextResponse } from "next/server";
import { badRequest, handler } from "@/lib/api";
import { requireRole, requireWriteRole } from "@/lib/auth";
import { normalizeRuleKey } from "@/lib/extract";
import { reprocessMessages } from "@/lib/pipeline/process";
import { listRules, messagesAffectedBy, NORMALIZED_KEY_KINDS, RULE_KINDS, saveRule, type RuleKind } from "@/lib/pipeline/rules";

export const GET = handler(async () => {
  await requireRole("admin");
  return NextResponse.json({ rules: await listRules() });
});

/**
 * Save a learned rule. The console sends the RAW line/header/word text as
 * `key`; place, ignore_line and keyword keys are stored normalized (A §8.2)
 * so "📍 KEARNY, NJ:" and "kearny nj" are the same rule. Every save
 * invalidates the rule cache and reprocesses the source message plus the same
 * sender's messages of the last 30 days; the response carries the count, so
 * the console never needs a second call to /api/admin/reprocess.
 */
export const POST = handler(async (req: Request) => {
  const user = await requireWriteRole("admin");
  const body = (await req.json()) as {
    kind?: string; scope?: string; key?: string; value?: unknown; note?: string; source_message_id?: number;
  };

  const kind = body.kind as RuleKind;
  if (!RULE_KINDS.includes(kind)) badRequest(`kind must be one of ${RULE_KINDS.join(", ")}`);
  const rawKey = (body.key ?? "").trim();
  if (!rawKey) badRequest("key is required");
  const scope = (body.scope ?? "global").trim() || "global";
  if (scope !== "global" && !scope.startsWith("sender:")) badRequest("scope must be 'global' or 'sender:<key>'");

  const key = NORMALIZED_KEY_KINDS.has(kind) ? normalizeRuleKey(rawKey) : rawKey;
  if (!key) badRequest("key is empty after normalization");

  const value = body.value ?? {};
  if (kind === "place") {
    const v = value as { lat?: unknown; lng?: unknown };
    if (typeof v.lat !== "number" || typeof v.lng !== "number") badRequest("a place rule needs numeric lat/lng");
  }
  if (kind === "ignore_line") {
    const as = (value as { as?: string }).as;
    if (!["chatter", "requirement", "title", "decoration", "contact"].includes(as ?? "")) {
      badRequest("an ignore_line rule needs as: chatter | requirement | title | decoration | contact");
    }
  }
  if (kind === "keyword" && !(value as { as?: string }).as) badRequest("a keyword rule needs as: CF_UNIT | RFD | TO | FROM | PERCF | NOTE | TAG:<tag> | CITY:<City, ST>");
  if (kind === "line_template" && !(value as { template?: string }).template) badRequest("a line_template rule needs a template");

  const rule = await saveRule({
    kind,
    scope,
    key,
    value,
    note: body.note ?? null,
    source_message_id: body.source_message_id ?? null,
    created_by: user.id,
  });

  const ids = await messagesAffectedBy(rule, 30);
  const results = await reprocessMessages(ids);
  return NextResponse.json({ rule, reprocessed: results.length });
});
