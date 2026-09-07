import { NextResponse } from "next/server";
import { handler, jobIdFrom, notFound, rateLimit } from "@/lib/api";
import { getCurrentUser, isAdminActor } from "@/lib/auth";
import { matchesForJob } from "@/lib/match/run";
import { toPublicTruckMatches } from "@/lib/match/wire";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * "Trucks that could take this", the mirror, with the same properties.
 *
 * `GET /api/loads` and `GET /api/loads/[id]` are untouched by this feature and
 * this is a sibling route rather than a field added to either of them: the job
 * board's response shape is frozen, and a match array hanging off the detail
 * payload would have made every job open cost a corridor scan.
 *
 * The scope passed into the truck half is the literal "public", so an
 * unreviewed truck cannot reach a reader through a job's match list -- which is
 * the exact back door two tables exist to close. The audience is applied to the
 * job as well, so this route 404s on somebody else's demo job rather than
 * confirming the id.
 */
export const GET = handler(async (req: Request, ctx: Ctx) => {
  rateLimit(req, "loads-matches", 60);
  const { id } = await ctx.params;

  const jobId = jobIdFrom(id);
  if (jobId == null) notFound("Job not found");

  const user = await getCurrentUser();
  const audience = {
    userId: user?.id ?? null,
    includeDemo: !!user && isAdminActor(user),
  };

  const result = await matchesForJob(jobId, "public", audience);
  if (!result) notFound("Job not found");

  return NextResponse.json(toPublicTruckMatches(result));
});
