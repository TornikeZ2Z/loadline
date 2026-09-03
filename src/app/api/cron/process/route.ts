import { NextResponse } from "next/server";
import { handler, requireCronSecret } from "@/lib/api";
import { processPending } from "@/lib/pipeline/process";

/**
 * Drain the pending message queue.
 *
 * The webhook enqueues and returns immediately -- Meta retries deliveries that
 * do not get a fast 200, and extraction is far too slow to run inline. This is
 * the worker; point a scheduler at it every minute.
 */
export const POST = handler(async (req: Request) => {
  requireCronSecret(req);
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 25);
  const results = await processPending(Number.isFinite(limit) ? limit : 25);
  return NextResponse.json({
    processed: results.length,
    loadsCreated: results.reduce((n, r) => n + r.loadsCreated, 0),
    duplicates: results.reduce((n, r) => n + r.duplicates, 0),
    results,
  });
});
