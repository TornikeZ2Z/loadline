/**
 * The route to a human, in one place.
 *
 * WHAT THIS IS FOR. Every surface that should offer "something here is wrong"
 * -- the footer, the header's More menu, the note at the end of /about and
 * /how-it-works, and (when its owner wires it up) the job detail -- links here
 * rather than each inventing its own wording and its own target.
 *
 * WHAT IS DELIBERATELY NOT HERE: the support mailbox itself. That is an
 * undecided business fact, and /contact renders it as the `[[SUPPORT EMAIL]]`
 * placeholder it has always been. This module is the ROUTE to that address, not
 * the address -- so when the mailbox is decided, exactly one rendered string on
 * /contact changes and every link below already points at it.
 *
 * There is no form and no endpoint on purpose. A form with nowhere to post is
 * worse than no form: it looks like the problem was reported.
 *
 * THE CONTRACT, for whoever adds the button to the job detail:
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
