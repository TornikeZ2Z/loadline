import { NextResponse } from "next/server";
import { badRequest, handler, jobIdFrom, notFound, rateLimit } from "@/lib/api";
import { HttpError, getCurrentUser, isAdminActor, requireUser } from "@/lib/auth";
import { query } from "@/lib/db";
import { getTruck, truckOwner } from "@/lib/loads/truckQuery";
import { toPublicSource, toPublicTruck, type PublicSource } from "@/lib/loads/publicView";
import { updateWebTruck, WebTruckValidationError, type WebTruckPatch } from "@/lib/pipeline/web";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * One truck, for anybody.
 *
 * Public and phone-free: the row and the original WhatsApp text come back with
 * every number replaced by "[phone hidden]". Nothing is recorded here either --
 * opening a listing is browsing, not interest.
 *
 * TWO ways this 404s, and both are silent about which:
 *
 *   * `getTruck(id, "public")` pins `visibility = 'public'`, so a truck sitting
 *     in the review queue is not "a truck you may not see" -- it does not exist
 *     at this URL. That is the whole reason capacity has its own table: the job
 *     board's `getLoad` is `WHERE l.id = $1` with no predicate to extend, and
 *     under one table an unreviewed row would have been reachable by
 *     incrementing a bigserial;
 *   * the audience hides a truck posted from a demo account from everyone but
 *     the account that posted it.
 *
 * `jobIdFrom` parses the `[id]` segment. It is named for the board it was
 * written on and knows nothing about jobs: digits only, inside bigint range, so
 * "abc" and "0x10" 404 instead of reaching the database.
 */
export const GET = handler(async (req: Request, ctx: Ctx) => {
  // Its own bucket, like the board's: a truck detail and a job detail are
  // different endpoints, and one must not spend the other's allowance.
  rateLimit(req, "trucks-detail", 120);
  const { id } = await ctx.params;

  const truckId = jobIdFrom(id);
  if (truckId == null) notFound("Truck not found");

  const user = await getCurrentUser();
  const audience = {
    userId: user?.id ?? null,
    includeDemo: !!user && isAdminActor(user),
  };

  const truck = await getTruck(truckId, "public", audience);
  if (!truck) notFound("Truck not found");

  // The original WhatsApp text, so a driver can judge the extraction for
  // themselves rather than trusting a parsed summary. Null for a truck typed
  // into the form, which is every truck until stage 6.
  const source = truck.source_message_id
    ? await query<PublicSource>(
        `SELECT m.body, m.author_name, m.sent_at::text AS sent_at, g.name AS group_name
           FROM raw_messages m LEFT JOIN whatsapp_groups g ON g.id = m.group_id
          WHERE m.id = $1`,
        [truck.source_message_id],
      )
    : [];

  return NextResponse.json({
    truck: toPublicTruck(truck),
    source: toPublicSource(source[0] ?? null),
  });
});

/**
 * Editing your own truck.
 *
 * EDITING EXISTS FOR TRUCKS AND NOT FOR JOBS, and the asymmetry is the point
 * (SPEC §9.1): a departure slips, and a truck advertising last Tuesday is worse
 * than no truck at all, because it costs a dispatcher the one call they were
 * going to make. Job editing stays out of scope and this will be asked for the
 * week trucks ship.
 *
 * Ownership, not role, exactly as `PATCH /api/loads/[id]/status`: `posted_by`,
 * or `isAdminActor` -- a REAL admin, because the demo hands an admin session to
 * anyone with the URL and editing away somebody's departure date is vandalism
 * with a nice button. A WhatsApp-parsed truck has `posted_by` NULL and belongs
 * to nobody but a real admin.
 *
 * The 404 comes before the 403, and that ordering is load-bearing: a row this
 * caller may not SEE must be indistinguishable from a row that does not exist,
 * or the error code becomes an oracle for the review queue and for other
 * people's demo listings.
 *
 * Origin and destination are absent from the accepted fields. Changing the lane
 * makes it a different truck, and stage 4's pairing history would silently
 * become about something else.
 */
export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;

  const truckId = jobIdFrom(id);
  if (truckId == null) notFound("Truck not found");

  // "public" and not "admin": the edit form is the public board's, and a truck
  // in the review queue is not editable by the person it was parsed from --
  // it is not theirs until an admin publishes it. `truckOwner` applies both
  // predicates and returns null rather than a row, so the 404 lands before
  // there is anything to answer 403 about.
  const owner = await truckOwner(truckId, "public", {
    userId: user.id,
    includeDemo: isAdminActor(user),
  });
  if (!owner) notFound("Truck not found");
  if (!isAdminActor(user) && owner.posted_by !== user.id) {
    throw new HttpError(403, "You can only edit trucks you posted");
  }

  const patch = (await req.json().catch(() => ({}))) as WebTruckPatch;

  try {
    const result = await updateWebTruck(truckId, user.id, patch);
    if (!result) notFound("Truck not found");
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof WebTruckValidationError) badRequest(`${err.field}: ${err.message}`);
    throw err;
  }
});
