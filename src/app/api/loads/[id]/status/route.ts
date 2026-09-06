import { NextResponse } from "next/server";
import { badRequest, handler, notFound } from "@/lib/api";
import { HttpError, requireRole } from "@/lib/auth";
import { queryOne } from "@/lib/db";
import { setManualStatus, type ManualStatus } from "@/lib/pipeline/reconcile";

/** Only these can be set by a person. */
const MANUAL: ManualStatus[] = ["available", "pending", "taken", "cancelled"];
/** These are conclusions the lifecycle draws, not choices anyone makes. */
const DERIVED = ["expired", "delisted"];

/**
 * Mark a job taken, pending, cancelled -- or hand it back to the lifecycle.
 *
 * "Taken" is the one thing that stops the board drifting back toward WhatsApp,
 * where nobody ever says a job is gone. It is sticky: A's `setManualStatus`
 * keeps it taken through later reposts, because the person who marked it knows
 * something the post does not.
 *
 * A poster may only touch rows they posted. Batch jobs extracted from a group
 * have `posted_by` NULL and belong to nobody but an admin -- a poster marking a
 * rival's WhatsApp job taken would be vandalism with a nice button.
 */
export const PATCH = handler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireRole("poster", "admin");
  const { id } = await ctx.params;
  const { status } = (await req.json().catch(() => ({}))) as { status?: string };

  if (status && DERIVED.includes(status)) {
    badRequest("derived statuses cannot be set");
  }
  if (!status || !MANUAL.includes(status as ManualStatus)) {
    badRequest(`Status must be one of: ${MANUAL.join(", ")}`);
  }

  const load = await queryOne<{ id: number; posted_by: number | null; status: string }>(
    `SELECT id, posted_by, status FROM loads WHERE id = $1`,
    [id],
  );
  if (!load) notFound("Job not found");

  if (user.role === "poster" && load.posted_by !== user.id) {
    throw new HttpError(403, "You can only update jobs you posted");
  }

  const r = await setManualStatus(load.id, status as ManualStatus, user.id);
  return NextResponse.json({ id: r.id, status: r.status, status_source: r.status_source });
});
