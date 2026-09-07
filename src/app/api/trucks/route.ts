import { NextResponse } from "next/server";
import { badRequest, handler, rateLimit } from "@/lib/api";
import { getCurrentUser, isAdminActor } from "@/lib/auth";
import { searchTrucks } from "@/lib/loads/truckQuery";
import { parseTruckSearchParams, TruckSearchParamError } from "@/lib/loads/truckSearchParams";
import { toPublicTrucks } from "@/lib/loads/publicView";

/**
 * The public truck board.
 *
 * A SECOND endpoint rather than a mode of `GET /api/loads`. The two fail
 * independently on purpose: a trucks outage shows "Couldn't load trucks." above
 * an otherwise working job board and must never blank it, and `GET /api/loads`
 * is not modified by this feature -- not its parser, not its admin keys, not
 * its response shape.
 *
 * Nothing here can return a truck the public may not see. `searchTrucks` takes
 * its scope as a required first argument and this handler passes the literal
 * `"public"`, which pins `visibility = 'public'` in the SQL; there is no key in
 * the URL that can change it.
 */

/**
 * Two keys an anonymous caller may not use.
 *
 * `?sender=phone:%2B17865550128` is the dangerous one: even with `sender_key`
 * stripped from every row, `summary.count` would answer "is this number the
 * author of these trucks?" -- a phone oracle built out of a filter. The review
 * flag is admin tooling. `dupes` is absent because trucks have no duplicate
 * groups; the parser refuses it outright.
 */
const ADMIN_ONLY_KEYS = ["sender", "review"] as const;

/**
 * `?demo=1` -- show demo-posted trucks too. A REAL admin only, exactly as on
 * the job board: `isAdminActor` rather than `role === "admin"`, because a demo
 * admin is an account the sign-in page can be talked into handing out.
 */
const DEMO_KEY = "demo";

/** Search. Public: no session, no redirect, no sign-in wall in front of the board. */
export const GET = handler(async (req: Request) => {
  // Its OWN bucket, not the job board's. The board fetches both surfaces for
  // one screen, so a shared allowance would be spent twice per view -- and,
  // worse, a scraper hammering trucks would 429 the job board with it. The two
  // are required to fail independently.
  rateLimit(req, "trucks-search", 120);
  const url = new URL(req.url);

  // A session read that does NOT gate the route -- it decides whether the
  // admin-only keys survive into the query, and whose demo rows are whose.
  const user = await getCurrentUser();
  if (user?.role !== "admin") {
    for (const k of ADMIN_ONLY_KEYS) url.searchParams.delete(k);
  }
  const includeDemo = !!user && isAdminActor(user) && url.searchParams.get(DEMO_KEY) === "1";
  url.searchParams.delete(DEMO_KEY);

  let params;
  try {
    params = await parseTruckSearchParams(url.searchParams);
  } catch (err) {
    // A job board's URL pointed at the truck board. Say which key, and which
    // truck control the caller wanted, rather than answering an unfiltered
    // board to a question about freight.
    if (err instanceof TruckSearchParamError) badRequest(err.message);
    throw err;
  }

  const result = await searchTrucks("public", params, {
    userId: user?.id ?? null,
    includeDemo,
  });

  return NextResponse.json({ ...result, rows: toPublicTrucks(result.rows) });
});
