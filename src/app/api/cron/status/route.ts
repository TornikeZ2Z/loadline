import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { cronEnabled, cronModeReason } from "@/lib/cron/config";
import { cronStatus } from "@/lib/cron/runs";

/**
 * What the sweeps have been doing, for the strip at the top of /admin.
 *
 * THE ONE ROUTE UNDER /api/cron THAT IS NOT BEHIND THE BEARER TOKEN, and the
 * asymmetry is the point: the other three DO something and are called by a
 * machine holding `CRON_SECRET`; this one only reports, and its reader is a
 * person with an admin session. Guarding it with the cron secret would mean the
 * browser had to hold that secret to render the console, which is how a shared
 * token ends up in a client bundle.
 *
 * `requireRole` and not `requireWriteRole`: it is a read, so a demo admin may
 * see it. There is nothing here to protect from a demo admin -- run counts and
 * timestamps for three sweeps -- and nothing here to break.
 *
 * `enabled` is this PROCESS's answer, not the deployment's. Under more than one
 * task the console reaches whichever task the ALB picked, so the honest
 * sentence is "the process that answered you is/is not scheduling"; the rows
 * carry `runner`, which is who actually did the work.
 */
export const GET = handler(async () => {
  await requireRole("admin");
  const status = await cronStatus({ enabled: cronEnabled(), reason: cronModeReason() });
  return NextResponse.json(status);
});
