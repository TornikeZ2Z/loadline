import { NextResponse } from "next/server";
import { badRequest, handler, notFound } from "@/lib/api";
import { HttpError, isAdminActor, requireUser } from "@/lib/auth";
import { queryOne } from "@/lib/db";
import { isLoadVisible } from "@/lib/loads/query";
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
 * Ownership, not role: a person may only touch rows they posted. Batch jobs
 * extracted from a group have `posted_by` NULL and belong to nobody but a real
 * admin -- somebody marking a rival's WhatsApp job taken would be vandalism
 * with a nice button. `isAdminActor` is the test rather than `role === "admin"`
 * because the demo hands an admin session to anyone with the URL, and delisting
 * 98 jobs one button at a time destroys the board just as thoroughly as the
 * TRUNCATE behind /api/test/reset.
 */
export const PATCH = handler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
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

  // Ownership already refuses somebody else's row, so this is not what stops a
  // stranger marking a demo listing taken -- it is what stops the 403 telling
  // them the listing is there. A row the caller may not see must be indistin-
  // guishable from a row that does not exist. The demo poster still owns theirs,
  // and a real admin still reaches every row (`includeDemo`).
  const visible = await isLoadVisible(load.id, {
    userId: user.id,
    includeDemo: isAdminActor(user),
  });
  if (!visible) notFound("Job not found");

  if (!isAdminActor(user) && load.posted_by !== user.id) {
    throw new HttpError(403, "You can only update jobs you posted");
  }

  const r = await setManualStatus(load.id, status as ManualStatus, user.id);
  return NextResponse.json({ id: r.id, status: r.status, status_source: r.status_source });
});
