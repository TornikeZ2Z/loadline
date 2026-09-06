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
import { boardDay, formatCf, truckLine } from "@/lib/loads/present";
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
import { JobList, JobListSkeleton, partitionUnverified } from "./LoadViews";
import { LoadDetail } from "./LoadDetail";
import { BottomSheet, snapHeightPx, type SheetSnap } from "./BottomSheet";
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
  const today = boardDay(new Date());
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
  /**
   * A marker holding several jobs was clicked. It narrows the LIST to that
   * place -- not the search and not the map, which keep their context, because
   * "what is at this warehouse" is a question about the list in front of you.
   */
  const [place, setPlace] = useState<{ ids: number[]; label: string } | null>(null);

  const [mobile, setMobile] = useState(false);
  /**
   * Too short to spend two rows on a filter bar. A phone lying down is 844 x
   * 390: wide enough for the two-column board, which is the right shape there,
   * and the full bar was taking 119 of those 390 px on two wrapped rows.
   */
  const [shortScreen, setShortScreen] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(0);
  /** Header + filter bar: the strip the bottom sheet must never cover. */
  const [topInset, setTopInset] = useState(0);
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
    const short = window.matchMedia("(max-height: 540px)");
    const apply = () => {
      setMobile(mq.matches);
      setShortScreen(short.matches);
      setViewportHeight(window.innerHeight);
      // The header changes height at 768 without the filter row resizing, so
      // the ResizeObserver below would not hear about it.
      const bar = filterRow.current;
      if (bar) setTopInset(Math.round(bar.getBoundingClientRect().bottom));
    };
    apply();
    mq.addEventListener("change", apply);
    short.addEventListener("change", apply);
    window.addEventListener("resize", apply);
    // A `resize` event is not the only way the viewport changes shape, and it
    // is not always the first: a phone collapsing its URL bar, and the layout
    // viewport shrinking for the on-screen keyboard, both move this number.
    // Observing the initial containing block catches every case, and catches it
    // after layout rather than before.
    const ro =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    ro?.observe(document.documentElement);
    return () => {
      mq.removeEventListener("change", apply);
      short.removeEventListener("change", apply);
      window.removeEventListener("resize", apply);
      ro?.disconnect();
    };
  }, []);

  // The filter bar wraps to two rows on a tablet, so how far down the screen it
  // ends is a measurement, not a constant -- and that bottom edge is the ceiling
  // the bottom sheet must stop at.
  //
  // What used to be here wrote the measured height back into `--filters-h`,
  // which is the same element's own `min-height`. A variable that is set from
  // the height it controls can only ratchet upwards: once anything made the row
  // briefly taller -- a control growing to its touch size on the first
  // paint -- the floor rose to match and never came down. It stuck at 171 px on
  // a phone, three times the row it was measuring. `--filters-h` is now purely
  // the token floor it was declared as, and nothing writes to it.
  useEffect(() => {
    const el = filterRow.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setTopInset(Math.round(el.getBoundingClientRect().bottom));
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
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

  // The pill counts whichever end the map is plotting, so it has to filter the
  // matching end: clicking "FL · 9 jobs" over Florida deliveries and getting
  // Florida pickups would be a different search than the one shown.
  const onStateClick = useCallback((st: string) => {
    setFilters((f) => {
      const key = f.mapEnd === "pickup" ? "pickupState" : "deliveryState";
      return f[key].includes(st) ? f : { ...f, [key]: [...f[key], st] };
    });
  }, []);

  const onGroupClick = useCallback((ids: number[], label: string) => {
    setPlace({ ids, label });
  }, []);

  const dismissNudge = () => {
    setNudged(true);
    try {
      window.sessionStorage.setItem(NUDGE_KEY, "1");
    } catch {
      // ignore
    }
  };

  // A new search is a new set of places, so a pinned one cannot survive it.
  useEffect(() => {
    setPlace(null);
  }, [visibleQuery]);

  const ordered = useMemo(() => partitionUnverified(rows), [rows]);
  // The map always draws the whole result; only the list narrows to one place,
  // so the surrounding inventory stays visible while you read what is at it.
  const listed = useMemo(
    () => (place ? ordered.filter((j) => place.ids.includes(j.id)) : ordered),
    [ordered, place],
  );
  const shown = place ? summarize(listed) : (summary ?? summarize(rows));
  const now = useMemo(() => new Date(), [rows]);
  const selectedJob = ordered.find((j) => j.id === selectedId) ?? null;
  const suggestions = emptyStateSuggestions(filters);
  const showNudge = hydrated && !current && !nudged && !mobile;

  /**
   * The list's head, and the board's visual entry point: the one place that
   * says how much freight is on screen before you read a single card. The
   * count and the cubic feet carry the weight; the truckload equivalent and
   * the ready/priced tally are the footnote to it, on one quiet line.
   */
  const firstLoad = loading && summary == null && rows.length === 0;

  const header = firstLoad ? (
    // "0 jobs · 0 ready now · 0 priced" is a confident answer to a question
    // nobody has answered yet, and it is the wrong one often enough to matter.
    <div aria-hidden="true">
      <span className="skeleton h-[20px] w-[150px]" />
      <span className="skeleton mt-[5px] h-[12px] w-[210px]" />
    </div>
  ) : (
    <div>
      <div className="big nums text-(length:--fs-xl)">
        {shown.count} {shown.count === 1 ? "job" : "jobs"}
        {shown.totalCf > 0 && (
          <>
            <span style={{ color: "var(--border-strong)" }}>{" · "}</span>
            {formatCf(shown.totalCf)}
          </>
        )}
      </div>
      <div className="mt-[1px] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
        {shown.totalCf > 0 && `${truckLine(shown.totalCf, current?.truckCf ?? null)} · `}
        {shown.readyNow} ready now · {shown.priced} priced
        {truncated && " · showing first 500"}
      </div>
    </div>
  );

  const listBody = (
    <>
      {place && (
        <div className="mb-[var(--sp-2)] flex items-center gap-[var(--sp-2)]">
          <button
            type="button"
            className="chip chip-accent"
            style={{ cursor: "pointer" }}
            title="Show every job in this search again"
            onClick={() => setPlace(null)}
          >
            {place.label} · {place.ids.length} job{place.ids.length === 1 ? "" : "s"}
            <span aria-hidden>✕</span>
          </button>
          <span className="text-(length:--fs-xs)" style={{ color: "var(--muted)" }}>
            of {(summary ?? summarize(rows)).count} on the map
          </span>
        </div>
      )}
      {notice && (
        <p
          className="mb-[var(--sp-2)] rounded-[var(--radius-sm)] px-[var(--sp-3)] py-[var(--sp-2)] text-(length:--fs-sm)"
          style={{ background: "var(--warn-soft)", color: "var(--warn)" }}
        >
          {notice}
        </p>
      )}
      {error && (
        <p
          className="mb-[var(--sp-2)] rounded-[var(--radius-sm)] px-[var(--sp-3)] py-[var(--sp-2)] text-(length:--fs-sm)"
          style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
        >
          {error}
        </p>
      )}

      {loading && rows.length === 0 ? (
        <>
          <p className="sr-only" role="status">
            Loading jobs…
          </p>
          <JobListSkeleton />
        </>
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
          jobs={listed}
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
        end={filters.mapEnd}
        selectedId={selectedId}
        hoveredId={hoveredId}
        onSelect={selectFromMap}
        onHover={setHoveredId}
        onStateClick={onStateClick}
        onGroupClick={onGroupClick}
        searchAsMove={searchAsMove}
        onSearchAsMoveChange={setSearchAsMove}
        onBoundsChange={setBounds}
        viewer={current}
        home={home}
        towardHome={filters.towardHome}
        fitKey={visibleQuery}
        /* How much of the map the sheet is covering right now: the map frames
           the jobs into what is left, and lifts its own legend and MapLibre's
           attribution above it. It re-frames when this changes -- once per
           snap, never mid-drag, and never after the viewer has panned the map
           themselves. */
        bottomPadding={mobile ? snapHeightPx(viewportHeight, snap, topInset) : 0}
        filteredSummary={summary}
        loading={firstLoad}
      />

      {showNudge && (
        <div className="glass absolute bottom-[var(--sp-6)] left-1/2 w-[320px] -translate-x-1/2 p-[var(--sp-3)]">
          <div className="font-semibold">Where are you now?</div>
          <p className="mt-[2px] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
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

      {/* The list beside this already carries the full empty state -- headline,
          the lifecycle note and a way forward. Printing all three again over
          the map would be the same paragraph twice on one screen, so this says
          only what the MAP needs to say (there is nothing here to plot) and
          offers the one action the list does not. */}
      {rows.length === 0 && !loading && !error && (
        <div className="glass absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 px-[var(--sp-4)] py-[var(--sp-3)] text-center">
          <div className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
            Nothing to plot for this search.
          </div>
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
        compact={mobile || shortScreen}
      />
    </div>
  );

  if (mobile) {
    return (
      <div ref={root} className="board flex flex-col" style={{ height: "100%" }}>
        {filterBar}
        {/* The map fills everything under the filter bar and the sheet floats
            over it. It used to be a 48vh box with the sheet fixed to the bottom
            of the window, which left 174 px of empty page between them at the
            peek snap -- exactly the snap whose whole point is "get the list out
            of the way and show me the map". `bottomPadding` already told the
            map how much of itself the sheet covers, so nothing had to be
            invented to make this work. */}
        <div className="relative min-h-0 flex-1">
          {map}
          <BottomSheet
            snap={snap}
            onSnapChange={setSnap}
            topInset={topInset}
            padded={detail == null}
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
      style={{ height: "100%" }}
    >
      {filterBar}

      {/* `minmax(0, 1fr)`, not `minmax(560px, 1fr)`. A phone held sideways is
          844 px wide -- past the 768 breakpoint, so it gets this layout -- and
          560 + 340 is 900. The two tracks overflowed by 56 px, `.board`'s
          `overflow: hidden` clipped the difference, and what got clipped was
          the right edge of the list column: every card's Show contact button,
          which is `ml-auto` against exactly that edge. A floor the container
          cannot honour is not a floor, it is a clipped column. */}
      <div
        className="grid min-h-0 flex-1"
        style={{ gridTemplateColumns: "minmax(0, 1fr) var(--list-w)" }}
      >
        <section className="min-w-0 border-r border-border">{map}</section>

        <section className="flex min-h-0 flex-col" style={{ background: "var(--bg)" }}>
          {detail ? (
            detail
          ) : (
            <>
              {/* On --surface, not the tray's --bg: the list gets a head the
                  way the map has its panel, and the cards below then sit in a
                  recess rather than floating on the same plane as their own
                  title. */}
              <header
                className="border-b border-border px-[var(--sp-4)] py-[var(--sp-3)]"
                style={{ background: "var(--surface)" }}
              >
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
