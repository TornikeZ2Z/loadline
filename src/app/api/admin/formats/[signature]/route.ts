import { NextResponse } from "next/server";
import { badRequest, handler, notFound } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { query, queryOne } from "@/lib/db";
import { reprocessMessages } from "@/lib/pipeline/process";

/**
 * "Confirm format": a parseable layout the pipeline had never seen sits in
 * the queue as `new_format` until an admin marks its signature `known`; the
 * messages carrying it are re-run and come out `clean`. `signature` arrives
 * URL-encoded (it contains "|", "+" and spaces).
 */
export const PATCH = handler(async (req: Request, ctx: { params: Promise<{ signature: string }> }) => {
  await requireRole("admin");
  const { signature: raw } = await ctx.params;
  const signature = decodeURIComponent(raw);
  const body = (await req.json()) as { status?: string };
  if (body.status !== "known" && body.status !== "new") badRequest("status must be known | new");

  const row = await queryOne(
    `UPDATE format_signatures SET status = $2 WHERE signature = $1
     RETURNING signature, status, example_message_id, first_seen::text AS first_seen, last_seen::text AS last_seen, messages`,
    [signature, body.status],
  );
  if (!row) notFound("Format signature not found");

  const ids = (await query<{ id: number }>(`SELECT id FROM raw_messages WHERE format_signature = $1 ORDER BY sent_at, id`, [signature])).map((r) => r.id);
  const results = await reprocessMessages(ids);
  return NextResponse.json({ signature: row, reprocessed: results.length });
});
