"use client";

/**
 * The board: the public home page, and the only primary view.
 *
 * There is no list/map toggle, because they are not alternatives -- the map
 * answers "who is going my way" and the list answers "is this one worth a
 * call", and a mover asks both in the same breath. So both are always mounted,
 * hover and selection are shared between them, and the job detail opens inside
 * the list column so the map never moves out from under the decision.
 *
 * This component owns the filter state, the URL (the URL *is* the saved
 * search), and the single fetch to `/api/loads`. It is a client component with
 * no server imports at all -- `Role` comes from `@/lib/session`, never from
 * `@/lib/auth`, so nothing drags the database driver into the browser bundle.
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Role } from "@/lib/session";
import type { BoundsInput, LoadSummary } from "@/lib/loads/types";
import type { PublicLoadRow, PublicSearchResult } from "@/lib/loads/publicView";
import { OPEN_LOCATION_EVENT, useViewerLocation } from "@/lib/location";
import { api } from "@/lib/basePath";
import { formatCf, truckLine } from "@/lib/loads/present";
import {
  clearedFilters,
  emptyStateSuggestions,
  emptyStateTitle,
  FilterBar,
  filtersToQuery,
  hydrate,
  isDefault,
  LIFECYCLE_NOTE,
  type Filters,
} from "./FilterBar";
import { JobList, partitionUnverified } from "./LoadViews";
import { LoadDetail } from "./LoadDetail";
import { BottomSheet, SNAP_FRACTION, type SheetSnap } from "./BottomSheet";
import { EmptyState } from "./ui";

// The map is client-only: MapLibre touches window at module scope, and a
// server render of it would buy nothing anyway.
const LoadMap = dynamic(() => import("./LoadMap").then((m) => m.LoadMap), { ssr: false });

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

const NUDGE_KEY = "loadline.locnudge";

/**
 * The list header until A's `summary` lands -- and permanently as the fallback,
 * since a partial or failed response should still say something true.
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
  return {
    count: rows.length,
    totalCf,
    withCf,
    readyNow,
    freshToday: 0,
    priced,
    medianPricePerCf: null,
  };
}

export function Board({ initialQuery, initialJobId, signedIn, role, userId, demoMode }: BoardProps) {
  const { current, home, hydrated } = useViewerLocation();
  const isAdmin = role === "admin";

  const [filters, setFilters] = useState<Filters>(() => hydrate(initialQuery));
  const [rows, setRows] = useState<PublicLoadRow[]>([]);
  const [summary, setSummary] = useState<LoadSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  const [selectedId, setSelectedId] = useState<number | null>(initialJobId ?? null);
  const [autoContact, setAutoContact] = useState(false);
  const [hoveredId, setHoveredId] = useState<number | null>(null);

  const [searchAsMove, setSearchAsMove] = useState(false);
  const [bounds, setBounds] = useState<BoundsInput | null>(null);

  const [mobile, setMobile] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [snap, setSnap] = useState<SheetSnap>("half");
  const [nudged, setNudged] = useState(false);

  const [notice, setNotice] = useState<string | null>(() =>
    new URLSearchParams(initialQuery).get("notice") === "poster-only"
      ? "Posting needs a poster account."
      : null,
  );

  const requestId = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const filterRow = useRef<HTMLDivElement>(null);
  const listScroller = useRef<HTMLDivElement>(null);

  // --- viewport ------------------------------------------------------------
  // Set after mount only: reading matchMedia during render would make the
  // server and the first client pass disagree.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const apply = () => {
      setMobile(mq.matches);
      setViewportHeight(window.innerHeight);
    };
    apply();
    mq.addEventListener("change", apply);
    window.addEventListener("resize", apply);
    return () => {
      mq.removeEventListener("change", apply);
      window.removeEventListener("resize", apply);
    };
  }, []);

  // The filter bar wraps to two rows on a tablet; the grid below has to know
  // how tall it actually ended up, so measure it rather than guess.
  useEffect(() => {
    const el = filterRow.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      root.current?.style.setProperty("--filters-h", `${Math.round(el.offsetHeight)}px`);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    try {
      setNudged(window.sessionStorage.getItem(NUDGE_KEY) === "1");
    } catch {
      // Private mode: the nudge simply shows again next visit.
    }
  }, []);

  // --- query ---------------------------------------------------------------
  const visibleQuery = useMemo(
    () => filtersToQuery(filters, { current: null, home: null }),
    [filters],
  );

  const fetchQuery = useMemo(() => {
    const q = filtersToQuery(filters, { current, home, bounds: searchAsMove ? bounds : null });
    return q ? `${q}&limit=500` : "limit=500";
  }, [filters, current, home, bounds, searchAsMove]);

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
      const received = data.rows ?? [];
      setRows(received);
      setSummary(data.summary ?? summarize(received));
      setTruncated(Boolean(data.applied?.truncated));
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
  // position: firing without it would sort the whole board twice on load.
  useEffect(() => {
    if (!hydrated) return;
    void search();
  }, [hydrated, search]);

  // --- URL -----------------------------------------------------------------
  // replaceState, not push: the filter bar is not browser history. The open
  // job is, in the sense that it is what a shared link points at, but pushing
  // an entry per keystroke of the search box would bury the back button.
  useEffect(() => {
    const path = selectedId != null ? `/jobs/${selectedId}` : "/";
    const url = visibleQuery ? `${path}?${visibleQuery}` : path;
    window.history.replaceState(null, "", api(url));
  }, [visibleQuery, selectedId]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  // --- selection -----------------------------------------------------------
  const openJob = useCallback((job: PublicLoadRow, opts?: { contact?: boolean }) => {
    setSelectedId(job.id);
    setAutoContact(Boolean(opts?.contact));
    if (window.matchMedia("(max-width: 767px)").matches) setSnap("half");
  }, []);

  const closeJob = useCallback(() => {
    setSelectedId(null);
    setAutoContact(false);
  }, []);

  const selectFromMap = useCallback(
    (id: number | null) => {
      if (id == null) {
        closeJob();
        return;
      }
      setSelectedId(id);
      setAutoContact(false);
      if (window.matchMedia("(max-width: 767px)").matches) setSnap("half");
    },
    [closeJob],
  );

  // Hovering a route brings its card into view -- but only while the list is
  // the thing on screen; scrolling a drawer the viewer is reading would be rude.
  const hover = useCallback(
    (id: number | null) => {
      setHoveredId(id);
      if (id == null || selectedId != null) return;
      listScroller.current
        ?.querySelector<HTMLElement>(`[data-job-card][data-job-id="${id}"]`)
        ?.scrollIntoView({ block: "nearest" });
    },
    [selectedId],
  );

  const onStateClick = useCallback((st: string) => {
    setFilters((f) =>
      f.pickupState.includes(st) ? f : { ...f, pickupState: [...f.pickupState, st] },
    );
  }, []);

  const dismissNudge = () => {
    setNudged(true);
    try {
      window.sessionStorage.setItem(NUDGE_KEY, "1");
    } catch {
      // ignore
    }
  };

  const ordered = useMemo(() => partitionUnverified(rows), [rows]);
  const shown = summary ?? summarize(rows);
  const now = useMemo(() => new Date(), [rows]);
  const selectedJob = ordered.find((j) => j.id === selectedId) ?? null;
  const suggestions = emptyStateSuggestions(filters);
  const showNudge = hydrated && !current && !nudged && !mobile;

  const header = (
    <div>
      <div className="big text-[var(--fs-lg)]">
        {shown.count} {shown.count === 1 ? "job" : "jobs"}
        {shown.totalCf > 0 && ` · ${formatCf(shown.totalCf)}`}
        {shown.totalCf > 0 && (
          <span className="font-normal" style={{ color: "var(--muted)" }}>
            {" "}
            {truckLine(shown.totalCf, current?.truckCf ?? null)}
          </span>
        )}
      </div>
      <div className="text-[var(--fs-sm)]" style={{ color: "var(--muted)" }}>
        {shown.readyNow} ready now · {shown.priced} priced
        {truncated && " · showing first 500"}
      </div>
    </div>
  );

  const listBody = (
    <>
      {notice && (
        <p
          className="mb-[var(--sp-2)] rounded-[var(--radius-sm)] px-[var(--sp-3)] py-[var(--sp-2)] text-[var(--fs-sm)]"
          style={{ background: "var(--warn-soft)", color: "var(--warn)" }}
        >
          {notice}
        </p>
      )}
      {error && (
        <p
          className="mb-[var(--sp-2)] rounded-[var(--radius-sm)] px-[var(--sp-3)] py-[var(--sp-2)] text-[var(--fs-sm)]"
          style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
        >
          {error}
        </p>
      )}

      {loading && rows.length === 0 ? (
        <p className="text-[var(--fs-sm)]" style={{ color: "var(--muted)" }}>
          Loading jobs…
        </p>
      ) : rows.length === 0 && !error ? (
        <EmptyState title={emptyStateTitle(filters)} hint={LIFECYCLE_NOTE}>
          {suggestions.map((s) => (
            <button key={s.label} type="button" className="btn btn-sm" onClick={() => setFilters(s.next)}>
              {s.label}
            </button>
          ))}
        </EmptyState>
      ) : (
        <JobList
          jobs={ordered}
          selectedId={selectedId}
          hoveredId={hoveredId}
          now={now}
          onSelect={openJob}
          onHover={hover}
        />
      )}
    </>
  );

  const detail =
    selectedId != null ? (
      <LoadDetail
        job={selectedJob}
        jobId={selectedId}
        totalInList={shown.count}
        signedIn={signedIn}
        demoMode={demoMode}
        role={role}
        userId={userId}
        viewer={current}
        autoContact={autoContact}
        mobile={mobile}
        onClose={closeJob}
        onStatusChanged={() => void search()}
      />
    ) : null;

  const map = (
    <div className="relative h-full w-full">
      <LoadMap
        jobs={ordered}
        selectedId={selectedId}
        hoveredId={hoveredId}
        onSelect={selectFromMap}
        onHover={setHoveredId}
        onStateClick={onStateClick}
        searchAsMove={searchAsMove}
        onSearchAsMoveChange={setSearchAsMove}
        onBoundsChange={setBounds}
        viewer={current}
        home={home}
        towardHome={filters.towardHome}
        fitKey={visibleQuery}
        bottomPadding={mobile ? Math.round(viewportHeight * SNAP_FRACTION[snap]) : 0}
        filteredSummary={summary}
      />

      {showNudge && (
        <div className="glass absolute bottom-[var(--sp-6)] left-1/2 w-[320px] -translate-x-1/2 p-[var(--sp-3)]">
          <div className="font-semibold">Where are you now?</div>
          <p className="mt-[2px] text-[var(--fs-sm)]" style={{ color: "var(--muted)" }}>
            Jobs sort by distance to the pickup, and cards show how far each one is.
          </p>
          <div className="mt-[var(--sp-2)] flex gap-[var(--sp-2)]">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent(OPEN_LOCATION_EVENT, { detail: { slot: "current" } }),
                )
              }
            >
              Set your location
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={dismissNudge}>
              Skip — just browse
            </button>
          </div>
        </div>
      )}

      {rows.length === 0 && !loading && !error && (
        <div className="glass absolute left-1/2 top-1/2 w-[320px] -translate-x-1/2 -translate-y-1/2 p-[var(--sp-4)] text-center">
          <div className="font-semibold">{emptyStateTitle(filters)}</div>
          <p className="mt-[var(--sp-1)] text-[var(--fs-sm)]" style={{ color: "var(--muted)" }}>
            {LIFECYCLE_NOTE}
          </p>
          {!isDefault(filters) && (
            <button
              type="button"
              className="btn btn-sm mt-[var(--sp-2)]"
              onClick={() => setFilters(clearedFilters(filters))}
            >
              Clear filters
            </button>
          )}
        </div>
      )}
    </div>
  );

  const filterBar = (
    <div
      ref={filterRow}
      className="flex items-center border-b border-border py-[var(--sp-2)]"
      style={{ background: "var(--surface)", minHeight: "var(--filters-h)" }}
    >
      <FilterBar
        filters={filters}
        onChange={setFilters}
        current={current}
        home={home}
        isAdmin={isAdmin}
        mobile={mobile}
      />
    </div>
  );

  if (mobile) {
    return (
      <div ref={root} className="board flex flex-col" style={{ height: "calc(100vh - var(--header-h))" }}>
        {filterBar}
        <div className="relative flex-1">
          <div style={{ height: "48vh" }}>{map}</div>
          <BottomSheet
            snap={snap}
            onSnapChange={setSnap}
            handle={<div className="w-full pt-[var(--sp-2)]">{header}</div>}
          >
            {detail ?? listBody}
          </BottomSheet>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={root}
      className="board flex flex-col"
      style={{ height: "calc(100vh - var(--header-h))" }}
    >
      {filterBar}

      <div
        className="grid min-h-0 flex-1"
        style={{ gridTemplateColumns: "minmax(560px, 1fr) var(--list-w)" }}
      >
        <section className="min-w-0 border-r border-border">{map}</section>

        <section className="flex min-h-0 flex-col" style={{ background: "var(--bg)" }}>
          {detail ? (
            detail
          ) : (
            <>
              <header className="border-b border-border px-[var(--sp-4)] py-[var(--sp-3)]">
                {header}
              </header>
              <div ref={listScroller} className="min-h-0 flex-1 overflow-y-auto p-[var(--sp-3)]">
                {listBody}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
