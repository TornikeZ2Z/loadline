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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Role } from "@/lib/session";
import type { BoundsInput, LoadSummary } from "@/lib/loads/types";
import type { TruckSummary } from "@/lib/loads/truckTypes";
import type {
  PublicLoadRow,
  PublicSearchResult,
  PublicTruckRow,
  PublicTruckSearchResult,
} from "@/lib/loads/publicView";
import { OPEN_LOCATION_EVENT, useViewerLocation } from "@/lib/location";
import { api } from "@/lib/basePath";
import { boardDay, formatCf, formatRate, truckLine } from "@/lib/loads/present";
import { boardHeadline, summarizeTrucks, truckSubline } from "@/lib/loads/truckPresent";
import { truckFilterNotes, truckFiltersToQuery } from "./truckFilters";
import {
  clearedFilters,
  emptyStateSuggestions,
  emptyStateTitle,
  FilterBar,
  filterConflict,
  filtersToQuery,
  hydrate,
  isDefault,
  isTowardHome,
  LIFECYCLE_NOTE,
  RouteStrip,
  type CorridorStats,
  type Filters,
} from "./FilterBar";
import { JobList, JobListSkeleton, partitionUnverified } from "./LoadViews";
import { TruckList, TruckListSkeleton } from "./TruckViews";
import { LoadDetail } from "./LoadDetail";
import { TruckDetail } from "./TruckDetail";
import { BottomSheet, snapHeightPx, type SheetSnap } from "./BottomSheet";
import { MapBoundary } from "./MapBoundary";
import { EmptyState } from "./ui";

// The map is client-only: MapLibre touches window at module scope, and a
// server render of it would buy nothing anyway.
const LoadMap = dynamic(() => import("./LoadMap").then((m) => m.LoadMap), { ssr: false });

export interface BoardProps {
  /** URLSearchParams string from the page; may carry notice=poster-only. */
  initialQuery: string;
  /** /jobs/[id] -> opens the detail drawer on that job. */
  initialJobId?: number | null;
  /** /trucks/[id] -> opens the Trucks tab with that truck's drawer open. */
  initialTruckId?: number | null;
  signedIn: boolean;
  /** isAdmin = role === "admin"; per job canManageJob = admin || (poster && posted_by === userId). */
  role: Role | null;
  /** Ownership test for the poster's status buttons. */
  userId: number | null;
  /** demoModeEnabled(): one-click demo driver inside the contact gate. */
  demoMode: boolean;
}

const NUDGE_KEY = "loadline.locnudge";
/** V01: the desktop board's two view modes, and the divider the viewer moved. */
const VIEW_KEY = "loadline.boardview";
const LIST_W_KEY = "loadline.listw";

/** Map + list, or the list on its own. There is no map-only desktop view. */
type BoardView = "split" | "list";

/**
 * `useLayoutEffect` on the client, `useEffect` on the server.
 *
 * Restoring the list's scroll position has to happen BEFORE paint or the
 * viewer sees the top of the board for a frame and then a jump. React logs a
 * warning for `useLayoutEffect` during a server render, and this component is
 * server-rendered even though it is a client component, so the choice is made
 * once at module scope where it is a constant rather than a conditional hook.
 */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * How wide the results panel starts, before anybody drags it.
 *
 * The review measured the live board at 2560 x 1271 and found the map taking
 * roughly five sixths of it with the cards -- the thing a dispatcher actually
 * reads -- confined to a 420 px rail. So above 1280 the panel is a FRACTION of
 * the board rather than a constant: 34 % leaves the map 66 %, which is the
 * "cap the map around 65-70 % on very wide screens" the brief asks for, and at
 * 1440 it comes out at 490 px, inside the 480-560 the brief asks for there.
 *
 * Below 1280 the old ladder stands. Those widths are a small laptop, a tablet
 * and a phone lying down, where 34 % of the screen is not a readable card and
 * the map would stop being a map. The floor of 480 only bites between 1280 and
 * 1412, where the fraction would fall under it.
 */
function defaultListW(boardWidth: number): number {
  if (boardWidth >= 1280) return Math.max(480, Math.round(boardWidth * 0.34));
  if (boardWidth >= 1100) return 380;
  if (boardWidth >= 900) return 340;
  return 300;
}

/** How wide a card list is allowed to get before it stops being scannable. */
const LIST_MEASURE: React.CSSProperties = { maxWidth: 1040, marginInline: "auto" };

/** The map keeps at least this much, so dragging cannot close it by accident. */
const MIN_MAP_W = 380;
/** And the list keeps enough for a card's route line and its contact button. */
const MIN_LIST_W = 320;

function clampListW(want: number, boardWidth: number): number {
  if (boardWidth <= 0) return want;
  return Math.round(
    Math.min(Math.max(want, MIN_LIST_W), Math.max(MIN_LIST_W, boardWidth - MIN_MAP_W)),
  );
}

/** A stable empty array, so `show=jobs` does not hand the map a new one a frame. */
const EMPTY_TRUCKS: PublicTruckRow[] = [];

/**
 * Error strings reach us from two places -- our own literals and whatever the
 * API put in `body.error` -- and only some of them end in a full stop. This
 * makes exactly one, so a sentence appended after the message never reads
 * "Could not load the board Showing the last results." or ends in "..".
 */
