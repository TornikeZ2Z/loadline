import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";

/**
 * The raw message feed with its processing outcome. This is the view that
 * answers "why isn't that load on the board?" -- the single most common
 * question an operator will have about an AI-fed pipeline.
 */
export const GET = handler(async (req: Request) => {
  await requireRole("admin");
  const sp = new URL(req.url).searchParams;
  const status = sp.get("status");
  const limit = Math.min(Number(sp.get("limit") ?? 50) || 50, 200);

  const rows = await query(
    `SELECT m.id, m.body, m.author_name, m.author_phone, m.status, m.skip_reason, m.error,
            m.extractor, m.attempts,
            m.sent_at::text AS sent_at, m.processed_at::text AS processed_at,
            g.name AS group_name,
            (SELECT count(*) FROM loads l WHERE l.source_message_id = m.id)::int AS load_count
       FROM raw_messages m
       LEFT JOIN whatsapp_groups g ON g.id = m.group_id
      WHERE ($1::text IS NULL OR m.status = $1)
      ORDER BY m.sent_at DESC
      LIMIT $2`,
    [status || null, limit],
  );

  return NextResponse.json({ messages: rows });
});
