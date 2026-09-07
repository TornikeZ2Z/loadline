import { NextResponse } from "next/server";
import { badRequest, handler, notFound } from "@/lib/api";
import { requireWriteRole } from "@/lib/auth";
import { queryOne } from "@/lib/db";

export const PATCH = handler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireWriteRole("admin");
  const { id } = await ctx.params;
  const body = (await req.json()) as { status?: string; resolution?: unknown };
  if (!["resolved", "ignored", "open"].includes(body.status ?? "")) badRequest("status must be resolved | ignored | open");
  const issue = await queryOne(
    `UPDATE extraction_issues SET status = $2, resolution = COALESCE($3::jsonb, resolution)
      WHERE id = $1
      RETURNING id, kind, line_hash, sample_line, message_id, sender_key, occurrences,
                first_seen_at::text AS first_seen_at, last_seen_at::text AS last_seen_at, status, resolution`,
    [Number(id), body.status, body.resolution === undefined ? null : JSON.stringify(body.resolution)],
  );
  if (!issue) notFound("Issue not found");
  return NextResponse.json({ issue });
});
