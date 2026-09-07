import { NextResponse } from "next/server";
import { handler, jobIdFrom, notFound, rateLimit } from "@/lib/api";
import { getCurrentUser, isAdminActor } from "@/lib/auth";
import { isLoadVisible } from "@/lib/loads/query";
import { loadRoadRoute } from "@/lib/loads/roadDistance";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * The road one job's truck would actually drive: `GET /api/loads/:id/route`.
 *
 * The map draws a lane only for the job a driver has opened, so this is the one
 * place the geometry is asked for -- never for a list, a hover, or the points
 * view. Behind it, `loadRoadRoute` serves the row's cached `road_path` when
 * there is one and otherwise buys the geometry on the same HERE call that fills
 * `road_miles`, so a job costs one routing request in its lifetime.
 *
 * Public and phone-free, like every other read endpoint: a list of coordinates
 * carries nothing a contact gate exists to protect. When there is no road route
 * to give -- no HERE key, quota spent, an endpoint the router will not accept --
 * it answers `unavailable` with a null path rather than an error, and the map
 * falls back to its dashed straight line.
 *
 * It is still a path that returns part of a job, though -- the lane's geometry
 * and its length -- so a listing the caller may not see must 404 before the
 * router is asked. `loadRoadRoute` is another bare `WHERE id = $1`, and rather
 * than teach it who is asking (it is about billing HERE, not about access), the
 * question is asked here, as one primary-key lookup, and answered by the same
 * predicate every other read uses.
 */
export const GET = handler(async (req: Request, ctx: Ctx) => {
  rateLimit(req, "route", 120);
  const { id } = await ctx.params;

  const jobId = jobIdFrom(id);
  if (jobId == null) notFound("Job not found");

  const user = await getCurrentUser();
  const visible = await isLoadVisible(jobId, {
    userId: user?.id ?? null,
    includeDemo: !!user && isAdminActor(user),
  });
  if (!visible) notFound("Job not found");

  const route = await loadRoadRoute(jobId);
  if (!route) notFound("Job not found");

  return NextResponse.json(route);
});