function stopped(message: string): string {
  const trimmed = message.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** An end the post placed no more precisely than a whole state or region. */
function isApproxEnd(precision: string | null): boolean {
  return precision === "state" || precision === "region";
}

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

/**
 * Which population the LIST is showing, and which headlines print.
 *
 * `both` is the default because co-presence is the point of the feature and a
 * default of `jobs` would ship it switched off (SPEC 15.1). What `both` means
 * here in stage 2 is: the job list, with the truck count and free-space total
 * printed on a line of their own underneath. It is never a merged list and
 * never a combined count -- "104 listings" is a sentence this board cannot say.
 *
 * `jobs` is reachable only from a URL. It exists so a link can mean "freight
 * only, and do not mention trucks at all"; stage 3's map emphasis control is
 * what will set it from the UI.
 */
type Show = "jobs" | "trucks" | "both";

function hydrateShow(qs: string, truckId: number | null | undefined): Show {
  if (truckId != null) return "trucks";
  const raw = new URLSearchParams(qs).get("show");
  return raw === "jobs" || raw === "trucks" ? raw : "both";
}

export function Board({
  initialQuery,
  initialJobId,
  initialTruckId,
  signedIn,
  role,
  userId,
  demoMode,
}: BoardProps) {
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

  // --- the second population ------------------------------------------------
  // A SECOND fetch to a SECOND endpoint, and the two fail independently on
  // purpose (SPEC 13): a trucks outage prints one line above an otherwise
  // working job board and must never blank it. `GET /api/loads` is not modified
  // by this feature -- not its parser, not its response shape -- so there was
  // never a single request that could have carried both.
  const [show, setShow] = useState<Show>(() => hydrateShow(initialQuery, initialTruckId));
  const [trucks, setTrucks] = useState<PublicTruckRow[]>([]);
  const [truckSummary, setTruckSummary] = useState<TruckSummary | null>(null);
  const [truckLoading, setTruckLoading] = useState(true);
  const [truckError, setTruckError] = useState<string | null>(null);
  const [noDestHidden, setNoDestHidden] = useState(0);
  const [truckTruncated, setTruckTruncated] = useState(false);
  const [selectedTruckId, setSelectedTruckId] = useState<number | null>(initialTruckId ?? null);
  const [truckAutoContact, setTruckAutoContact] = useState(false);
  const [hoveredTruckId, setHoveredTruckId] = useState<number | null>(null);

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

  /* --- V01: how much of the board each column gets --------------------------
   *
   * `view` is Map + list or List. There is no Map-only view on the desktop
   * board and there is not going to be one: the list is the thing a dispatcher
   * reads, so the choice on offer is "keep the map" or "give the list the whole
   * width", never "take the list away".
   *
   * `listW` is the width the VIEWER dragged the divider to, in px, or null for
   * "whatever this screen's default is". Both are read from localStorage after
   * mount rather than during render -- the server has no idea how wide the
   * screen is, and reading storage in an initialiser is a hydration mismatch.
   */
  const [view, setView] = useState<BoardView>("split");
  const [listW, setListW] = useState<number | null>(null);
  /** The two-column grid's own width; the default panel is a fraction of it. */
  const [boardW, setBoardW] = useState(0);
  /** Live during a divider drag, so the columns move with the pointer. */
  const [dragW, setDragW] = useState<number | null>(null);

  const [notice, setNotice] = useState<string | null>(() =>
    new URLSearchParams(initialQuery).get("notice") === "poster-only"
      ? "Posting needs a poster account."
      : null,
  );

  const requestId = useRef(0);
  const truckRequestId = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const filterRow = useRef<HTMLDivElement>(null);
  const listScroller = useRef<HTMLDivElement>(null);
  const columns = useRef<HTMLDivElement>(null);
  /**
   * Where the list was scrolled to when a detail took its place, and which card
   * was opened. The scroller UNMOUNTS while the drawer is on screen -- it is
   * the same column -- so the position has to be held outside it or every
   * "Back to 98 jobs" lands at the top of the board (V01).
   */
  const listPos = useRef(0);
  const lastOpened = useRef<number | null>(null);
  const restore = useRef(false);

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

  /* --- V01: the divider, and the view the viewer left it in -----------------
   *
   * A client-side preference, in localStorage and NOT in the URL, for the same
   * reason the map's emphasis control is: it is not a search. Nothing about the
   * result set changes, so a shared link must not carry it.
   */
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(VIEW_KEY);
      if (v === "list" || v === "split") setView(v);
      const w = Number(window.localStorage.getItem(LIST_W_KEY));
      if (Number.isFinite(w) && w > 0) setListW(w);
    } catch {
      // Private mode: the board simply starts at this screen's default.
    }
  }, []);

  // The grid's own width, which is what the default panel is a fraction of.
  // Measured rather than taken from `window.innerWidth`: the board is not
  // always the whole window, and a fraction of the wrong number is the 420 px
  // rail this item exists to fix.
  useEffect(() => {
    const el = columns.current;
    if (!el) {
      setBoardW(0);
      return;
    }
    const measure = () => setBoardW(Math.round(el.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mobile, view]);

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

  /**
   * The truck query, built by translating the SAME filter state rather than by
   * reusing the job board's query string.
   *
   * `parseTruckSearchParams` answers 400 to `minCf`, `readyBy`, `deliverBy` and
   * `hasPrice`, so sending the job URL to `/api/trucks` would fail loudly --
   * which is the design: those keys describe freight, and answering them with
   * an unfiltered truck board is the silent wrong answer this whole feature
   * refuses. `truckFiltersToQuery` drops them and `truckFilterNotes` prints, in
   * the Trucks tab, exactly which ones are not narrowing what is on screen.
   */
  const truckQuery = useMemo(
    () => truckFiltersToQuery(filters, { current, home, bounds: searchAsMove ? bounds : null }),
    [filters, current, home, bounds, searchAsMove],
  );

  const notes = useMemo(() => truckFilterNotes(filters), [filters]);
  const pricedOnly = filters.hasPrice;

  const searchTrucksNow = useCallback(async () => {
    const id = ++truckRequestId.current;
    setTruckLoading(true);
    setTruckError(null);
    try {
      // "Priced only" hides every truck, because a truck carries no price in
      // v1. Answering that here rather than asking the server for an empty set
      // keeps the note above the list and saves a round trip for a question
      // whose answer is already known.
      if (pricedOnly) {
        if (id !== truckRequestId.current) return;
        setTrucks([]);
        setTruckSummary(summarizeTrucks([], new Date()));
        setNoDestHidden(0);
        setTruckTruncated(false);
        return;
      }
      const qs = truckQuery ? `${truckQuery}&limit=500` : "limit=500";
      const res = await fetch(api(`/api/trucks?${qs}`));
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Couldn't load trucks");
      const data = body as PublicTruckSearchResult;
      if (id !== truckRequestId.current) return;
      const received = data.rows ?? [];
      setTrucks(received);
      setTruckSummary(data.summary ?? summarizeTrucks(received, new Date()));
      setNoDestHidden(data.applied?.noDestExcluded ?? 0);
      // The map draws whatever this fetch returned, so it has to know when that
      // is only the first page of what matched (SPEC 14.6).
      setTruckTruncated(Boolean(data.applied?.truncated));
    } catch (err) {
      if (id !== truckRequestId.current) return;
      setTrucks([]);
      setTruckSummary(null);
      setNoDestHidden(0);
      setTruckTruncated(false);
      setTruckError(err instanceof Error ? err.message : "Couldn't load trucks");
    } finally {
      if (id === truckRequestId.current) setTruckLoading(false);
    }
  }, [truckQuery, pricedOnly]);

  useEffect(() => {
    if (!hydrated) return;
    // `show === "jobs"` is a deliberate "do not mention trucks at all", so it
    // does not ask for them either.
    if (show === "jobs") {
      setTruckLoading(false);
      return;
    }
    void searchTrucksNow();
  }, [hydrated, searchTrucksNow, show]);

  // --- URL -----------------------------------------------------------------
  // replaceState, not push: the filter bar is not browser history. The open
  // job is, in the sense that it is what a shared link points at, but pushing
  // an entry per keystroke of the search box would bury the back button.
  useEffect(() => {
    const path =
      selectedTruckId != null
        ? `/trucks/${selectedTruckId}`
        : selectedId != null
          ? `/jobs/${selectedId}`
          : "/";
    // `show` rides in the URL so a shared link restores the tab that was open.
    // Omitted at the default, exactly as `map=delivery` is, so the common link
    // stays short.
    const sp = new URLSearchParams(visibleQuery);
    if (show !== "both") sp.set("show", show);
    const qs = sp.toString();
    window.history.replaceState(null, "", api(qs ? `${path}?${qs}` : path));
  }, [visibleQuery, selectedId, selectedTruckId, show]);

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

  const openTruck = useCallback((truck: PublicTruckRow, opts?: { contact?: boolean }) => {
    // One drawer at a time: the column holds one listing, and leaving a job
    // open underneath would make "Back to 6 trucks" land on a job.
    setSelectedId(null);
    setAutoContact(false);
    setSelectedTruckId(truck.id);
    setTruckAutoContact(Boolean(opts?.contact));
    if (window.matchMedia("(max-width: 767px)").matches) setSnap("half");
  }, []);

  const closeTruck = useCallback(() => {
    setSelectedTruckId(null);
    setTruckAutoContact(false);
  }, []);

  /**
   * The two tabs, and what each one means for the rest of the board.
   *
   * Jobs writes `both` rather than `jobs`: the default view names both
   * populations, and a driver tapping back from Trucks should get the board
   * they started on, not a narrower one they never chose. A URL that says
   * `show=jobs` is honoured and left alone.
   */
  const chooseJobs = useCallback(() => {
    closeTruck();
    setShow((v) => (v === "jobs" ? v : "both"));
  }, [closeTruck]);

  const chooseTrucks = useCallback(() => {
    closeJob();
    setShow("trucks");
  }, [closeJob]);

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

  /**
   * A truck arrow was clicked. It opens the truck's drawer AND moves the list
   * to the Trucks tab, because the drawer opens inside the list column: leaving
   * the Jobs tab selected under it would put "Back to 98 jobs" over a truck.
   */
  const selectTruckFromMap = useCallback(
    (id: number | null) => {
      if (id == null) {
        closeTruck();
        return;
      }
      closeJob();
      setShow("trucks");
      setSelectedTruckId(id);
      setTruckAutoContact(false);
      if (window.matchMedia("(max-width: 767px)").matches) setSnap("half");
    },
    [closeJob, closeTruck],
  );

  /** Hovering an arrow brings its card into view, exactly as a job's does. */
  const hoverTruck = useCallback(
    (id: number | null) => {
      setHoveredTruckId(id);
      if (id == null || selectedTruckId != null) return;
      listScroller.current
        ?.querySelector<HTMLElement>(`[data-truck-card][data-truck-id="${id}"]`)
        ?.scrollIntoView({ block: "nearest" });
    },
    [selectedTruckId],
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

  /** The one way out of a narrowed list, shared by the chip and the map. */
  const clearPlace = useCallback(() => setPlace(null), []);

  /* --- V01: the view control and the divider ------------------------------- */

  const chooseView = useCallback((next: BoardView) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Private mode: the choice lasts this visit and no longer.
    }
  }, []);

  /** The panel's width right now: mid-drag, the viewer's, or this screen's. */
  const panelW = clampListW(dragW ?? listW ?? defaultListW(boardW), boardW);

  const dividerPointer = useRef<number | null>(null);

  const onDividerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dividerPointer.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragW(panelW);
  };

  const onDividerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dividerPointer.current !== e.pointerId) return;
    const box = columns.current?.getBoundingClientRect();
    if (!box) return;
    // From the RIGHT edge, because that is the edge the panel is pinned to:
    // taking the delta from where the drag started would drift by however far
    // the pointer sat from the divider when it went down.
    setDragW(clampListW(Math.round(box.right - e.clientX), Math.round(box.width)));
  };

  const endDividerDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dividerPointer.current !== e.pointerId) return;
    dividerPointer.current = null;
    const settled = dragW;
    setDragW(null);
    if (settled == null) return;
    setListW(settled);
    try {
      window.localStorage.setItem(LIST_W_KEY, String(settled));
    } catch {
      // ignore
    }
  };

  /** The divider is a real control, so it moves without a pointer too. */
  const onDividerKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 80 : 24;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const next = clampListW(panelW + (e.key === "ArrowLeft" ? step : -step), boardW);
      setListW(next);
      try {
        window.localStorage.setItem(LIST_W_KEY, String(next));
      } catch {
        // ignore
      }
    } else if (e.key === "Home") {
      e.preventDefault();
      setListW(null);
      try {
        window.localStorage.removeItem(LIST_W_KEY);
      } catch {
        // ignore
      }
    }
  };

  /* --- V01: the list comes back where it was --------------------------------
   *
   * The drawer takes the list column's place, so the scroller unmounts while a
   * job is open and a fresh one mounts at scrollTop 0 when it closes. Nine
   * cards down the board, "Back to 98 jobs" therefore landed on card one. The
   * position is held out here, and the card that was opened is scrolled back
   * into view rather than merely restored to a pixel -- the list may have been
   * re-sorted by a background refresh in between, and the ANSWER the viewer
   * wants is "where was I", not "what was scrollTop".
   */
  const detailOpen = selectedId != null || selectedTruckId != null;

  useEffect(() => {
    if (detailOpen) {
      lastOpened.current = selectedId;
      restore.current = true;
    }
  }, [detailOpen, selectedId]);

  // A new search, or the other population, is a new list -- so the old
  // position means nothing and must not be restored onto it.
  useEffect(() => {
    listPos.current = 0;
    lastOpened.current = null;
    restore.current = false;
  }, [visibleQuery, show]);

  // Layout, not effect: the browser must never paint the list at the top and
  // then jump it. Runs when the drawer closes and the scroller remounts.
  useBeforePaint(() => {
    if (detailOpen || !restore.current) return;
    restore.current = false;
    const el = listScroller.current;
    if (!el) return;
    const id = lastOpened.current;
    const card =
      id == null
        ? null
        : el.querySelector<HTMLElement>(`[data-job-card][data-job-id="${id}"]`);
    if (card) card.scrollIntoView({ block: "nearest" });
    else el.scrollTop = listPos.current;
  }, [detailOpen]);

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

  /**
   * What the results actually contain, for the two controls that would
   * otherwise misrepresent themselves: the deadline filter (which is inert
   * because no job in the corpus carries a `deliver_by`) and the corridor
   * read-out (whose numbers the API returns and nothing rendered).
   *
   * Counted over the rows on screen rather than the server summary, which
   * carries neither figure — so it is described as "the jobs on the board",
   * never as a claim about every job that exists.
   */
  const resultStats = useMemo(() => {
    let withDeliverBy = 0;
    let withPickupZip = 0;
    let withDeliveryZip = 0;
    for (const r of rows) {
      if (r.deliver_by != null) withDeliverBy += 1;
      if (r.pickup_zip) withPickupZip += 1;
      if (r.delivery_zip) withDeliveryZip += 1;
    }
    return { withDeliverBy, withPickupZip, withDeliveryZip };
  }, [rows]);

  const corridorStats = useMemo<CorridorStats | null>(() => {
    if (filters.routeMode !== "corridor") return null;
    let min: number | null = null;
    let max: number | null = null;
    let approximate = 0;
    for (const r of rows) {
      const d = r.detour_miles;
      if (d != null) {
        min = min == null || d < min ? d : min;
        max = max == null || d > max ? d : max;
      }
      if (isApproxEnd(r.pickup_precision) || isApproxEnd(r.delivery_precision)) approximate += 1;
    }
    return { matched: rows.length, minDetour: min, maxDetour: max, approximate };
  }, [filters.routeMode, rows]);

  const ordered = useMemo(() => partitionUnverified(rows), [rows]);
  /**
   * What the MAP plots as trucks.
   *
   * The map draws both populations whichever tab the list is on: a dispatcher
   * reading the job list still wants to see a truck heading their way, and the
   * emphasis control on the map panel is what turns one of them down. The one
   * case that draws none is `show=jobs`, which is a link that means "freight
   * only, and do not mention trucks at all" -- and which does not fetch them.
   */
  const mapTrucks = show === "jobs" ? EMPTY_TRUCKS : trucks;
  // The map always draws the whole result; only the list narrows to one place,
  // so the surrounding inventory stays visible while you read what is at it.
  const listed = useMemo(
    () => (place ? ordered.filter((j) => place.ids.includes(j.id)) : ordered),
    [ordered, place],
  );
  const shown = place ? summarize(listed) : (summary ?? summarize(rows));
  const now = useMemo(() => new Date(), [rows]);
  /** The server's figures, or the client fallback for a partial response. */
  const truckShown =
    truckSummary ?? (trucks.length ? summarizeTrucks(trucks, now) : null);
  const listKind: "jobs" | "trucks" = show === "trucks" ? "trucks" : "jobs";
  /**
   * TWO STRINGS OUT, never one, and they are never added together: the two
   * summaries share no field that carries a volume, so there is no arithmetic
   * here to get wrong. See SPEC 15.3 and npm run check:sums.
   */
  const headline = boardHeadline(shown, show === "jobs" ? null : truckShown);
  const truckStats = truckShown ? truckSubline(truckShown) : null;
  const selectedTruck = trucks.find((t) => t.id === selectedTruckId) ?? null;
  const truckFirstLoad = truckLoading && truckSummary == null && trucks.length === 0;
  const selectedJob = ordered.find((j) => j.id === selectedId) ?? null;
  const suggestions = emptyStateSuggestions(filters);
  // Not on a phone, and not on a landscape phone either: it is a 320 px card
  // over a 544 x 267 map, which is most of the map.
  const showNudge = hydrated && !current && !nudged && !mobile && !shortScreen;

  /**
   * The list's head, and the board's visual entry point: the one place that
   * says how much freight is on screen before you read a single card. The
   * count and the cubic feet carry the weight; the truckload equivalent and
   * the ready/priced tally are the footnote to it, on one quiet line.
   */
  const firstLoad = loading && summary == null && rows.length === 0;

  /**
   * The two tabs. They render at EVERY width, including inside the bottom
   * sheet's handle on a phone.
   *
   * `onPointerDown` stops there because the handle captures the pointer to drag
   * the sheet, and a captured pointer never becomes a click on a child. The
   * drag still works from everywhere else on the handle, which is most of it.
   *
   * The zero is printed rather than hidden: a control that silently does
   * nothing looks broken, and one that says "Trucks (0)" is informative -- it
   * is also the only invitation to post the first one (SPEC 2).
   */
  const tabs = (
    <div
      /* No bottom margin on compact. The sheet's handle is a fixed 104 px
         (`--sheet-handle-h`) and this row grew from 44 to 50 when the view
         control joined it -- `.seg` is `--tap-min + 6` so the OPTION inside it
         is a 44 px target. At 320 x 568, where the summary underneath already
         wraps to two lines, the handle's content measured 115 px before and
         121 after; giving the four pixels back puts it at 117. */
      className="flex items-center gap-[var(--sp-1)] md:mb-[var(--sp-2)]"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Tab
        label="Jobs"
        count={firstLoad ? null : shown.count}
        active={listKind === "jobs"}
        onClick={chooseJobs}
      />
      <Tab
        label="Trucks"
        count={truckError ? null : truckFirstLoad ? null : (truckShown?.count ?? 0)}
        active={listKind === "trucks"}
        onClick={chooseTrucks}
      />
      {/* V01 / V08: WHICH OF THE TWO IS ON SCREEN, said as a control rather
          than left to a drag handle.

          On a phone it moves the sheet between its own existing snaps -- Map is
          the peek, List is the full -- so it is a shortcut to the drag, not a
          second mechanism with its own state to get out of step. Neither is
          pressed at the half snap, which is a real third position and is what
          the board opens in; saying otherwise would be the control lying about
          where the sheet is.

          On the desktop it chooses between Map + list and List. There is no
          Map-only view: the list is what a dispatcher reads. */}
      <div
        className="seg ml-auto"
        role="group"
        aria-label="What to show"
        /* 320 px is the reflow floor the brief names, and at 320 the two tabs
           and this control are 331 px of content in a 288 px row. The words
           are the last thing that may go, so the padding goes first. */
        style={mobile ? { paddingInline: 2 } : undefined}
      >
        <button
          type="button"
          className="seg-option"
          aria-pressed={mobile ? snap === "peek" : view === "split"}
          data-on={(mobile ? snap === "peek" : view === "split") ? "" : undefined}
          onClick={() => (mobile ? setSnap("peek") : chooseView("split"))}
          title={mobile ? "Drop the sheet and show the map" : "Show the map beside the results"}
          style={mobile ? { paddingInline: 10 } : undefined}
        >
          {mobile ? "Map" : "Map + list"}
        </button>
        <button
          type="button"
          className="seg-option"
          aria-pressed={mobile ? snap === "full" : view === "list"}
          data-on={(mobile ? snap === "full" : view === "list") ? "" : undefined}
          onClick={() => (mobile ? setSnap("full") : chooseView("list"))}
          title={
            mobile
              ? "Raise the sheet and read the results"
              : "Give the results the whole width"
          }
          style={mobile ? { paddingInline: 10 } : undefined}
        >
          List
        </button>
      </div>
    </div>
  );

  const truckHeader = truckError ? (
    <div>
      <div className="big text-(length:--fs-xl)" style={{ color: "var(--muted)" }}>
        Trucks unavailable
      </div>
      <div className="mt-[1px] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
        The truck board could not be read
      </div>
    </div>
  ) : truckFirstLoad ? (
    <div aria-hidden="true">
      <span className="skeleton h-[20px] w-[150px]" />
      <span className="skeleton mt-[5px] h-[12px] w-[210px]" />
    </div>
  ) : (
    <div>
      {/* Nothing at all when the set is empty. SPEC 15.3: "when trucks.count
          === 0, no truck line renders at all -- not '0 trucks'. The tab label
          already carries the zero." The empty state below says the rest, and it
          asks for supply rather than reporting an absence. */}
      {headline.truckLine && (
        <div className="big nums text-(length:--fs-xl)">{headline.truckLine}</div>
      )}
      {/* One line on a phone, for the reason the job line beside it is one
          line: on compact this IS the sheet's grab handle, and a second wrapped
          line pushes the text down over the first card. So the two clauses that
          are CAVEATS -- what the board does not know about these trucks -- are
          on both, and the two that are merely statistics are desktop-only.
          `md:` is 768 px, the same breakpoint that decides `mobile`. */}
      <div className="mt-[1px] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
        {truckStats && (
          <>
            {truckStats.departing && (
              <span className="hidden md:inline">{`${truckStats.departing} · `}</span>
            )}
            {[truckStats.unsized, truckStats.noDest].filter(Boolean).join(" · ")}
            {truckStats.swing && (
              <span className="hidden md:inline">
                {truckStats.unsized || truckStats.noDest ? " · " : ""}
                {truckStats.swing}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );

  const jobHeader = firstLoad ? (
    // "0 jobs · 0 ready now · 0 priced" is a confident answer to a question
    // nobody has answered yet, and it is the wrong one often enough to matter.
    <div aria-hidden="true">
      <span className="skeleton h-[20px] w-[150px]" />
      <span className="skeleton mt-[5px] h-[12px] w-[210px]" />
    </div>
  ) : error && rows.length === 0 ? (
    // And it is wrong in the same way after a failed fetch -- worse, because by
    // then it looks settled. "0 jobs" would tell a driver there is no freight
    // when what actually happened is that nobody asked successfully. On a phone
    // this line is the sheet's handle, so it is the first thing read.
    <div>
      <div className="big text-(length:--fs-xl)" style={{ color: "var(--muted)" }}>
        Jobs unavailable
      </div>
      <div className="mt-[1px] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
        The board could not be read
      </div>
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
        {/* The caveat on the number it follows, not a statistic on the line
            below: this total is the sum over SIZED jobs only, and the map panel
            has always said so while the list header did not -- two counts of the
            same set, one of them qualified. 0 on all 98 jobs today; it appears
            the first time an unsized job is posted. Small and amber so it reads
            as a footnote to 42,506 cf rather than a second headline. */}
        {shown.count - shown.withCf > 0 && (
          <span className="text-(length:--fs-sm) font-medium" style={{ color: "var(--approx)" }}>
            {" · "}
            {shown.count - shown.withCf} without size
          </span>
        )}
      </div>
      {/* One line on a phone, because on a phone this IS the bottom sheet's
          56 px grab handle: a second wrapped line pushes the text up under the
          drag pill and down over the first card. So the two statistics that are
          merely interesting -- how much of the board arrived today, and the
          median rate -- are desktop-only, and everything that is a CAVEAT (the
          truckload basis, the without-size count above) is on both. `md:` is
          768 px, the same breakpoint that decides `mobile`, so the sheet and the
          hidden spans switch together.

          `summarize()` is the client fallback for a partial or failed response
          and cannot compute freshToday or the median, so it returns 0 and null;
          both are treated here as "say nothing". Omitting a number we do not
          have is honest, printing "0 listed today" is not. And the median never
          appears without the count it was taken over, which is why it hangs off
          the "N priced" clause instead of standing on its own. */}
      <div className="mt-[1px] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
        {shown.totalCf > 0 && `${truckLine(shown.totalCf, current?.truckCf ?? null)} · `}
        {shown.readyNow} ready now
        {shown.freshToday > 0 && (
          <span className="hidden md:inline">{` · ${shown.freshToday} listed today`}</span>
        )}
        {` · ${shown.priced} priced`}
        {shown.medianPricePerCf != null && (
          <span className="hidden md:inline">{` · median ${formatRate(shown.medianPricePerCf)}`}</span>
        )}
        {truncated && " · showing first 500"}
      </div>
      {/* THE THIRD LINE, and it is a line of its own for a structural reason:
          the board must never print a combined figure, so the truck total sits
          under the freight total rather than beside it, in its own unit words
          ("cf free", never a bare "cf"). It is absent entirely when there are
          no trucks -- the tab label carries that zero. */}
      {/* Desktop only, and not because it is unimportant: on a phone the tab
          label two lines above already says "Trucks (4)", and this is the third
          line inside a grab handle. Repeating the count there costs a wrapped
          line over the first card and buys nothing a thumb cannot already see. */}
      {show === "both" && headline.truckLine && (
        <div className="mt-[1px] hidden text-(length:--fs-sm) md:block" style={{ color: "var(--muted)" }}>
          <button
            type="button"
            className="underline"
            style={{ color: "var(--accent)", background: "none" }}
            onClick={chooseTrucks}
          >
            {headline.truckLine}
          </button>
        </div>
      )}
      {show === "both" && truckError && (
        <div className="mt-[1px] text-(length:--fs-sm)" style={{ color: "var(--danger)" }}>
          Couldn&apos;t load trucks.
        </div>
      )}
    </div>
  );

  const header = (
    <div>
      {tabs}
      {listKind === "trucks" ? truckHeader : jobHeader}
    </div>
  );

  const conflict = filterConflict(filters);

  /**
   * The Trucks tab.
   *
   * The notes above the list are not decoration and are not optional: when a
   * job-only filter is set, this is where the board says which of the controls
   * the driver can see is NOT narrowing what is under it. A control that looks
   * like it is doing something and is not is the deliver-by mistake from wave 1,
   * and the board only gets to make that one once.
   */
  const truckBody = (
    <>
      {notes.length > 0 && (
        <ul className="mb-[var(--sp-2)] flex flex-col gap-[var(--sp-1)]">
          {notes.map((n) => (
            <li
              key={n.key}
              className="rounded-[var(--radius-sm)] px-[var(--sp-3)] py-[var(--sp-2)] text-(length:--fs-sm)"
              style={{ background: "var(--surface-2)", color: "var(--text-2)" }}
            >
              {n.text}
            </li>
          ))}
        </ul>
      )}

      {/* Printed, never silent: every one of these trucks is a real listing a
          destination filter removed for saying nothing about where it is going.
          The count comes from the server, over the whole filtered set. */}
      {noDestHidden > 0 && (
        <p
          className="mb-[var(--sp-2)] rounded-[var(--radius-sm)] px-[var(--sp-3)] py-[var(--sp-2)] text-(length:--fs-sm)"
          style={{ background: "var(--warn-soft)", color: "var(--warn)" }}
        >
          {noDestHidden} truck{noDestHidden === 1 ? "" : "s"} with no stated destination{" "}
          {noDestHidden === 1 ? "is" : "are"} hidden by this filter.
        </p>
      )}

      {truckError && trucks.length > 0 && (
        <p
          className="mb-[var(--sp-2)] flex items-center gap-[var(--sp-3)] rounded-[var(--radius-sm)] px-[var(--sp-3)] py-[var(--sp-2)] text-(length:--fs-sm)"
          style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
        >
          <span>{stopped(truckError)} Showing the last results.</span>
          <button type="button" className="btn btn-sm ml-auto" onClick={() => void searchTrucksNow()}>
            Try again
          </button>
        </p>
      )}

      {truckLoading && trucks.length === 0 ? (
        <>
          <p className="sr-only" role="status">
            Loading trucks…
          </p>
          <TruckListSkeleton />
        </>
      ) : truckError ? (
        <EmptyState
          title="Could not load trucks"
          hint={`${stopped(truckError)} Nothing could be read from the truck board, so this is not the same as no trucks being listed.`}
        >
          <button type="button" className="btn btn-sm" onClick={() => void searchTrucksNow()}>
            Try again
          </button>
        </EmptyState>
      ) : trucks.length === 0 && pricedOnly ? (
        // Correct behaviour that reads exactly like a bug, so it is stated.
        <EmptyState
          title="Priced only hides every truck"
          hint="Trucks never carry a price on this board, so nothing can match. Clear it to see the trucks again."
        >
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setFilters((f) => ({ ...f, hasPrice: false }))}
          >
            Clear “priced only”
          </button>
        </EmptyState>
      ) : trucks.length === 0 && isDefault(filters) ? (
        // Day one, and the state this feature launches in: nobody has posted
        // yet. The only thing this screen can usefully ask for is supply.
        <EmptyState
          title="No trucks listed yet"
          hint="Driving a leg empty? Post it — it takes about a minute and dispatchers on this board will see it."
        >
          <a className="btn btn-primary btn-sm" href={api("/post/truck")}>
            Post truck space
          </a>
        </EmptyState>
      ) : trucks.length === 0 ? (
        <EmptyState
          title="No trucks match this search"
          hint="Trucks are listed by drivers with an empty leg, and there are far fewer of them than jobs. Widening the lane or the dates is usually what finds one."
        >
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setFilters(clearedFilters(filters))}
          >
            Clear filters
          </button>
        </EmptyState>
      ) : (
        <TruckList
          trucks={trucks}
          selectedId={selectedTruckId}
          hoveredId={hoveredTruckId}
          now={now}
          onSelect={openTruck}
          onHover={setHoveredTruckId}
        />
      )}
    </>
  );

  const listBody = (
    <>
      {/* The corridor's own read-out, above the jobs it selected: the route,
          its width, and the extra driving. `off_route_miles` and `detour_miles`
          have been on every corridor row since the engine shipped and were
          rendered nowhere. */}
      <RouteStrip
        filters={filters}
        onChange={setFilters}
        current={current}
        home={home}
        stats={corridorStats}
      />
      {place && (
        <div className="mb-[var(--sp-2)] flex items-center gap-[var(--sp-2)]">
          <button
            type="button"
            className="chip chip-accent"
            style={{ cursor: "pointer" }}
            title="Show every job in this search again"
            onClick={clearPlace}
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
      {/* A search that failed while results were already on screen. Those rows
          are still true and still worth calling, so they stay and this says
          only that the refresh did not land. The no-rows case is a different
          state entirely and is handled below. */}
      {error && rows.length > 0 && (
        <p
          className="mb-[var(--sp-2)] flex items-center gap-[var(--sp-3)] rounded-[var(--radius-sm)] px-[var(--sp-3)] py-[var(--sp-2)] text-(length:--fs-sm)"
          style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
        >
          <span>{stopped(error)} Showing the last results.</span>
          <button type="button" className="btn btn-sm ml-auto" onClick={() => void search()}>
            Try again
          </button>
        </p>
      )}

      {/* THREE STATES, AND THEY ARE NOT THE SAME STATE.
          - "Could not load jobs" is OUR failure. Nothing is known about what is
            out there, and the recovery is to ask again.
          - "No jobs match this search" is a true and complete answer. Nothing
            is broken; the recovery is to widen the filters.
          - "Map unavailable" is neither -- it is the map's own boundary, over
            in the other column, and the jobs below are unaffected.
          Collapsing any two of these tells a driver the wrong thing about
          whether there is freight to be had. */}
      {loading && rows.length === 0 ? (
        <>
          <p className="sr-only" role="status">
            Loading jobs…
          </p>
          <JobListSkeleton />
        </>
      ) : error ? (
        <EmptyState
          title="Could not load jobs"
          hint={`${stopped(error)} Nothing could be read from the board, so this is not the same as no jobs matching.`}
        >
          <button type="button" className="btn btn-sm" onClick={() => void search()}>
            Try again
          </button>
        </EmptyState>
      ) : rows.length === 0 && conflict ? (
        // A fourth state, and it is about the FORM, not the freight: nothing can
        // match a range whose floor is above its ceiling, so saying "no jobs
        // match this search" would blame the board for what the search asked.
        <EmptyState title={conflict.title} hint={conflict.hint}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setFilters(conflict.fix.next)}
          >
            {conflict.fix.label}
          </button>
        </EmptyState>
      ) : rows.length === 0 ? (
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

  const detail = selectedTruckId != null ? (
    <TruckDetail
      truck={selectedTruck}
      truckId={selectedTruckId}
      totalInList={truckShown?.count ?? trucks.length}
      signedIn={signedIn}
      demoMode={demoMode}
      role={role}
      userId={userId}
      viewer={current}
      autoContact={truckAutoContact}
      mobile={mobile}
      onClose={closeTruck}
      onChanged={() => void searchTrucksNow()}
    />
  ) : selectedId != null ? (
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

  /**
   * How much of the map's box the bottom sheet is covering. The map frames its
   * jobs into what is left, and the unavailable panel centres itself in the
   * same space -- one measurement, so a message about a missing map cannot end
   * up behind the sheet where the map used to be.
   */
  const mapBottomPadding = mobile ? snapHeightPx(viewportHeight, snap, topInset) : 0;

  const map = (
    <div className="relative h-full w-full">
      {/* Everything that belongs to the map goes inside the boundary, not just
          `LoadMap`: if the map cannot draw, the nudge that asks where your
          truck is and the "nothing to plot" note are both about a map that is
          not there, and printing them over the unavailable panel would be three
          messages in one rectangle. One failure, one thing to read.

          What is deliberately OUTSIDE it: the filter bar, the list, the open
          job and the rows themselves. They live in this component's state, they
          never needed a GPU, and they are what the visitor came for. */}
      <MapBoundary compact={mobile || shortScreen} bottomPadding={mapBottomPadding}>
        <LoadMap
          jobs={ordered}
          /* THE MAP'S SECOND FEED, and it is a second feed rather than a second
             field on the first: `/api/loads` is not modified by this feature,
             so there was never one request that could carry both. The map draws
             both populations at every `show` -- co-presence is the point of the
             feature, and the map's own emphasis control (SPEC 14.6) is what
             quiets one of them without removing it. `show === "jobs"` is the
             one exception, because it means "do not mention trucks at all" and
             the Board does not even fetch them. */
          trucks={mapTrucks}
          end={filters.mapEnd}
          selectedId={selectedId}
          hoveredId={hoveredId}
          selectedTruckId={selectedTruckId}
          hoveredTruckId={hoveredTruckId}
          onSelect={selectFromMap}
          onHover={setHoveredId}
          onSelectTruck={selectTruckFromMap}
          onHoverTruck={hoverTruck}
          truckTruncated={show === "jobs" ? false : truckTruncated}
          onStateClick={onStateClick}
          onGroupClick={onGroupClick}
          searchAsMove={searchAsMove}
          onSearchAsMoveChange={setSearchAsMove}
          onBoundsChange={setBounds}
          viewer={current}
          home={home}
          /* The map draws the you-to-home corridor itself, so it is told only
             about that one: a corridor between two TYPED places is not the
             viewer's own line and must not be drawn as if it were. */
          towardHome={isTowardHome(filters)}
          fitKey={visibleQuery}
          /* How much of the map the sheet is covering right now: the map frames
             the jobs into what is left, and lifts its own legend and MapLibre's
             attribution above it. It re-frames when this changes -- once per
             snap, never mid-drag, and never after the viewer has panned the map
             themselves. */
          bottomPadding={mapBottomPadding}
          compact={mobile || shortScreen}
          filteredSummary={summary}
          loading={firstLoad}
          /* The map opens a place and the chip above the list closes it, so
             both have to be looking at the same fact. Without this the chip's
             ✕ would leave the map inside a marker with the whole list back
             behind it. */
          placeActive={place != null}
          onPlaceClear={clearPlace}
          /* The fetch failed, so `jobs` is empty because nothing could be
             read. Without this the map's "on screen" panel counts that empty
             list truthfully and reports "All 0 jobs · 0 cf" to a visitor whose
             board never loaded -- the same failure the list already states
             plainly two columns away. */
          error={error != null}
        />

        {showNudge && (
          <div className="glass absolute bottom-[var(--sp-6)] left-1/2 w-[320px] -translate-x-1/2 p-[var(--sp-3)]">
            {/* The same question the header pill now asks: not where the person
                is, but where the truck comes free (§5.1). */}
            <div className="font-semibold">Where will you be empty?</div>
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
                Set truck location
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
        {rows.length === 0 && !loading && (
          <div className="glass absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 px-[var(--sp-4)] py-[var(--sp-3)] text-center">
            {/* An empty map after a failed fetch must not be read as an empty
                country. "Nothing to plot" is an answer; this is the absence of
                one, and the button offers the matching recovery. */}
            <div
              className="text-(length:--fs-sm)"
              style={{ color: error ? "var(--danger)" : "var(--muted)" }}
            >
              {error ? "Could not load jobs to plot." : "Nothing to plot for this search."}
            </div>
            {error ? (
              <button
                type="button"
                className="btn btn-sm mt-[var(--sp-2)]"
                onClick={() => void search()}
              >
                Try again
              </button>
            ) : (
              !isDefault(filters) && (
                <button
                  type="button"
                  className="btn btn-sm mt-[var(--sp-2)]"
                  onClick={() => setFilters(clearedFilters(filters))}
                >
                  Clear filters
                </button>
              )
            )}
          </div>
        )}
      </MapBoundary>
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
        stats={{ count: shown.count, ...resultStats, loading: firstLoad }}
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
            {detail ?? (listKind === "trucks" ? truckBody : listBody)}
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

      {/* THE SPLIT, AND WHO GETS TO SET IT (V01).
          `minmax(0, 1fr)`, not `minmax(560px, 1fr)`. A phone held sideways is
          844 px wide -- past the 768 breakpoint, so it gets this layout -- and
          560 + 340 is 900. The two tracks overflowed by 56 px, `.board`'s
          `overflow: hidden` clipped the difference, and what got clipped was
          the right edge of the list column: every card's Show contact button,
          which is `ml-auto` against exactly that edge. A floor the container
          cannot honour is not a floor, it is a clipped column.

          The second track is no longer `var(--list-w)`, a constant that left
          the results a 420 px rail beside a 2,139 px map. It is `panelW`: a
          measured fraction of the board above 1280, whatever the viewer
          dragged the divider to, or -- in List view -- the whole width. */}
      <div
        ref={columns}
        className="grid min-h-0 flex-1"
        style={{
          gridTemplateColumns:
            view === "list" ? "minmax(0, 1fr)" : `minmax(0, 1fr) 5px ${panelW}px`,
        }}
      >
        {view === "split" && (
          <>
            <section className="min-w-0">{map}</section>
            {/* A real separator, not a decorated border: it takes a pointer, it
                takes the keyboard (arrows move it, Home returns it to this
                screen's default), and it reports where it is. `col-resize`
                everywhere on it, so the affordance is the whole five pixels. */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Results panel width"
              aria-valuenow={panelW}
              aria-valuemin={MIN_LIST_W}
              aria-valuemax={Math.max(MIN_LIST_W, boardW - MIN_MAP_W)}
              tabIndex={0}
              onPointerDown={onDividerDown}
              onPointerMove={onDividerMove}
              onPointerUp={endDividerDrag}
              onPointerCancel={endDividerDrag}
              onKeyDown={onDividerKey}
              onDoubleClick={() => {
                setListW(null);
                try {
                  window.localStorage.removeItem(LIST_W_KEY);
                } catch {
                  // ignore
                }
              }}
              style={{
                cursor: "col-resize",
                background: dragW == null ? "var(--border)" : "var(--accent)",
                touchAction: "none",
              }}
              title="Drag to resize · double-click to reset"
            />
          </>
        )}

        <section
          className="flex min-h-0 flex-col"
          style={{ background: "var(--bg)" }}
        >
          {detail ? (
            detail
          ) : (
            <>
              {/* On --surface, not the tray's --bg: the list gets a head the
                  way the map has its panel, and the cards below then sit in a
                  recess rather than floating on the same plane as their own
                  title. */}
              {/* In List view the column is the whole board, and a card set on
                  a 1,440 px line is a line nobody can scan back along. The
                  measure is capped and centred; the scroller itself stays full
                  width, so the scrollbar is still at the edge of the screen
                  where a hand expects it. */}
              <header
                className="border-b border-border px-[var(--sp-4)] py-[var(--sp-3)]"
                style={{ background: "var(--surface)" }}
              >
                <div style={view === "list" ? LIST_MEASURE : undefined}>{header}</div>
              </header>
              <div
                ref={listScroller}
                onScroll={(e) => {
                  listPos.current = e.currentTarget.scrollTop;
                }}
                className="min-h-0 flex-1 overflow-y-auto p-[var(--sp-3)]"
              >
                <div style={view === "list" ? LIST_MEASURE : undefined}>
                  {listKind === "trucks" ? truckBody : listBody}
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * One of the two list tabs.
 *
 * A count of `null` means "not known yet" and prints nothing, rather than a
 * confident zero next to a request that has not answered. A count of 0 is a
 * real answer and is printed.
 */
function Tab({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number | null;
  active: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className="chip chip-button"
      aria-pressed={active}
      onClick={onClick}
      style={{
        background: active ? "var(--accent-soft)" : "transparent",
        color: active ? "var(--accent)" : "var(--muted)",
        fontWeight: active ? 600 : 500,
        minHeight: "var(--tap-min)",
        paddingInline: "var(--sp-3)",
      }}
    >
      {label}
      {count != null && (
        <span className="nums" style={{ opacity: 0.85 }}>
          {" "}
          ({count.toLocaleString("en-US")})
        </span>
      )}
    </button>
  );
}
