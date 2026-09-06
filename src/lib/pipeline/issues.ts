/**
 * The unknown-pattern queue's bookkeeping (A §8.1, §9.2).
 *
 *   extraction_issues   one row per (kind, normalized line), counted up each
 *                       time it recurs, closed when a reprocess comes out clean;
 *   format_signatures   one row per line-shape signature; new ones put the
 *                       message in the admin queue as `new_format` until a
 *                       human confirms the format.
 */
import crypto from "node:crypto";
import { query, queryOne } from "@/lib/db";
import { KNOWN_SIGNATURES } from "@/lib/extract/formats";
import { normalizeRuleKey } from "@/lib/extract/rules-store";
import type { ExtractionOutcome } from "@/lib/extract/schema";

function lineHash(kind: string, text: string): string {
  return crypto.createHash("sha1").update(`${kind}|${normalizeRuleKey(text)}`).digest("hex");
}

const LINE_FLAG_KINDS: Array<[string, string]> = [
  ["two_places", "two_places"],
  ["incomplete_destination", "incomplete_destination"],
  ["zip_state_mismatch", "zip_state_mismatch"],
  ["header_without_jobs", "unknown_line"],
];

/** Upsert an issue per flagged line and per message-level problem. */
export async function recordIssues(messageId: number, senderKey: string | null, outcome: ExtractionOutcome): Promise<number> {
  const items: Array<{ kind: string; sample: string }> = [];
  for (const line of outcome.lines) {
    const text = line.text.trim();
    if (!text) continue;
    if (line.class === "UNKNOWN") items.push({ kind: "unknown_line", sample: text });
    for (const [flag, kind] of LINE_FLAG_KINDS) {
      if (line.flags.includes(flag) && kind !== "unknown_line") items.push({ kind, sample: text });
    }
  }
  if (outcome.reason === "unknown_format") items.push({ kind: "unknown_format", sample: firstContentLine(outcome) });
  if (outcome.reason === "no_origin") items.push({ kind: "no_origin", sample: firstContentLine(outcome) });
  if (outcome.flags.includes("origin_unresolved")) {
    const h = outcome.lines.find((l) => l.class === "HEADER");
    items.push({ kind: "origin_unresolved", sample: h?.text.trim() ?? firstContentLine(outcome) });
  }
  if (outcome.flags.includes("state_header_ambiguous")) {
    const h = outcome.lines.find((l) => l.class === "HEADER" && l.sub === "state-only");
    items.push({ kind: "state_header_ambiguous", sample: h?.text.trim() ?? firstContentLine(outcome) });
  }

  let n = 0;
  const seen = new Set<string>();
  for (const it of items) {
    const hash = lineHash(it.kind, it.sample);
    if (seen.has(`${it.kind}|${hash}`)) continue;
    seen.add(`${it.kind}|${hash}`);
    await query(
      `INSERT INTO extraction_issues (kind, line_hash, sample_line, message_id, sender_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (kind, line_hash) DO UPDATE SET
         occurrences = extraction_issues.occurrences + 1,
         last_seen_at = now(),
         message_id = EXCLUDED.message_id,
         sender_key = EXCLUDED.sender_key,
         status = CASE WHEN extraction_issues.status = 'ignored' THEN 'ignored' ELSE 'open' END`,
      [it.kind, hash, it.sample.slice(0, 500), messageId, senderKey],
    );
    n++;
  }
  return n;
}

function firstContentLine(outcome: ExtractionOutcome): string {
  return outcome.lines.find((l) => l.text.trim() && l.class !== "BLANK" && l.class !== "DECORATION")?.text.trim() ?? "";
}

/** A reprocess that came out clean resolves the message's open issues. */
export async function closeIssuesFor(messageId: number): Promise<number> {
  const rows = await query<{ id: number }>(
    `UPDATE extraction_issues
        SET status = 'resolved', resolution = COALESCE(resolution, '{"by":"reprocess"}'::jsonb)
      WHERE message_id = $1 AND status = 'open'
      RETURNING id`,
    [messageId],
  );
  return rows.length;
}

/**
 * Upsert a format signature. The six fixture formats and the sample messages
 * G-J are born `known`; anything else is `new` until an admin confirms it.
 */
export async function recordFormatSignature(
  signature: string,
  messageId: number,
): Promise<{ status: "new" | "known"; created: boolean }> {
  const existing = await queryOne<{ status: "new" | "known" }>(
    `SELECT status FROM format_signatures WHERE signature = $1`,
    [signature],
  );
  if (existing) {
    await query(
      `UPDATE format_signatures SET last_seen = now(), messages = messages + 1 WHERE signature = $1`,
      [signature],
    );
    return { status: existing.status, created: false };
  }
  const status: "new" | "known" = KNOWN_SIGNATURES.has(signature) ? "known" : "new";
  await query(
    `INSERT INTO format_signatures (signature, status, example_message_id, last_seen, messages)
     VALUES ($1, $2, $3, now(), 1)
     ON CONFLICT (signature) DO UPDATE SET last_seen = now(), messages = format_signatures.messages + 1`,
    [signature, status, messageId],
  );
  return { status, created: true };
}
