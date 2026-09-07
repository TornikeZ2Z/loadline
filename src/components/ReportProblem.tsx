"use client";

/**
 * "Report a problem", on one job.
 *
 * THE SEAM WAVE 2 LEFT OPEN. `POST /api/reports` and the admin queue behind it
 * landed with no trigger, because the endpoint's author did not own the job
 * detail; `src/lib/reports.ts` carries the contract this file implements. It is
 * its own component rather than another 90 lines inside `LoadDetail.tsx` for
 * the same reason `ContactGate` is: the detail is already the longest component
 * in the app, and this is a self-contained form with its own three states.
 *
 * NO SIGN-IN, deliberately, and it is the whole point of the feature. Every job
 * on this board is a rule's reading of a WhatsApp message, so the person most
 * likely to notice a wrong ZIP is a driver reading the board -- and browsing
 * never needs an account. Asking one here would collect corrections only from
 * people who already trusted the data enough to register. The endpoint carries
 * the abuse story instead (one row per job+reason, so a flood adds weight and
 * not rows); see the header of `src/app/api/reports/route.ts`.
 *
 * WHAT THIS IS NOT. `/contact` still holds takedown and removal requests -- "my
 * post should not be on your site" is a legal path with a person at the end of
 * it, and this queue is not that. Both answers to "report a problem" therefore
 * live on the site on purpose, and the one place a reader could confuse them is
 * right here, so the form says which is which and links the other one.
 *
 * HONESTY. The confirmation says a person will read it and does NOT say anyone
 * will reply, because nothing in this codebase sends mail. An error says which
 * error it was; a report that failed must never look like a report that landed.
 */

import Link from "next/link";
import { useId, useState } from "react";
import { api } from "@/lib/basePath";
import {
  REPORT_DETAILS_MAX,
  REPORT_REASONS,
  cleanReportDetails,
  type ReportReason,
} from "@/lib/reports";
import { REPORT_PROBLEM_HREF } from "@/lib/support";

type Phase = "closed" | "open" | "sending" | "sent";

export function ReportProblem({ loadId }: { loadId: number }) {
  const [phase, setPhase] = useState<Phase>("closed");
  const [reason, setReason] = useState<ReportReason | "">("");
  const [details, setDetails] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  const detailsId = useId();

  // What the server will actually keep, computed with the server's own
  // function: a counter that promised 500 and then stored 480 after the
  // stripping pass would be a small lie on a form about honesty.
  const willStore = cleanReportDetails(details);
  const storedLength = willStore?.length ?? 0;
  const overLong = details.trim().length > REPORT_DETAILS_MAX;

  async function send() {
    if (!reason) return;
    setPhase("sending");
    setError(null);
    try {
      const res = await fetch(api("/api/reports"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loadId, reason, details: details.trim() || undefined }),
      });
      if (res.ok) {
        setPhase("sent");
        return;
      }
      // The endpoint's own sentence where it has one -- it distinguishes a job
      // that is gone from a rate limit, and either is worth knowing.
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(
        body?.error ??
          (res.status === 429
            ? "Too many reports from here just now — try again in a minute."
            : "That did not send. Nothing was reported."),
      );
      setPhase("open");
    } catch {
      // Offline, or the request never left. Say so rather than showing the
      // thank-you: the report does not exist.
      setError("That did not send — check your connection. Nothing was reported.");
      setPhase("open");
    }
  }

  if (phase === "sent") {
    return (
      <section className="mt-[var(--sp-5)] border-t border-border pt-[var(--sp-4)]">
        <p
          className="rounded-[var(--radius-sm)] px-[var(--sp-3)] py-[var(--sp-2)] text-(length:--fs-base)"
          style={{ background: "var(--ok-soft)", color: "var(--ok)" }}
          role="status"
        >
          Thanks — this job is in the queue an admin reads. Nothing replies to you
          automatically, and the job stays on the board until someone checks it.
        </p>
      </section>
    );
  }

  if (phase === "closed") {
    return (
      <section className="mt-[var(--sp-5)] border-t border-border pt-[var(--sp-3)]">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ color: "var(--muted)" }}
          onClick={() => setPhase("open")}
        >
          Report a problem with this job
        </button>
      </section>
    );
  }

  return (
    <section className="mt-[var(--sp-5)] border-t border-border pt-[var(--sp-4)]">
      <div className="label">Report a problem</div>
      <p className="mb-[var(--sp-2)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
        This job was read out of a WhatsApp message by rules, so it can be wrong.
        Telling us goes to the admin queue — no account needed.
      </p>

      <label className="label" htmlFor={reasonId}>
        What is wrong
      </label>
      <select
        id={reasonId}
        className="field w-full"
        value={reason}
        onChange={(e) => setReason(e.target.value as ReportReason | "")}
      >
        <option value="">Choose a reason…</option>
        {REPORT_REASONS.map((r) => (
          <option key={r.key} value={r.key}>
            {r.label}
          </option>
        ))}
      </select>

      <label className="label mt-[var(--sp-3)]" htmlFor={detailsId}>
        Anything to add (optional)
      </label>
      <textarea
        id={detailsId}
        className="field w-full"
        rows={3}
        value={details}
        onChange={(e) => setDetails(e.target.value)}
        placeholder="e.g. the pickup is Newark, not Kearny"
      />
      {/* Counts what will be STORED, not what has been typed, and only once
          there is something to count. `overLong` is the honest half: text past
          the cap is cut rather than refused, so say it before Send, not after. */}
      {details.trim().length > 0 && (
        <p className="mt-[var(--sp-1)] text-(length:--fs-xs)" style={{ color: overLong ? "var(--warn)" : "var(--muted)" }}>
          {overLong
            ? `Only the first ${REPORT_DETAILS_MAX} characters are kept.`
            : `${storedLength} of ${REPORT_DETAILS_MAX} characters`}
        </p>
      )}

      {error && (
        <p
          className="mt-[var(--sp-2)] rounded-[var(--radius-sm)] px-[var(--sp-3)] py-[var(--sp-2)] text-(length:--fs-base)"
          style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
          role="alert"
        >
          {error}
        </p>
      )}

      <div className="mt-[var(--sp-3)] flex flex-wrap gap-[var(--sp-2)]">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!reason || phase === "sending"}
          onClick={send}
        >
          {phase === "sending" ? "Sending…" : "Send report"}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={phase === "sending"}
          onClick={() => {
            setPhase("closed");
            setError(null);
          }}
        >
          Cancel
        </button>
      </div>

      {/* The two paths, told apart at the one place a reader meets both. */}
      <p className="mt-[var(--sp-2)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
        Want a post taken down, or something removed about you? That is not this
        queue — <Link href={REPORT_PROBLEM_HREF} style={{ color: "var(--accent)" }}>contact us</Link>.
      </p>
    </section>
  );
}
