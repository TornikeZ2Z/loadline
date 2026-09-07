import { NextResponse } from "next/server";
import { badRequest, handler, jobIdFrom, notFound } from "@/lib/api";
import { HttpError, isAdminActor, requireUser } from "@/lib/auth";
import { truckOwner } from "@/lib/loads/truckQuery";
import { updateWebTruck, MANUAL_TRUCK_STATUSES, WebTruckValidationError } from "@/lib/pipeline/web";

/**
 * Mark a truck booked, cancelled -- or hand it back to available.
 *
 * A separate endpoint from `PATCH /api/trucks/[id]` even though that one also
 * accepts `status`, and the reason is the mirror of the job board's: the status
 * buttons on the detail are one tap and one round trip, and they must not be
 * able to send a partial edit of eleven other fields by accident. The job board
 * has `PATCH /api/loads/[id]/status` for the same reason and SPEC §13 lists both
 * for trucks.
 *
 * THREE STATUSES A PERSON MAY SET, and two they may not. `departed` and
 * `expired` are conclusions the sweep draws from facts -- the stated departure
 * day passed, or the 48-hour TTL ran out -- and a button that sets them would
 * let a driver assert a fact about the calendar. They are refused by name so
 * the error says which, rather than "invalid status".
 *
 * Ownership, not role, and the 404 before the 403: see the PATCH above it.
 */
const DERIVED = ["departed", "expired"];

export const PATCH = handler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const { status } = (await req.json().catch(() => ({}))) as { status?: string };

  const truckId = jobIdFrom(id);
  if (truckId == null) notFound("Truck not found");

  if (status && DERIVED.includes(status)) {
    badRequest("derived statuses cannot be set — a truck departs or expires on its own clock");
  }
  if (!status || !(MANUAL_TRUCK_STATUSES as readonly string[]).includes(status)) {
    badRequest(`Status must be one of: ${MANUAL_TRUCK_STATUSES.join(", ")}`);
  }

  const owner = await truckOwner(truckId, "public", {
    userId: user.id,
    includeDemo: isAdminActor(user),
  });
  if (!owner) notFound("Truck not found");
  if (!isAdminActor(user) && owner.posted_by !== user.id) {
    throw new HttpError(403, "You can only update trucks you posted");
  }

  try {
    const result = await updateWebTruck(truckId, user.id, { status });
    if (!result) notFound("Truck not found");
    return NextResponse.json({ id: result.id, status });
  } catch (err) {
    if (err instanceof WebTruckValidationError) badRequest(`${err.field}: ${err.message}`);
    throw err;
  }
});
