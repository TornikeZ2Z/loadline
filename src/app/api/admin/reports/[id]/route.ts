import { NextResponse } from "next/server";
import { badRequest, handler, jobIdFrom, notFound } from "@/lib/api";
import { requireWriteRole } from "@/lib/auth";
import { queryOne } from "@/lib/db";

/**
 * Close a report, or put one back.
 *
 * `requireWriteRole`, not `requireRole`: closing a report changes what the next
 * admin sees in a shared queue, and a demo admin does not get to empty it. That
 * also means the `resolved_by` recorded below is always a real admin.
 *
 * Three words, and the difference between two of them matters to the public
 * endpoint. RESOLVED means "fixed" -- a fresh report about the same job and
 * reason reopens it, because a problem that comes back is news. DISMISSED means
 * "looked at, and the job is right" -- POST /api/reports leaves it alone, so
 * one more anonymous click cannot overrule the person who looked. OPEN is the
 * way back from either.
 */
export const PATCH = handler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await requireWriteRole("admin");

  const { id } = await ctx.params;
  const reportId = jobIdFrom(id);
  if (reportId === null) notFound("Report not found");

  const body = (await req.json().catch(() => ({}))) as { status?: string };
  const status = body.status ?? "";
  if (!["open", "resolved", "dismissed"].includes(status)) {
    badRequest("status must be open | resolved | dismissed");
  }

  // Reopening clears who closed it and when, so the row never claims it was
  // resolved by somebody who has since reopened it.
  const closing = status !== "open";
  const report = await queryOne(
    `UPDATE problem_reports
        SET status      = $2,
            resolved_at = CASE WHEN $3::boolean THEN now() ELSE NULL END,
            resolved_by = CASE WHEN $3::boolean THEN $4::bigint ELSE NULL END
      WHERE id = $1
      RETURNING id, load_id, reason, details, status, occurrences,
                first_seen_at::text AS first_seen_at,
                last_seen_at::text  AS last_seen_at,
                resolved_at::text   AS resolved_at`,
    [reportId, status, closing, admin.id],
  );
  if (!report) notFound("Report not found");

  return NextResponse.json({ report });
});
