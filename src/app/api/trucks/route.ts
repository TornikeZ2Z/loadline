import { NextResponse } from "next/server";
import { badRequest, handler, rateLimit } from "@/lib/api";
import { getCurrentUser, isAdminActor, requirePosting } from "@/lib/auth";
import { searchTrucks } from "@/lib/loads/truckQuery";
import { parseTruckSearchParams, TruckSearchParamError } from "@/lib/loads/truckSearchParams";
import { toPublicTrucks } from "@/lib/loads/publicView";
import { insertWebTruck, WebTruckValidationError, type WebTruckBody } from "@/lib/pipeline/web";

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

/**
 * Publishing an empty leg from the website.
 *
 * `requirePosting()`, the same capability that gates a job (`users.can_post`),
 * and deliberately not a role test: the whole point of stage 2 is that a driver
 * who registered as a driver can post their own truck. Wave 1 turned posting
 * into a capability precisely so a company that both hauls and posts would stop
 * needing two accounts, and this is the feature that makes that decision
 * load-bearing (SPEC §20).
 *
 * A demo account passes this gate and gets a 201, exactly as it does for a job.
 * What it gets is a row stamped `trucks.is_demo`, which only that account can
 * see. The stamp is read from the SESSION and from nowhere else -- there is no
 * field in the body that can turn it off, and `searchTrucks`' audience is what
 * keeps a stranger from ever seeing the row.
 */
export const POST = handler(async (req: Request) => {
  const user = await requirePosting();
  const body = await readTruckBody(req);

  try {
    const { id } = await insertWebTruck(
      { id: user.id, name: user.name, phone: user.phone, isDemo: user.isDemo },
      body,
    );
    return NextResponse.json({ id }, { status: 201 });
  } catch (err) {
    // A validation error names the field, so the form can say which one.
    if (err instanceof WebTruckValidationError) badRequest(`${err.field}: ${err.message}`);
    throw err;
  }
});

/**
 * JSON or FormData, both arriving as the same string-keyed shape.
 *
 * A copy of `readBody` in the job route rather than a shared import, for the
 * same reason the query layer is a sibling rather than a generalisation: that
 * file is frozen for this feature. The function is nine lines and the cost of
 * the copy is visible.
 */
async function readTruckBody(req: Request): Promise<WebTruckBody> {
  const type = req.headers.get("content-type") ?? "";

  if (type.includes("application/json")) {
    const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v == null) continue;
      out[k] = typeof v === "string" ? v : String(v);
    }
    return out as unknown as WebTruckBody;
  }

  const form = await req.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") out[k] = v;
  return out as unknown as WebTruckBody;
}
