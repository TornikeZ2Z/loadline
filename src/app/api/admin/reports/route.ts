import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";

/**
 * The reported jobs, for the needs-attention queue.
 *
 * One row per (job, reason) -- see db/schema.sql -- so `occurrences` is how
 * many people said it and the row count is how many distinct problems there
 * are. Open first by default, because that is the only list the console asks
 * for; `?status=any` shows the closed ones too.
 *
 * The job is LEFT JOINed, not joined: `load_id` carries no foreign key on
 * purpose, so a report about a job that has since been deleted survives it and
 * comes back with null labels. The console says so rather than filling them in.
 *
 * `details` is a stranger's free text and travels raw to an admin's screen.
 * It was cleaned on the way in (src/lib/reports.ts `cleanReportDetails`:
 * control and bidi characters stripped, 500 characters hard) and it is escaped
 * on the way out by React rendering it as a text node. Nothing here interprets
 * it, links it or trusts it.
 */
export const GET = handler(async (req: Request) => {
  await requireRole("admin");
  const sp = new URL(req.url).searchParams;
  const status = sp.get("status") ?? "open";
  // Round before clamping, as GET /api/admin/issues does: LIMIT binds as a
  // bigint, so a fractional value reaches the driver and 500s.
  const limit = Math.min(Math.max(Math.round(Number(sp.get("limit") ?? 100)) || 100, 1), 500);

  const reports = await query(
    `SELECT r.id, r.load_id, r.reason, r.details, r.status, r.occurrences,
            r.first_seen_at::text AS first_seen_at,
            r.last_seen_at::text  AS last_seen_at,
            r.resolved_at::text   AS resolved_at,
            l.pickup_label, l.delivery_label, l.status AS load_status,
            u.name AS reporter_name, u.email AS reporter_email
       FROM problem_reports r
       LEFT JOIN loads l ON l.id = r.load_id
       LEFT JOIN users u ON u.id = r.reported_by
      WHERE ($1::text IS NULL OR $1 = 'any' OR r.status = $1)
      ORDER BY r.last_seen_at DESC, r.id DESC
      LIMIT $2`,
    [status || null, limit],
  );

  return NextResponse.json({ reports });
});
