/**
 * The route to a human, in one place.
 *
 * WHAT THIS IS FOR. Every surface that should offer "something here is wrong"
 * -- the footer, the header's More menu, the note at the end of /about and
 * /how-it-works, and /cookies -- links here rather than each inventing its own
 * wording and its own target.
 *
 * WHAT IS DELIBERATELY NOT HERE: the support mailbox itself. This module is the
 * ROUTE to that address, not the address -- it comes out of the settings store
 * (`support_email` in src/lib/settings.ts) and renders on /contact as the
 * `[[SUPPORT EMAIL]]` token until an admin fills it in.
 *
 * THIS IS NOW ONE OF TWO ANSWERS TO "REPORT A PROBLEM", AND THAT IS ON PURPOSE.
 *
 * This module used to say there was no form and no endpoint on purpose, because
 * a form with nowhere to post looks like the problem was reported. That was
 * true when it was written and is not any more: `POST /api/reports` exists, and
 * a per-job report lands in the admin's needs-attention queue (see
 * src/lib/reports.ts and src/components/ReportProblem.tsx).
 *
 * The split is by WHAT is being reported, not by who is asking:
 *
 *   this job is wrong  -> the in-app queue, on the job detail. A machine read a
 *                         WhatsApp message and got a ZIP wrong; a rule fixes it.
 *   everything else    -> here, to a person. Takedown and removal requests in
 *                         particular: "my post should not be on your site" is a
 *                         legal path with a human at the end of it, and the
 *                         queue is not that.
 *
 * So the five links below -- the footer, the header's More menu, /about,
 * /how-it-works, /cookies -- keep pointing at /contact, because none of them is
 * standing on a particular job. `reportProblemHref(jobPath)` survives for a
 * surface that has a job in hand and still wants the mailbox rather than the
 * queue; the job detail itself does not use it.
 *
 * THE CONTRACT:
 *
 *   import { reportProblemHref } from "@/lib/support";
 *   <Link href={reportProblemHref(`/jobs/${load.id}`)}>Report a problem</Link>
 *
 * The `?about=` value is echoed back on /contact so the reporter can see -- and
 * copy -- exactly which job they are writing about. /contact accepts it only
 * when it is a job path this site could have produced, and ignores anything
 * else; it is a query parameter, which means it is attacker-controlled, and it
 * is rendered as text next to a "report a problem" heading.
 */

/** The anchor on /contact. Every "report a problem" link lands on this heading. */
export const REPORT_SECTION_ID = "report";

/** The query parameter carrying the job a report is about. */
export const REPORT_ABOUT_PARAM = "about";

/** The plain link, for a surface that has no particular job in hand. */
export const REPORT_PROBLEM_HREF = `/contact#${REPORT_SECTION_ID}`;

/**
 * The only shape /contact will echo back: a job path on this site.
 *
 * Anything else -- an absolute URL, a path with a query on it, a sentence -- is
 * dropped rather than printed, so this parameter can never be used to put
 * arbitrary text on a page that a reader is trusting.
 */
const JOB_PATH = /^\/jobs\/[0-9]{1,12}$/;

/** True if `value` is a job path this site could have produced. */
export function isReportableJobPath(value: unknown): value is string {
  return typeof value === "string" && JOB_PATH.test(value);
}

/**
 * "Report a problem", carrying the job it is about.
 *
 * `about` is dropped unless it is a job path, so a caller cannot accidentally
 * widen what /contact will render by passing something else.
 */
export function reportProblemHref(about?: string | null): string {
  if (!isReportableJobPath(about)) return REPORT_PROBLEM_HREF;
  return `/contact?${REPORT_ABOUT_PARAM}=${encodeURIComponent(about)}#${REPORT_SECTION_ID}`;
}
