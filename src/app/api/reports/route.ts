import { NextResponse } from "next/server";
import { badRequest, handler, jobIdFrom, notFound, rateLimit } from "@/lib/api";
import { getCurrentUser, isAdminActor } from "@/lib/auth";
import { queryOne } from "@/lib/db";
import { isLoadVisible } from "@/lib/loads/query";
import { cleanReportDetails, isReportReason } from "@/lib/reports";

/**
 * "This job is wrong." From anybody, signed in or not.
 *
 * PUBLIC ON PURPOSE, and that is the interesting decision. Every job on the
 * board was derived from a WhatsApp message by rules, so the person most likely
 * to spot a wrong ZIP or a job that went months ago is a driver reading the
 * board -- and browsing needs no account, so most of them are not signed in.
 * Putting a sign-in in front of the correction would collect reports only from
 * people who already trust the data enough to have registered, which is exactly
 * the wrong sample. So: no gate, and the abuse story has to carry the weight
 * instead.
 *
 * THE ABUSE STORY, in the order the defences actually bite:
 *
 *  1. The queue CANNOT be flooded, because a report is not a row. The table is
 *     UNIQUE (load_id, reason), so a thousand POSTs about job 42 raise one row's
 *     `occurrences` to a thousand. The most rows this table can ever hold is
 *     the corpus times eight reasons -- bounded by our data, not by their
 *     traffic. This is the defence that holds when the other two do not.
 *  2. The job must exist. An id that is not a job 404s, so the table cannot be
 *     seeded with ids pointing at nothing, and every queue row an admin opens
 *     has a job behind it.
 *  3. The rate limit, which is the WEAKEST of the three and worth being honest
 *     about: `rateLimit` is per-IP in memory, and `clientIp` returns the
 *     constant "local" unless TRUST_PROXY=1 -- which is not set on the live
 *     task. So in production today this is one shared bucket for the whole
 *     site: it caps total write volume (the point, next to a synchronous
 *     database write) but one abuser can spend everybody's budget. It is a
 *     speed bump, and defence 1 is why that is survivable.
 *
 * An already-dismissed report is NOT reopened by a new POST -- see below. The
 * free text is cleaned by `cleanReportDetails` before it goes anywhere near the
 * database, and the reason must be one we offer.
 */
export const POST = handler(async (req: Request) => {
  // 20/min. Higher than /register's 10 because a person filing reports on a
  // board they are reading may honestly file several in a minute, and a report
  // creates far less than an account does -- often no row at all.
  rateLimit(req, "reports", 20);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // Accepts a number or the string a form sends; anything else is not an id.
  const loadId = jobIdFrom(String(body.loadId ?? ""));
  if (loadId === null) badRequest("loadId: a job id is required");

  const reason = body.reason;
  if (!isReportReason(reason)) badRequest("reason: not one of the reasons we offer");

  const details = cleanReportDetails(body.details);

  // Signed in when they happen to be; nothing asks them to be. Read before the
  // job is looked up, because who is asking is part of whether the job exists.
  const user = await getCurrentUser();

  // Reporting a job that is not there is a typo or a probe, not a report.
  // "Not there" is asked FOR THIS CALLER: `isLoadVisible` applies the same
  // predicate the board does, so a listing posted from a demo account answers
  // the same 404 to everyone but the account that posted it. Without that, this
  // route would be an existence oracle over demo listings and a way to put a
  // report about an invisible job into a real admin's queue. It reads nothing
  // but whether a row matched -- no phone, no sender, and the response below
  // carries none of it either way.
  const visible = await isLoadVisible(loadId, {
    userId: user?.id ?? null,
    includeDemo: !!user && isAdminActor(user),
  });
  if (!visible) notFound("That job is not on the board");

  await queryOne(
    // ON CONFLICT is where the design lives, so read the SETs one at a time:
    //
    //   occurrences   -- weight. Ten people saying it is stronger evidence than
    //                    one, and it is what the admin sorts on.
    //   last_seen_at  -- when it was last complained about.
    //   details       -- COALESCE keeps the FIRST note given. A later reporter
    //                    adds weight, never prose: otherwise anyone could
    //                    rewrite the note under an existing report, which is a
    //                    cheaper way to put text in front of an admin than
    //                    filing a new one.
    //   status        -- 'resolved' goes back to 'open': an admin fixed it and
    //                    it is being reported again, which is exactly the thing
    //                    they need to know. 'dismissed' STAYS dismissed. An
    //                    admin who has looked at this and said "no, the job is
    //                    right" must not be overruled by one more anonymous
    //                    click, or dismissing anything would be pointless.
    //   reported_by   -- unchanged. It records who filed it first.
    `INSERT INTO problem_reports (load_id, reason, details, reported_by)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (load_id, reason) DO UPDATE
       SET occurrences  = problem_reports.occurrences + 1,
           last_seen_at = now(),
           details      = COALESCE(problem_reports.details, EXCLUDED.details),
           status       = CASE WHEN problem_reports.status = 'resolved'
                               THEN 'open' ELSE problem_reports.status END
     RETURNING id`,
    [loadId, reason, details, user?.id ?? null],
  );

  // Deliberately says nothing about the row: not its id, not its occurrence
  // count, not whether this reason was already reported. An anonymous caller
  // has no use for any of it, and every one of them would tell a prober what is
  // already in a queue they cannot read.
  return NextResponse.json({ ok: true }, { status: 201 });
});
