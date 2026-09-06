"use client";

/**
 * The board: the public home page, and the only primary view.
 *
 * It owns the filter state, the URL (the URL *is* the saved search), the
 * fetch to `/api/loads`, and the map/list grid. It is a client component with
 * no server imports at all -- `Role` comes from `@/lib/session`, never from
 * `@/lib/auth`, so nothing drags the database driver into the browser bundle.
 *
 * NOTE (Phase 1 handshake): `BoardProps` is final and is what B's `/` and
 * `/jobs/[id]` pages render against. The internals below are a deliberately
 * small working board -- it fetches and lists jobs so the page is real from the
 * first commit. The filter bar, the MapLibre route map, the cards and the
 * detail drawer are Agent C's next commits and replace everything under
 * `BoardProps`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Role } from "@/lib/session";
import type { LoadSummary } from "@/lib/loads/types";
import type { PublicLoadRow, PublicSearchResult } from "@/lib/loads/publicView";
import { useViewerLocation, viewerQuery } from "@/lib/location";
import { api } from "@/lib/basePath";
import {
  formatCf,
  formatPrice,
  freshnessLabel,
  laneLabel,
  placeLabel,
  readyLabel,
  senderLine,
  truckLine,
} from "@/lib/loads/present";

export interface BoardProps {
  /** URLSearchParams string from the page; may carry notice=poster-only. */
  initialQuery: string;
  /** /jobs/[id] -> opens the detail drawer on that job. */
  initialJobId?: number | null;
  signedIn: boolean;
  /** isAdmin = role === "admin"; per job canManageJob = admin || (poster && posted_by === userId). */
  role: Role | null;
  /** Ownership test for the poster's status buttons. */
  userId: number | null;
  /** demoModeEnabled(): one-click demo driver inside the contact gate. */
  demoMode: boolean;
}

/**
 * The list header summary until A's `summary` lands -- and permanently as the
 * fallback, since a failed or partial response should still say something true.
 */
function summarize(rows: PublicLoadRow[]): LoadSummary {
  const today = new Date().toISOString().slice(0, 10);
  let totalCf = 0;
  let withCf = 0;
  let readyNow = 0;
  let priced = 0;
  for (const r of rows) {
    if (r.cubic_feet != null) {
      totalCf += r.cubic_feet;
      withCf += 1;
    }
    if (r.ready_now || (r.ready_date != null && r.ready_date <= today)) readyNow += 1;
    if (r.price_per_cf != null || r.price_flat != null) priced += 1;
  }
  return { count: rows.length, totalCf, withCf, readyNow, freshToday: 0, priced, medianPricePerCf: null };
}

