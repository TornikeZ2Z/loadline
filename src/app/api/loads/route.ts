import { NextResponse } from "next/server";
import { badRequest, handler, rateLimit } from "@/lib/api";
import { getCurrentUser, requirePosting } from "@/lib/auth";
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

/** Search. Public: no session, no redirect, no sign-in wall in front of the board. */
export const GET = handler(async (req: Request) => {
  rateLimit(req, "search", 120);
  const url = new URL(req.url);

  // A session read that does NOT gate the route -- it only decides whether the
  // three admin-only keys survive into the query.
  const user = await getCurrentUser();
  if (user?.role !== "admin") {
    for (const k of ADMIN_ONLY_KEYS) url.searchParams.delete(k);
  }

  // No fallback viewer: a location lives in the browser and arrives as
  // viewerLat/viewerLng, never from a column on the user row.
  const params = await parseSearchParams(url.searchParams);
  const result = await searchLoads(params);

  return NextResponse.json({ ...result, rows: toPublicLoads(result.rows) });
});

/**
 * Publishing a job from the website rather than a WhatsApp group.
 *
 * A capability, not a role (`users.can_post`): a company that both hauls and
 * posts used to need two accounts, because "poster" was an exclusive choice
 * made once on the registration form. It never gated anything real either --
 * picking "poster" there takes ten seconds and no approval.
 */
export const POST = handler(async (req: Request) => {
  const user = await requirePosting();
  const body = await readBody(req);

  try {
    const { id } = await insertWebJob({ id: user.id, name: user.name, phone: user.phone }, body);
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
