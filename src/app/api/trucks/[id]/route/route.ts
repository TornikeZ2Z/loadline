import { NextResponse } from "next/server";
import { handler, jobIdFrom, notFound, rateLimit } from "@/lib/api";
import { getCurrentUser, isAdminActor } from "@/lib/auth";
import { isTruckVisible } from "@/lib/loads/truckQuery";
import { truckRoadRoute } from "@/lib/loads/roadDistance";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * The road one truck will actually drive: `GET /api/trucks/:id/route`.
 *
 * The sibling of `GET /api/loads/:id/route`, and a separate handler for the
 * same reason the whole feature is separate: `loadRoadRoute` is
 * `WHERE id = $1` against `loads`, and there is no predicate on it to extend.
 * Behind this one, `truckRoadRoute` serves the row's cached `road_path` when
 * there is one and otherwise buys the geometry on the same HERE call that fills
 * `road_miles`, so a truck costs one routing request in its lifetime -- drawn
 * only for the truck a driver OPENS, never for a list, a hover or the arrows.
 *
 * A truck whose post never said where it is going answers `unavailable` with a
 * null path. That is not a failure: there is no destination to route to, and
 * asking HERE to route towards a guess would be a billable call about a fact
 * nobody stated.
 *
 * Public and phone-free, like every other read endpoint -- a list of
 * coordinates carries nothing the contact gate exists to protect. But it is
 * still part of a listing, so a truck the caller may not see has to 404 before
 * the router is asked, and `isTruckVisible(id, "public", audience)` is the same
 * pair of predicates every other truck read uses: the literal "public" scope
 * pins `visibility` in SQL, and the audience keeps a demo account's own truck
 * to itself.
 */
export const GET = handler(async (req: Request, ctx: Ctx) => {
  // Its own bucket. A truck's geometry and a job's are different endpoints, and
  // one must not spend the other's allowance.
  rateLimit(req, "truck-route", 120);
  const { id } = await ctx.params;

  const truckId = jobIdFrom(id);
  if (truckId == null) notFound("Truck not found");

  const user = await getCurrentUser();
  const visible = await isTruckVisible(truckId, "public", {
    userId: user?.id ?? null,
    includeDemo: !!user && isAdminActor(user),
  });
  if (!visible) notFound("Truck not found");

  const route = await truckRoadRoute(truckId);
  if (!route) notFound("Truck not found");

  return NextResponse.json(route);
});
