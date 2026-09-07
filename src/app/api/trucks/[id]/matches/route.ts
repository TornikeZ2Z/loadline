import { NextResponse } from "next/server";
import { handler, jobIdFrom, notFound, rateLimit } from "@/lib/api";
import { getCurrentUser, isAdminActor } from "@/lib/auth";
import { matchesForTruck } from "@/lib/match/run";
import { toPublicJobMatches } from "@/lib/match/wire";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * "Loads that fit this truck", for anybody.
 *
 * PUBLIC, and it can be, because it returns only rows that are already on the
 * public board: every job in the list is one `GET /api/loads` would serve to the
 * same caller, redacted by the same `toPublicLoad`. It cannot answer a question
 * the board cannot. No phone leaves through it in either direction -- a match is
 * a pointer, not an introduction, and calling still means going through the
 * contact gate on whichever listing the reader picks, where the reveal is logged.
 *
 * "Public" is not "unaudienced", and here it is doubly so. The scope is the
 * literal "public", so a truck sitting in the review queue 404s exactly as it
 * does on the detail route rather than quietly returning an empty list that
 * admits the id is real. The audience travels into BOTH halves of the query: a
 * demo account's truck is that account's business, and so is every demo-posted
 * job that might otherwise show up inside a stranger's match list.
 *
 * Its own rate-limit bucket at 60/min (SPEC 13). A match query is up to 2,000
 * pure evaluations and two indexed reads; it is not free, and it must not spend
 * the board's allowance.
 */
export const GET = handler(async (req: Request, ctx: Ctx) => {
  rateLimit(req, "trucks-matches", 60);
  const { id } = await ctx.params;

  const truckId = jobIdFrom(id);
  if (truckId == null) notFound("Truck not found");

  const user = await getCurrentUser();
  const audience = {
    userId: user?.id ?? null,
    includeDemo: !!user && isAdminActor(user),
  };

  const result = await matchesForTruck(truckId, "public", audience);
  if (!result) notFound("Truck not found");

  return NextResponse.json(toPublicJobMatches(result));
});
