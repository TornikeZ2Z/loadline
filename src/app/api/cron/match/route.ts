import { NextResponse } from "next/server";
import { handler, requireCronSecret } from "@/lib/api";
import { runMatchSweep } from "@/lib/notify/sweep";

/**
 * The match sweep, on a schedule. Point the scheduler here every few minutes,
 * alongside /api/cron/process and /api/cron/expire.
 *
 * A THIRD ROUTE AND NOT A STEP INSIDE THE OTHER TWO, which is SPEC 12.2's whole
 * argument: `/api/cron/process` drains `raw_messages`, so matching hung off it
 * would never fire for a truck or a job created through the FORM -- the most
 * likely shipping configuration on a board with no WhatsApp supply, and the one
 * where the bell renders a permanent zero as if it worked.
 *
 * It is also the isolation SPEC 12.2 asks for. "Its own transaction, so a
 * matching failure can never take down message processing or the expiry sweep"
 * is delivered here as its own REQUEST: a throw in this handler cannot reach
 * either of the others, which is stronger than a shared-connection transaction
 * would be -- and `src/lib/db.ts` serves production from a `pg.Pool`, where
 * BEGIN and COMMIT sent through `query()` may land on different connections.
 * Inside the sweep, each subject carries its own try/catch, so one bad truck
 * costs one truck.
 *
 * The response is counters, never a list: what ran, what was written, what was
 * held back and why. `capped` and `quieted` are printed rather than folded into
 * a total, because "12 subjects had news and 11 were inside the 12-hour cap" and
 * "1 subject had news" are different days.
 */
export const POST = handler(async (req: Request) => {
  requireCronSecret(req);
  const summary = await runMatchSweep();
  return NextResponse.json(summary);
});
