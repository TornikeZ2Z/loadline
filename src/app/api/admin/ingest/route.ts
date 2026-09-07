import { NextResponse } from "next/server";
import { badRequest, handler } from "@/lib/api";
import { requireWriteRole } from "@/lib/auth";
import { queryOne } from "@/lib/db";
import { loadsForMessage } from "@/lib/demo/chats";
import { extractInventory, scopedRules, type ExtractionOutcome } from "@/lib/extract";
import { ingestMessage } from "@/lib/pipeline/ingest";
import { reprocessMessage } from "@/lib/pipeline/process";
import { senderKeyFor } from "@/lib/pipeline/reconcile";
import { loadRuleSet } from "@/lib/pipeline/rules";

/**
 * Paste a WhatsApp message and watch it become jobs.
 *
 * The pipeline's test harness, exposed in the admin UI: it goes through the
 * same ingest -> extract -> geocode -> snapshot path as webhook traffic, so
 * what you see here is exactly what production would do with that text.
 * `dryRun: true` extracts only -- no raw_messages row, no jobs, no format
 * signature -- which is what "Teach line" uses for its live re-parse preview.
 */
export const POST = handler(async (req: Request) => {
  await requireWriteRole("admin");
  const body = (await req.json()) as {
    text?: string;
    author?: string;
    phone?: string;
    group?: string;
    sentAt?: string;
    dryRun?: boolean;
  };

  const text = (body.text ?? "").trim();
  if (!text) badRequest("Paste a message first");

  const sentAt = body.sentAt ? new Date(body.sentAt) : new Date();
  if (Number.isNaN(sentAt.getTime())) badRequest("sentAt is not a valid date");

  if (body.dryRun) {
    const senderKey = senderKeyFor({ author_phone: body.phone || null, author_name: body.author || null, group_id: null, id: 0 });
    const rules = scopedRules(await loadRuleSet(), senderKey);
    const outcome = extractInventory(
      { body: text, authorName: body.author || null, authorPhone: body.phone || null, groupName: body.group || null, sentAt },
      rules,
    );
    return NextResponse.json({
      status: "dry_run",
      loadsCreated: 0,
      extractor: outcome.extractor,
      extracted: outcome,
      parse_status: outcome.parse_status,
      attention: outcome.attention,
      format_signature: outcome.format_signature,
      flags: outcome.flags,
      loads: [],
    });
  }

  const { messageId } = await ingestMessage({
    waMessageId: `manual.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
    body: text,
    sentAt,
    authorName: body.author || "Manual entry",
    authorPhone: body.phone || null,
    groupName: body.group || "Manual entry",
    groupWaId: body.group ? `name:${body.group}` : "manual",
    payload: { source: "admin" },
  });

  // reprocess rather than process: it resets state first, which makes
  // re-submitting the same text idempotent.
  const result = await reprocessMessage(messageId);

  const recorded = await queryOne<{
    extractor: string | null; extracted: ExtractionOutcome | null; parse_status: string | null;
    attention: string | null; format_signature: string | null; flags: string[];
  }>(
    `SELECT extractor, extracted, parse_status, attention, format_signature, coalesce(flags, '{}') AS flags
       FROM raw_messages WHERE id = $1`,
    [messageId],
  );

  return NextResponse.json({
    ...result,
    status: result.status,
    reason: result.reason,
    loadsCreated: result.loadsCreated,
    extractor: "inventory-v1",
    extracted: recorded?.extracted ?? null,
    parse_status: recorded?.parse_status ?? result.parse_status ?? null,
    attention: recorded?.attention ?? result.attention ?? null,
    format_signature: recorded?.format_signature ?? null,
    flags: recorded?.flags ?? [],
    loads: await loadsForMessage(messageId),
  });
});
