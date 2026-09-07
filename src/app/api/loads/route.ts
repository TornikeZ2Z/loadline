import { NextResponse } from "next/server";
import { badRequest, handler, rateLimit } from "@/lib/api";
import { getCurrentUser, isAdminActor, requirePosting } from "@/lib/auth";
import { searchLoads } from "@/lib/loads/query";
import { parseSearchParams } from "@/lib/loads/searchParams";
import { toPublicLoads } from "@/lib/loads/publicView";
import { insertWebJob, WebJobValidationError, type WebJobBody } from "@/lib/pipeline/web";

/**
 * Three keys an anonymous caller may not use.
 *
 * `?sender=phone:%2B17865550128` is the dangerous one: even with `sender_key`
 * stripped from every row, `summary.count` would answer "is this number the
 * author of these jobs?" -- a phone oracle built out of a filter. Twins and the
 * review flag are simply admin tooling.
 */
const ADMIN_ONLY_KEYS = ["sender", "dupes", "review"] as const;

/**
 * `?demo=1` -- show demo-posted listings too. A REAL admin only.
 *
 * A separate constant with a stricter test than the three above, because those
 * are tooling and this is the gate itself. `isAdminActor` rather than
 * `role === "admin"`: a demo admin is an account the sign-in page can be talked
 * into handing out, and it must not be able to read what other demo sessions
 * typed. Off by default so the counts an admin reads describe the real corpus
 * -- a demo listing is somebody's scratch work, not supply on the board.
 */
const DEMO_KEY = "demo";

/** Search. Public: no session, no redirect, no sign-in wall in front of the board. */
export const GET = handler(async (req: Request) => {
  rateLimit(req, "search", 120);
  const url = new URL(req.url);

  // A session read that does NOT gate the route -- it decides whether the
  // admin-only keys survive into the query, and who the rows belong to.
  const user = await getCurrentUser();
  if (user?.role !== "admin") {
    for (const k of ADMIN_ONLY_KEYS) url.searchParams.delete(k);
  }
  const includeDemo = !!user && isAdminActor(user) && url.searchParams.get(DEMO_KEY) === "1";
  url.searchParams.delete(DEMO_KEY);

  // No fallback viewer: a location lives in the browser and arrives as
  // viewerLat/viewerLng, never from a column on the user row.
  const params = await parseSearchParams(url.searchParams);
  // The audience is a second argument and never part of `params`: `params` is
  // parsed from the URL, and an identity anybody could type there would gate
  // nothing. See src/lib/loads/query.ts.
  const result = await searchLoads(params, { userId: user?.id ?? null, includeDemo });

  return NextResponse.json({ ...result, rows: toPublicLoads(result.rows) });
});

/**
 * Publishing a job from the website rather than a WhatsApp group.
 *
 * A capability, not a role (`users.can_post`): a company that both hauls and
 * posts used to need two accounts, because "poster" was an exclusive choice
 * made once on the registration form. It never gated anything real either --
 * picking "poster" there takes ten seconds and no approval.
 *
 * A demo account still passes this gate and still gets a 201 -- the walkthrough
 * is the demo. What it gets is a listing stamped `loads.is_demo`, which only
 * that account can see. The stamp is read from the SESSION, so calling this
 * route directly with a demo cookie changes nothing: there is no field in the
 * body that can turn it off.
 */
export const POST = handler(async (req: Request) => {
  const user = await requirePosting();
  const body = await readBody(req);

  try {
    const { id } = await insertWebJob(
      { id: user.id, name: user.name, phone: user.phone, isDemo: user.isDemo },
      body,
    );
    return NextResponse.json({ id }, { status: 201 });
  } catch (err) {
    // A validation error names the field, so the form can say which one.
    if (err instanceof WebJobValidationError) badRequest(`${err.field}: ${err.message}`);
    throw err;
  }
});

/**
 * The form posts either JSON or a FormData body depending on whether its
 * JavaScript is alive; both arrive here as the same string-keyed shape, which is
 * exactly what `WebJobBody` is (every field a string, validated by A).
 */
async function readBody(req: Request): Promise<WebJobBody> {
  const type = req.headers.get("content-type") ?? "";

  if (type.includes("application/json")) {
    const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v == null) continue;
      out[k] = typeof v === "string" ? v : String(v);
    }
    return out as unknown as WebJobBody;
  }

  const form = await req.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") out[k] = v;
  return out as unknown as WebJobBody;
}
