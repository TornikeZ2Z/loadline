import { NextResponse } from "next/server";
import { badRequest, handler } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import {
  hereStatus,
  surveyBoardZips,
  warmBoardZips,
  WARM_BATCH,
  WARM_BATCH_MAX,
} from "@/lib/geo/zips";

/**
 * Make a deployed board's map precise.
 *
 * `npm run zips:warm` does this locally, but a production database sits inside
 * the VPC with nothing outside able to reach it, so the only process that can
 * run the sweep is the app itself. Hence a route rather than only a script —
 * and both call the same function in src/lib/geo/zips.ts.
 *
 * GET  surveys: how many ZIPs are precise, approximate or never geocoded, and
 *      how many job endpoints are still drawn as "approximate". Counts only —
 *      nothing billable happens.
 *
 * POST sweeps one batch: `?limit=` ZIPs (default 40, max 200), resuming from
 *      `?after=<zip>`. It answers with the batch's tally and a `nextAfter`
 *      cursor, so a board with thousands of jobs is walked by a caller that
 *      can stop, instead of by one request held open for minutes. Calling it
 *      again on a warm board is a no-op: every fetch is skipped and no row
 *      moves.
 */
export const GET = handler(async () => {
  await requireRole("admin");
  const survey = await surveyBoardZips();
  return NextResponse.json({ survey, here: hereStatus(), batch: WARM_BATCH });
});

export const POST = handler(async (req: Request) => {
  await requireRole("admin");
  const sp = new URL(req.url).searchParams;

  const raw = Number(sp.get("limit"));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), WARM_BATCH_MAX) : WARM_BATCH;

  // A cursor is a ZIP this route handed out; anything else is a caller typo,
  // and silently sweeping from the start would be a worse answer than 400.
  const after = sp.get("after");
  if (after !== null && !/^\d{5}(-\d{4})?$/.test(after)) {
    badRequest("`after` must be a ZIP this route handed back as `nextAfter`");
  }

  const result = await warmBoardZips({ limit, after });
  return NextResponse.json(result);
});
