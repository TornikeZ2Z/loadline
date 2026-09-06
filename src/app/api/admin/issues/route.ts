import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";

/** Recurring extraction problems, one row per (kind, normalized line). */
export const GET = handler(async (req: Request) => {
  await requireRole("admin");
  const sp = new URL(req.url).searchParams;
  const status = sp.get("status") ?? "open";
  const kind = sp.get("kind");
  // Round before clamping: LIMIT is bound as a bigint, so a fractional value
  // reaches the driver and 500s instead of being treated as a page size.
  const limit = Math.min(Math.max(Math.round(Number(sp.get("limit") ?? 100)) || 100, 1), 500);
  const issues = await query(
    `SELECT id, kind, line_hash, sample_line, message_id, sender_key, occurrences,
            first_seen_at::text AS first_seen_at, last_seen_at::text AS last_seen_at, status, resolution
       FROM extraction_issues
      WHERE ($1::text IS NULL OR $1 = 'any' OR status = $1)
        AND ($2::text IS NULL OR kind = $2)
      ORDER BY occurrences DESC, last_seen_at DESC, id DESC
      LIMIT $3`,
    [status || null, kind || null, limit],
  );
  return NextResponse.json({ issues });
});