export function Board(props: BoardProps) {
  // signedIn, role, userId and demoMode are read by the detail drawer and the
  // contact gate, which arrive with Agent C's LoadDetail commit.
  const { initialQuery, initialJobId } = props;
  const { current, hydrated } = useViewerLocation();

  // `notice=poster-only` is set by B's /post redirect: shown once, then gone
  // from the URL so a reload or a shared link does not repeat it.
  const [notice, setNotice] = useState<string | null>(() =>
    new URLSearchParams(initialQuery).get("notice") === "poster-only"
      ? "Posting needs a poster account."
      : null,
  );

  const [rows, setRows] = useState<PublicLoadRow[]>([]);
  const [summary, setSummary] = useState<LoadSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(initialJobId ?? null);
  const requestId = useRef(0);

  /** What the address bar shows: never the viewer's coordinates. */
  const visibleQuery = useMemo(() => {
    const sp = new URLSearchParams(initialQuery);
    sp.delete("notice");
    sp.delete("viewerLat");
    sp.delete("viewerLng");
    return sp.toString();
  }, [initialQuery]);

  /** What the API is asked: the visible query plus the viewer position. */
  const fetchQuery = useMemo(() => {
    const sp = new URLSearchParams(visibleQuery);
    sp.set("limit", "500");
    const viewer = viewerQuery(current);
    return viewer ? `${sp.toString()}&${viewer}` : sp.toString();
  }, [visibleQuery, current]);

  const search = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(api(`/api/loads?${fetchQuery}`));
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Could not load the board");
      const data = body as PublicSearchResult;
      if (id !== requestId.current) return; // a newer request already answered
      setRows(data.rows ?? []);
      setSummary(data.summary ?? summarize(data.rows ?? []));
    } catch (err) {
      if (id !== requestId.current) return;
      setRows([]);
      setSummary(null);
      setError(err instanceof Error ? err.message : "Could not load the board");
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [fetchQuery]);

  // Wait for hydration so the first request already carries the stored
  // position: firing without it would sort the board twice on every load.
  useEffect(() => {
    if (!hydrated) return;
    void search();
  }, [hydrated, search]);

  useEffect(() => {
    if (!notice) return;
    // Strip the one-shot flag from the address bar. history.replaceState needs
    // the base path applied by hand -- Next only rewrites Link and router URLs.
    window.history.replaceState(null, "", api(visibleQuery ? `/?${visibleQuery}` : "/"));
  }, [notice, visibleQuery]);

  const shown = summary ?? summarize(rows);
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date();

  // The page itself never scrolls: the root below is exactly the viewport minus
  // the header, and each column owns its own overflow. It regains
  // `- var(--filters-h)` once C's FilterBar is mounted above it.
  return (
    <div
      className="board grid"
      style={{
        height: "calc(100vh - var(--header-h))",
        gridTemplateColumns: "minmax(0, 1fr) var(--list-w)",
      }}
    >
      {/* Agent C's LoadMap takes this column next. */}
      <section
        className="grid place-items-center border-r border-border"
        style={{ background: "var(--surface-2)", color: "var(--muted)" }}
      >
        <p className="text-[var(--fs-sm)]">Route map</p>
      </section>

      <section className="flex min-h-0 flex-col" style={{ background: "var(--bg)" }}>
        <header className="border-b border-border px-[var(--sp-4)] py-[var(--sp-3)]">
          <div className="big text-[var(--fs-lg)]">
            {shown.count} {shown.count === 1 ? "job" : "jobs"}
            {shown.totalCf > 0 && ` · ${formatCf(shown.totalCf)}`}
          </div>
          <div className="text-[var(--fs-sm)]" style={{ color: "var(--muted)" }}>
            {shown.totalCf > 0 && `${truckLine(shown.totalCf, current?.truckCf ?? null)} · `}
            {shown.readyNow} ready now · {shown.priced} priced
          </div>
        </header>

        {notice && (
          <p
            className="border-b border-border px-[var(--sp-4)] py-[var(--sp-2)] text-[var(--fs-sm)]"
            style={{ background: "var(--warn-soft)", color: "var(--warn)" }}
          >
            {notice}{" "}
            <button type="button" className="underline" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </p>
        )}

        {error && (
          <p
            className="border-b border-border px-[var(--sp-4)] py-[var(--sp-2)] text-[var(--fs-sm)]"
            style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
          >
            {error}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-[var(--sp-3)]">
          {loading && rows.length === 0 ? (
            <p className="text-[var(--fs-sm)]" style={{ color: "var(--muted)" }}>
              Loading jobs…
            </p>
          ) : rows.length === 0 && !error ? (
            <p className="text-[var(--fs-sm)]" style={{ color: "var(--muted)" }}>
              No jobs match this search.
            </p>
          ) : (
            <ul className="flex flex-col gap-[var(--sp-2)]">
              {rows.map((job) => {
                const price = formatPrice(job);
                const ready = readyLabel(job, today);
                const fresh = freshnessLabel(job, now);
                const from = placeLabel(job, "pickup");
                const to = placeLabel(job, "delivery");
                return (
                  <li key={job.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(job.id)}
                      className={`card card-hover w-full p-[var(--sp-3)] text-left${
                        selectedId === job.id ? " card-selected" : ""
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-[var(--sp-2)]">
                        <span className="text-[var(--fs-xs)] font-semibold" style={{ color: "var(--muted)" }}>
                          {laneLabel(job)}
                        </span>
                        <span className="nums text-[var(--fs-sm)] font-semibold">{price.headline}</span>
                      </div>
                      <div className="mt-1 text-[var(--fs-md)] font-semibold">
                        {from.text} → {to.text}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-[var(--sp-2)] text-[var(--fs-sm)]" style={{ color: "var(--muted)" }}>
                        <span>{job.cubic_feet != null ? formatCf(job.cubic_feet) : "Size not stated"}</span>
                        <span>{ready.text}</span>
                        <span>{fresh.text}</span>
                        <span>{senderLine(job)}</span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
