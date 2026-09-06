import { NextResponse } from "next/server";
import { handler, notFound } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { query, queryOne } from "@/lib/db";
import { getMessage, loadsForMessage } from "@/lib/demo/chats";

/**
 * One message with everything the pipeline recorded about it: the extraction
 * outcome (with the per-line audit the gutter renders), the jobs it sighted,
 * its snapshot, and its open issues.
 */
export const GET = handler(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole("admin");
  const { id } = await ctx.params;
  const messageId = Number(id);
  const message = await getMessage(messageId);
  if (!message) notFound("Message not found");

  const [loads, snapshot, issues] = await Promise.all([
    loadsForMessage(messageId),
    queryOne(
      `SELECT id, sender_key, message_id, group_id, sent_at::text AS sent_at, kind, kind_reason, job_count, job_keys,
              origin_keys, new_count, kept_count, revived_count, retired_count, needs_review, created_at::text AS created_at
         FROM sender_snapshots WHERE message_id = $1`,
      [messageId],
    ),
    query(
      `SELECT id, kind, line_hash, sample_line, message_id, sender_key, occurrences,
              first_seen_at::text AS first_seen_at, last_seen_at::text AS last_seen_at, status, resolution
         FROM extraction_issues WHERE message_id = $1 ORDER BY status, id`,
      [messageId],
    ),
  ]);

  return NextResponse.json({ message, loads, snapshot, issues });
});
