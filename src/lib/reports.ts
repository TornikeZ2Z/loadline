/**
 * "Report a problem": the vocabulary, and what we do to the free text.
 *
 * Client-safe on purpose -- no database, no `next/headers`, no node built-ins --
 * because the same three things are needed in three places: the public route
 * that accepts a report, the admin console that renders one, and the job-detail
 * trigger a client component will own. `src/lib/session.ts` is client-safe for
 * the same reason.
 *
 * Everything on the board is derived from a WhatsApp message by rules, so the
 * person best placed to notice a wrong ZIP is a driver reading it -- and
 * browsing needs no account, so most of them are not signed in. That is the
 * whole design constraint: this is untrusted input from a stranger, and it ends
 * up on an admin's screen.
 *
 * ---------------------------------------------------------------------------
 * THIS SUPERSEDES THE MAIL ROUTE IN src/lib/support.ts.
 *
 * That module says "There is no form and no endpoint on purpose. A form with
 * nowhere to post is worse than no form", and it was right when it was written:
 * the support mailbox was undecided, so every "Report a problem" link went to
 * /contact and a `[[SUPPORT EMAIL]]` placeholder. The CTO has now decided the
 * other way -- an in-app queue, no e-mail -- so the endpoint exists and the
 * destination is the admin's needs-attention queue.
 *
 * `support.ts` and its five callers (the footer, the More menu, /about,
 * /how-it-works, /cookies) still point at /contact. Someone has to reconcile
 * the two, and it is not a mechanical change: /contact also carries takedown
 * and removal requests, which are a legal path this queue is NOT, so the
 * mailbox link should survive for those even after the job-level report stops
 * using it.
 *
 * THE SEAM, for whoever owns the job detail:
 *
 *   POST /api/reports        (through `api()` from @/lib/basePath)
 *   body { loadId: number, reason: ReportReason, details?: string }
 *   201 { ok: true }   400 bad reason or id   404 no such job   429 slow down
 *
 * Everything a trigger needs is exported here: REPORT_REASONS for the choices,
 * REPORT_DETAILS_MAX for the counter, cleanReportDetails to preview what will
 * actually be stored. No session is required and none should be asked for.
 * ---------------------------------------------------------------------------
 */

/**
 * Why the reporter says the job is wrong.
 *
 * A closed list rather than free text as the primary field, because the reason
 * is what an admin triages on and free-text categories cannot be counted. It
 * is a TypeScript list rather than a database CHECK (see db/schema.sql) so this
 * can grow without a migration -- it will, as we learn what people report.
 *
 * The words are the ones a driver would use looking at a job card, not the
 * pipeline's: someone reporting a bad row does not know what an extraction rule
 * is, and "Wrong pickup or delivery" is a thing they can see.
 */
export const REPORT_REASONS = [
  { key: "wrong_place", label: "Wrong pickup or delivery" },
  { key: "wrong_size", label: "Wrong size or price" },
  { key: "wrong_date", label: "Wrong date" },
  { key: "gone", label: "Already taken, or no longer available" },
  { key: "wrong_contact", label: "Wrong contact" },
  { key: "duplicate", label: "The same job is on the board twice" },
  { key: "not_a_job", label: "Not a job at all" },
  { key: "other", label: "Something else" },
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number]["key"];

export function isReportReason(value: unknown): value is ReportReason {
  return typeof value === "string" && REPORT_REASONS.some((r) => r.key === value);
}

/**
 * The label for a reason, or the raw key when it is one we no longer offer.
 *
 * Falling back to the key rather than to "Other" or to nothing: a row written
 * under a vocabulary that has since changed still says what it said, and an
 * admin reading `wrong_zip` in the console learns something true. Quietly
 * relabelling it would be the kind of plausible-looking guess this product does
 * not make.
 */
export function reportReasonLabel(key: string): string {
  return REPORT_REASONS.find((r) => r.key === key)?.label ?? key;
}

export type ReportStatus = "open" | "resolved" | "dismissed";

/**
 * One queue row, exactly as `GET /api/admin/reports` answers with it.
 *
 * The job's own fields are nullable and that is not laziness: `load_id` is a
 * soft reference with no FK, so a report about a job that has since been
 * deleted still exists and the console has to say "job 42 is gone" rather than
 * invent a label for it.
 */
export interface ProblemReport {
  id: number;
  load_id: number;
  reason: string;
  details: string | null;
  status: ReportStatus;
  occurrences: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  /** NULL when the job behind this report no longer exists. */
  pickup_label: string | null;
  delivery_label: string | null;
  load_status: string | null;
  /** NULL when the reporter was not signed in, which is the common case. */
  reporter_name: string | null;
  reporter_email: string | null;
}

/** Free text is cut to this many characters. Also CHECKed in db/schema.sql. */
export const REPORT_DETAILS_MAX = 500;

/**
 * Make a stranger's free text safe to store and to render.
 *
 * React escapes text nodes, so this is not about HTML -- it is about the three
 * things escaping does not cover:
 *
 *   1. LENGTH. Uncapped text from an anonymous POST is a way to fill a database
 *      and to make one queue row unreadable. Cut at REPORT_DETAILS_MAX, hard.
 *   2. INVISIBLE CHARACTERS. C0/C1 controls, and the bidirectional overrides
 *      (U+202A-U+202E, U+2066-U+2069) and marks (U+200E/U+200F) that let a
 *      writer reverse how a line READS while leaving what it SAYS unchanged --
 *      the trick that makes one string look like another on screen. An admin
 *      deciding whether to delete a job should see the characters that are
 *      really there. Also U+200B/U+FEFF, which pad a string invisibly.
 *   3. SHAPE. Runs of blank lines that turn 40 characters into a screenful.
 *
 * Newlines and tabs survive -- somebody describing what is wrong with a job may
 * reasonably write two lines -- and nothing is rewritten beyond that. This
 * strips; it never substitutes. A report whose text was all controls comes back
 * null, which is the same as having said nothing.
 */
export function cleanReportDetails(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const stripped = raw
    // C0 except \t and \n, DEL, and the C1 block. CR is inside \x0B-\x1F, so a
    // CRLF paste is normalised here rather than needing its own pass.
    .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "")
    // Bidi controls and zero-width padding.
    .replace(/[\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    // Trailing spaces per line, then any run of 3+ newlines down to a blank line.
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Cut before trimming again, so a cut that lands mid-space does not leave one.
  const capped = stripped.slice(0, REPORT_DETAILS_MAX).trim();
  return capped.length > 0 ? capped : null;
}
