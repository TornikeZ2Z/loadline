"use client";

/**
 * The list behind /notifications.
 *
 * Every row is a digest, and every digest prints THE SAME STRINGS THE BOARD
 * PRINTS: the headline and band split come from `notify/copy.ts`, and the reason
 * lines under each spelled-out match are `reasons.ts`'s own clauses, carried
 * verbatim in the payload. A notification that described a match differently
 * from the page it links to would be untrusted twice -- once for the mismatch,
 * and once more for whichever of the two the reader decided was the lie.
 *
 * The rows arrive from the server already rendered once, so there is no spinner
 * and no empty flash. This component exists for exactly one interaction --
 * dismissal -- and it applies it optimistically, because the failure mode of an
 * optimistic dismiss (the row comes back on refresh) is milder than the failure
 * mode of a list that freezes for a round trip on every tap.
 */

import { useState } from "react";
import Link from "next/link";
import {
  NOTIFICATIONS_EMPTY,
  digestDetail,
  digestHeadline,
  itemHref,
  subjectHref,
} from "@/lib/notify/copy";
import type { NotificationRow } from "@/lib/notify/types";
import { Chip, EmptyState } from "./ui";

/** Two bands, and the words a driver acts on -- MatchPanel's own vocabulary. */
const TIER_LABEL = {
  strong: { label: "Worth a call", tone: "ok" as const },
  possible: { label: "Worth a look", tone: "default" as const },
};

/**
 * "Thu 11 Sep, 14:20" from a timestamp, in the reader's own browser.
 *
 * `listNotifications` hands over real ISO-8601 UTC; the space-separated form is
 * still handled because a raw `::text` timestamptz is what any future caller
 * would most plausibly pass, and printing a database string at a driver would
 * be a worse failure than printing the wrong hour.
 */
function when(iso: string): string {
  const d = new Date(/[TZ]/.test(iso) ? iso : `${iso.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function NotificationList({ initial }: { initial: NotificationRow[] }) {
  const [rows, setRows] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unread = rows.filter((r) => r.read_at == null);

  const dismiss = async (ids: number[] | null) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const stamp = new Date().toISOString();
    const before = rows;
    setRows((rs) =>
      rs.map((r) => (ids == null || ids.includes(r.id) ? { ...r, read_at: r.read_at ?? stamp } : r)),
    );
    try {
      const res = await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ids == null ? {} : { ids }),
      });
      if (!res.ok) {
        setRows(before);
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Could not dismiss (HTTP ${res.status})`);
      }
    } catch {
      setRows(before);
      setError("Could not reach the server. Nothing was dismissed.");
    } finally {
      setBusy(false);
    }
  };

  if (!rows.length) {
    return (
      <EmptyState title="No notifications" hint={NOTIFICATIONS_EMPTY}>
        <Link className="btn btn-primary" href="/post/truck">
          Post truck space
        </Link>
        <Link className="btn" href="/post/job">
          Post a job
        </Link>
      </EmptyState>
    );
  }

  return (
    <>
      <div className="mb-[var(--sp-3)] flex items-center justify-between gap-[var(--sp-2)]">
        <span className="text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
          {unread.length > 0 ? `${unread.length} unread` : "All read"}
        </span>
        {unread.length > 0 ? (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => dismiss(null)}>
            Dismiss all
          </button>
        ) : null}
      </div>

      {error ? (
        <p
          className="mb-[var(--sp-3)] rounded-[var(--radius-sm)] px-[var(--sp-3)] py-[var(--sp-2)] text-(length:--fs-base)"
          style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
        >
          {error}
        </p>
      ) : null}

      <ul className="flex flex-col gap-[var(--sp-3)]">
        {rows.map((row) => (
          <li
            key={row.id}
            className="card p-[var(--sp-4)]"
            data-notification-id={row.id}
            data-read={row.read_at != null || undefined}
            // Read rows stay in the list rather than disappearing: the record of
            // having been told is the useful part a day later, and a list that
            // empties as you read it cannot be re-read.
            style={row.read_at != null ? { opacity: 0.66 } : undefined}
          >
            {/* Stacked below `sm`, one row above it, and never `flex-wrap`.
                Wrapping put the timestamp and Dismiss inline on a card with a
                short second line and on its own line under a long one, so two
                rows of the same list disagreed about where their controls were.
                A breakpoint is a rule; wrapping is whatever the sentence
                happened to be. */}
            <div className="flex flex-col gap-[var(--sp-2)] sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <Link
                  href={subjectHref(row.subject_kind, row.subject_id)}
                  className="big text-(length:--fs-lg)"
                  style={{ color: "var(--text)" }}
                >
                  {digestHeadline(row.kind, row.payload)}
                </Link>
                <p className="mt-[var(--sp-1)] text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
                  {digestDetail(row.kind, row.payload)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-[var(--sp-2)]">
                <span className="text-(length:--fs-sm)" style={{ color: "var(--muted-2)" }}>
                  {when(row.created_at)}
                </span>
                {row.read_at == null ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={busy}
                    onClick={() => dismiss([row.id])}
                  >
                    Dismiss
                  </button>
                ) : null}
              </div>
            </div>

            {row.payload.top.length > 0 ? (
              <ul className="mt-[var(--sp-3)] border-t border-border">
                {row.payload.top.map((item) => {
                  const tier = TIER_LABEL[item.tier];
                  return (
                    <li key={item.id} className="border-b border-border py-[var(--sp-2)] last:border-b-0">
                      <Link
                        href={itemHref(row.kind, item.id)}
                        className="flex flex-col gap-[2px]"
                        style={{ color: "var(--text)" }}
                      >
                        <span className="flex items-center gap-[var(--sp-2)]">
                          <span className="font-semibold">{item.lane}</span>
                          <Chip tone={tier.tone}>{tier.label}</Chip>
                        </span>
                        {/* reasons.ts's own clauses, byte for byte. */}
                        <span className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
                          {item.reasons.join(" · ")}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : null}

            {row.payload.count > row.payload.top.length ? (
              <p className="mt-[var(--sp-2)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
                <Link href={subjectHref(row.subject_kind, row.subject_id)} className="underline">
                  {row.payload.count - row.payload.top.length} more on the listing
                </Link>
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}
