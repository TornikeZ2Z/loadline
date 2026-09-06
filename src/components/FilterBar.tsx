"use client";

/**
 * The filter bar, and the `Filters` <-> query-string translation the whole
 * board runs on.
 *
 * The URL *is* the saved search: every control writes into `Filters`, `Filters`
 * is mirrored into the address bar on every change, and `hydrate()` reads it
 * back on load. That is why there is no Save button and no saved-search table --
 * a driver who wants "FL to the Tri-State, ready now" bookmarks it or sends it
 * to a friend, and it means the same thing tomorrow.
 *
 * One deliberate exception to "everything is in the URL": the viewer's own
 * coordinates. They are added to the API request and never to the address bar,
 * so a shared link never carries where somebody was standing.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { BoundsInput, MapEnd, SortKey } from "@/lib/loads/types";
import type { StoredLocation } from "@/lib/location";
import { homeQuery, useViewerLocation, viewerQuery } from "@/lib/location";
import { CF_PRESETS, READY_OPTIONS, SEEN_OPTIONS, SORT_OPTIONS } from "@/lib/loads/present";
import { StatePicker, tokenLabel } from "./StatePicker";
import { PopoverButton } from "./ui";

/**
 * `mapEnd` is not a filter -- it changes nothing about which jobs match -- but
 * it lives in `Filters` because it belongs in the URL for the same reason
 * everything else here does: a link to "FL pickups" and a link to "NJ
 * deliveries" are different views of the board, and both are worth sending to
 * somebody.
 */
export interface Filters {
  /** "pickup" (default) plots where jobs load; "delivery" where they drop. */
  mapEnd: MapEnd;
  pickupState: string[];
  deliveryState: string[];
  minCf: string;
  maxCf: string;
  /** true (the default) keeps jobs whose post never stated a size. */
  unsized: boolean;
  ready: "any" | "now" | "by";
  readyBy: string;
  seenDays: "" | "1" | "3" | "7";
  q: string;
  deliverBy: string;
  hasPrice: boolean;
  showInactive: boolean;
  review: boolean;
  towardHome: boolean;
  sort: SortKey | "";
}

export const EMPTY_FILTERS: Filters = {
  // A mover with an empty truck is asking "what can I collect near me", so the
  // map opens on the loading end.
  mapEnd: "pickup",
  pickupState: [],
  deliveryState: [],
  minCf: "",
  maxCf: "",
  unsized: true,
  ready: "any",
  readyBy: "",
  seenDays: "",
  q: "",
  deliverBy: "",
  hasPrice: false,
  showInactive: false,
  review: false,
  towardHome: false,
  sort: "",
};

/** What "Show delisted / taken / expired" asks the server for. */
const INACTIVE_STATUSES = "available,delisted,pending,taken,expired";

/** The corridor width the Toward-home toggle uses. */
const CORRIDOR_MILES = 100;

// --- Filters <-> query -------------------------------------------------------

function list(v: string | null): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * `Filters` as a query string.
 *
 * Called twice per change: once with an empty context to write the address bar,
 * once with the viewer's stored locations to build the API request. Everything
 * position-derived is therefore behind `ctx`, which keeps the two callers from
 * having to remember which keys are private.
 */
export function filtersToQuery(
  f: Filters,
  ctx: { current: StoredLocation | null; home: StoredLocation | null; bounds?: BoundsInput | null },
): string {
  const sp = new URLSearchParams();
  // Omitted at the default, so the common URL stays short. The server ignores
  // it -- which end is drawn changes nothing about which jobs match.
  if (f.mapEnd === "delivery") sp.set("map", "delivery");
  if (f.pickupState.length) sp.set("pickupState", f.pickupState.join(","));
  if (f.deliveryState.length) sp.set("deliveryState", f.deliveryState.join(","));
  if (f.minCf) sp.set("minCf", f.minCf);
  if (f.maxCf) sp.set("maxCf", f.maxCf);
  if (!f.unsized) sp.set("unsized", "0");
  if (f.ready === "now") sp.set("readyOnly", "1");
  if (f.ready === "by" && f.readyBy) sp.set("readyBy", f.readyBy);
  if (f.seenDays) sp.set("seenDays", f.seenDays);
  if (f.q.trim()) sp.set("q", f.q.trim());
  if (f.deliverBy) sp.set("deliverBy", f.deliverBy);
  if (f.hasPrice) sp.set("hasPrice", "1");
  if (f.showInactive) sp.set("status", INACTIVE_STATUSES);
  if (f.review) sp.set("review", "1");
  if (f.sort) sp.set("sort", f.sort);
  // Auto: nearest pickup once the viewer has told us where they are. Said out
  // loud rather than left to the server default, so the request is readable.
  else if (ctx.current) sp.set("sort", "distance");

  // The corridor keeps its shape in the shareable URL; the two endpoints are
  // the viewer's own coordinates and are added only for the API request.
  if (f.towardHome) {
    sp.set("routeMode", "corridor");
    sp.set("corridor", String(CORRIDOR_MILES));
    if (ctx.current) {
      sp.set("originLat", ctx.current.lat.toFixed(5));
      sp.set("originLng", ctx.current.lng.toFixed(5));
    }
    for (const [k, v] of new URLSearchParams(homeQuery(ctx.home))) sp.set(k, v);
  }

  if (ctx.bounds) {
    sp.set("minLat", ctx.bounds.minLat.toFixed(5));
    sp.set("maxLat", ctx.bounds.maxLat.toFixed(5));
    sp.set("minLng", ctx.bounds.minLng.toFixed(5));
    sp.set("maxLng", ctx.bounds.maxLng.toFixed(5));
  }

  const viewer = ctx.current ? viewerQuery(ctx.current) : "";
  const base = sp.toString();
  return viewer ? (base ? `${base}&${viewer}` : viewer) : base;
}

/** Read a query string back into `Filters`. Unknown keys are ignored. */
export function hydrate(qs: string): Filters {
  const sp = new URLSearchParams(qs);
  const seen = sp.get("seenDays");
  const sort = sp.get("sort");
  return {
    mapEnd: sp.get("map") === "delivery" ? "delivery" : "pickup",
    pickupState: list(sp.get("pickupState")),
    deliveryState: list(sp.get("deliveryState")),
    minCf: sp.get("minCf") ?? "",
    maxCf: sp.get("maxCf") ?? "",
    unsized: sp.get("unsized") !== "0",
    ready: sp.get("readyOnly") === "1" ? "now" : sp.get("readyBy") ? "by" : "any",
    readyBy: sp.get("readyBy") ?? "",
    seenDays: seen === "1" || seen === "3" || seen === "7" ? seen : "",
    q: sp.get("q") ?? "",
    deliverBy: sp.get("deliverBy") ?? "",
    hasPrice: sp.get("hasPrice") === "1",
    showInactive: (sp.get("status") ?? "").split(",").includes("delisted"),
    review: sp.get("review") === "1",
    towardHome: sp.get("routeMode") === "corridor",
    sort: (sort as SortKey | null) ?? "",
  };
}

/**
 * Whether anything the Clear button owns is set. Sort is excluded on purpose:
 * Clear resets the search, not how the results are ordered, and neither does
 * it forget where the viewer is.
 */
export function isDefault(f: Filters): boolean {
  return (
    f.pickupState.length === 0 &&
    f.deliveryState.length === 0 &&
    !f.minCf &&
    !f.maxCf &&
    f.unsized &&
    f.ready === "any" &&
    !f.seenDays &&
    !f.q.trim() &&
    !f.deliverBy &&
    !f.hasPrice &&
    !f.showInactive &&
    !f.review &&
    !f.towardHome
  );
}

/**
 * Everything Clear resets, leaving sort alone -- and the map end with it. Clear
 * resets the search, not how the results are ordered or which end of the lane
 * the viewer is looking at.
 */
export function clearedFilters(f: Filters): Filters {
  return { ...EMPTY_FILTERS, sort: f.sort, mapEnd: f.mapEnd };
}

/** "No jobs from FL to NJ." — the empty state says what was actually asked. */
export function emptyStateTitle(f: Filters): string {
  const from = f.pickupState.map(tokenLabel).join(", ");
  const to = f.deliveryState.map(tokenLabel).join(", ");
  if (from && to) return `No jobs from ${from} to ${to}.`;
  if (from) return `No jobs out of ${from}.`;
  if (to) return `No jobs into ${to}.`;
  return "No jobs match this search.";
}

/** How many of the "More" items are set — the badge on that trigger. */
export function moreCount(f: Filters): number {
  return (
    (f.q.trim() ? 1 : 0) +
    (f.deliverBy ? 1 : 0) +
    (f.hasPrice ? 1 : 0) +
    (f.showInactive ? 1 : 0) +
    (f.review ? 1 : 0)
  );
}

/** How many controls are set at all — the mobile "Filters (2)" count. */
export function activeCount(f: Filters): number {
  return (
    (f.minCf || f.maxCf ? 1 : 0) +
    (f.unsized ? 0 : 1) +
    (f.ready === "any" ? 0 : 1) +
    (f.seenDays ? 1 : 0) +
    (f.towardHome ? 1 : 0) +
    moreCount(f)
  );
}

// --- the bar -----------------------------------------------------------------

export interface FilterBarProps {
  filters: Filters;
  onChange(next: Filters): void;
  current: StoredLocation | null;
  home: StoredLocation | null;
  isAdmin: boolean;
  /** < 768 px: two big From/To buttons plus a "Filters (n)" sheet. */
  mobile: boolean;
}

export function FilterBar({ filters, onChange, current, home, isAdmin, mobile }: FilterBarProps) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });

  // What a deferred write needs, read when it fires rather than captured when
  // it was scheduled, so a filter changed in the meantime is not undone.
  const live = useRef({ filters, onChange });
  live.current = { filters, onChange };

  // Search is debounced by 300 ms (C §2 item 7). Written straight into
  // `Filters` it cost a fresh 500-row query and a map re-fit per character,
  // six of each for "kearny". The draft lives here rather than in MorePanel,
  // which unmounts with the popover: closing it mid-word must still search.
  const [qDraft, setQDraft] = useState(filters.q);
  useEffect(() => setQDraft(filters.q), [filters.q]);
  useEffect(() => {
    if (qDraft === live.current.filters.q) return;
    const timer = setTimeout(
      () => live.current.onChange({ ...live.current.filters, q: qDraft }),
      300,
    );
    return () => clearTimeout(timer);
    // Only the draft may restart the timer; any other re-render restarting it
    // would postpone the search for as long as anything else is happening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDraft]);

  // A sort that needs a stored location must not outlive the location. The
  // option disappears from the select, which then reads "Auto", while
  // `sort=distance` is still sent and the server -- with no reference point --
  // falls back to insertion order. Same for a shared link that carries it.
  // Waiting for `hydrated` so a real stored location is not overruled by the
  // null that localStorage has not been read into yet.
  const { hydrated } = useViewerLocation();
  const sortOptions = SORT_OPTIONS.filter((o) => !o.needsViewer || current);
  const sortAvailable = sortOptions.some((o) => o.value === filters.sort);
  useEffect(() => {
    if (hydrated && !sortAvailable) live.current.onChange({ ...live.current.filters, sort: "" });
  }, [hydrated, sortAvailable]);

  const pickupGhost =
    current?.state && filters.pickupState.length === 0
      ? { text: `Near you: ${current.state}`, state: current.state }
      : null;
  const homeGhost =
    home?.state && filters.deliveryState.length === 0
      ? { text: `Home: ${home.state}`, state: home.state }
      : null;

  const swap = () =>
    set({ pickupState: filters.deliveryState, deliveryState: filters.pickupState });

  const swapButton = (
    <button
      type="button"
      className="btn btn-ghost"
      style={{ width: 36, padding: 0 }}
      title="Swap pickup and delivery"
      aria-label="Swap pickup and delivery"
      disabled={filters.pickupState.length === 0 && filters.deliveryState.length === 0}
      onClick={swap}
    >
      ⇄
    </button>
  );

  const sortSelect = (
    <label className="inline-flex items-center gap-[var(--sp-2)]">
      <span className="text-[var(--fs-sm)]" style={{ color: "var(--muted)" }}>
        Sort
      </span>
      <select
        className="field"
        style={{ width: "auto", minWidth: 150 }}
        value={sortAvailable ? filters.sort : ""}
        aria-label="Sort jobs"
        onChange={(e) => set({ sort: e.target.value as SortKey | "" })}
      >
        {sortOptions.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );

  const clearButton = !isDefault(filters) && (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={() => onChange(clearedFilters(filters))}
    >
      Clear
    </button>
  );

  if (mobile) {
    return (
      <div className="flex w-full items-center gap-[var(--sp-2)] overflow-x-auto px-[var(--sp-3)]">
        <MapEndToggle value={filters.mapEnd} onChange={(mapEnd) => set({ mapEnd })} />
        <StatePicker
          label="Pickup"
          value={filters.pickupState}
          onChange={(v) => set({ pickupState: v })}
          ghost={pickupGhost}
          fullScreen
        />
        {swapButton}
        <StatePicker
          label="Delivery"
          value={filters.deliveryState}
          onChange={(v) => set({ deliveryState: v })}
          ghost={homeGhost}
          fullScreen
        />
        <PopoverButton
          label={
            <>
              Filters
              {activeCount(filters) > 0 && (
                <span className="pill-chip">{activeCount(filters)}</span>
              )}
            </>
          }
          active={activeCount(filters) > 0}
          fullScreen
          panelTitle="Filters"
          ariaLabel="All filters"
        >
          {() => (
            <div className="flex flex-col gap-[var(--sp-4)]">
              <Section title="Size">
                <SizePanel filters={filters} set={set} />
              </Section>
              <Section title="Ready">
                <ReadyPanel filters={filters} set={set} />
              </Section>
              <Section title="Listed">
                <ListedPanel filters={filters} set={set} />
              </Section>
              <Section title="More">
                <MorePanel filters={filters} set={set} isAdmin={isAdmin} q={qDraft} onQ={setQDraft} />
              </Section>
              {current && home && (
                <Section title="Toward home">
                  <TowardHomeToggle filters={filters} set={set} />
                </Section>
              )}
              <Section title="Sort">{sortSelect}</Section>
              {!isDefault(filters) && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => onChange(clearedFilters(filters))}
                >
                  Clear all filters
                </button>
              )}
            </div>
          )}
        </PopoverButton>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-wrap items-center gap-[var(--sp-2)] px-[var(--sp-4)]">
      {/* The map end sits at the left edge, beside the two state pickers: it is
          the same question they answer -- which end of the lane am I looking
          at -- and putting it on the map itself would hide it under the pins. */}
      <MapEndToggle value={filters.mapEnd} onChange={(mapEnd) => set({ mapEnd })} />
      <StatePicker
        label="Pickup"
        value={filters.pickupState}
        onChange={(v) => set({ pickupState: v })}
        ghost={pickupGhost}
      />
      {swapButton}
      <StatePicker
        label="Delivery"
        value={filters.deliveryState}
        onChange={(v) => set({ deliveryState: v })}
        ghost={homeGhost}
      />

      <PopoverButton
        label={<>Size: {sizeLabel(filters)}</>}
        active={Boolean(filters.minCf || filters.maxCf || !filters.unsized)}
        width={320}
        ariaLabel="Filter by size"
      >
        {() => <SizePanel filters={filters} set={set} />}
      </PopoverButton>

      <PopoverButton
        label={<>Ready: {readyTriggerLabel(filters)}</>}
        active={filters.ready !== "any"}
        width={300}
        ariaLabel="Filter by ready date"
      >
        {() => <ReadyPanel filters={filters} set={set} />}
      </PopoverButton>

      <PopoverButton
        label={<>Listed: {seenTriggerLabel(filters)}</>}
        active={filters.seenDays !== ""}
        width={260}
        ariaLabel="Filter by how recently the job was listed"
      >
        {() => <ListedPanel filters={filters} set={set} />}
      </PopoverButton>

      <PopoverButton
        label={
          <>
            More
            {moreCount(filters) > 0 && <span className="pill-chip">{moreCount(filters)}</span>}
          </>
        }
        active={moreCount(filters) > 0}
        width={340}
        ariaLabel="More filters"
      >
        {() => <MorePanel filters={filters} set={set} isAdmin={isAdmin} q={qDraft} onQ={setQDraft} />}
      </PopoverButton>

      {current && home && <TowardHomeToggle filters={filters} set={set} />}

      {clearButton}

      <div className="ml-auto">{sortSelect}</div>
    </div>
  );
}

/* ------------------------------- the panels ------------------------------- */

/**
 * `Pickups | Deliveries` — what the map plots.
 *
 * Two words rather than an icon: "the map is showing delivery points" is not a
 * state anybody should have to infer from a colour, and a driver who misreads
 * it drives the wrong way.
 */
const MAP_END_OPTIONS: Array<{ value: MapEnd; label: string; title: string }> = [
  { value: "pickup", label: "Pickups", title: "Plot every job where it loads" },
  { value: "delivery", label: "Deliveries", title: "Plot every job where it delivers" },
];

function MapEndToggle({ value, onChange }: { value: MapEnd; onChange(v: MapEnd): void }) {
  return (
    <div className="seg" role="group" aria-label="Map points">
      {MAP_END_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          className="seg-option"
          data-on={value === o.value || undefined}
          aria-pressed={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label">{title}</div>
      {children}
    </div>
  );
}

function sizeLabel(f: Filters): string {
  if (!f.minCf && !f.maxCf) return f.unsized ? "Any" : "Sized only";
  if (f.minCf && f.maxCf) return `${Number(f.minCf).toLocaleString()}–${Number(f.maxCf).toLocaleString()} cf`;
  if (f.maxCf) return `≤ ${Number(f.maxCf).toLocaleString()} cf`;
  return `${Number(f.minCf).toLocaleString()}+ cf`;
}

function SizePanel({ filters, set }: { filters: Filters; set(p: Partial<Filters>): void }) {
  const matches = (min: number | null, max: number | null) =>
    filters.minCf === (min == null ? "" : String(min)) &&
    filters.maxCf === (max == null ? "" : String(max));

  return (
    <div className="flex flex-col gap-[var(--sp-3)]">
      <div className="flex flex-wrap gap-[var(--sp-1)]">
        <Segment on={!filters.minCf && !filters.maxCf} onClick={() => set({ minCf: "", maxCf: "" })}>
          Any
        </Segment>
        {CF_PRESETS.map((p) => (
          <Segment
            key={p.label}
            on={matches(p.min, p.max)}
            onClick={() =>
              set({ minCf: p.min == null ? "" : String(p.min), maxCf: p.max == null ? "" : String(p.max) })
            }
          >
            {p.label}
          </Segment>
        ))}
      </div>

      <div className="flex items-center gap-[var(--sp-2)]">
        <input
          className="field nums"
          type="number"
          min={0}
          step={50}
          placeholder="min"
          aria-label="Minimum cubic feet"
          value={filters.minCf}
          onChange={(e) => set({ minCf: e.target.value })}
        />
        <span style={{ color: "var(--muted)" }}>–</span>
        <input
          className="field nums"
          type="number"
          min={0}
          step={50}
          placeholder="max"
          aria-label="Maximum cubic feet"
          value={filters.maxCf}
          onChange={(e) => set({ maxCf: e.target.value })}
        />
        <span className="text-[var(--fs-sm)]" style={{ color: "var(--muted)" }}>
          cf
        </span>
      </div>

      {/* Plenty of real posts never state a size; hiding them by default would
          quietly drop a third of the board. */}
      <label className="flex items-center gap-[var(--sp-2)] text-[var(--fs-base)]">
        <input
          type="checkbox"
          checked={filters.unsized}
          onChange={(e) => set({ unsized: e.target.checked })}
        />
        Include jobs without a size
      </label>
    </div>
  );
}

function readyTriggerLabel(f: Filters): string {
  if (f.ready === "now") return "now";
  if (f.ready === "by" && f.readyBy) return `by ${f.readyBy.slice(5).replace("-", "/")}`;
  return "Any";
}

function ReadyPanel({ filters, set }: { filters: Filters; set(p: Partial<Filters>): void }) {
  return (
    <div className="flex flex-col gap-[var(--sp-2)]">
      {READY_OPTIONS.map((o) => (
        <label key={o.value} className="flex items-center gap-[var(--sp-2)]">
          <input
            type="radio"
            name="ready"
            checked={filters.ready === o.value}
            onChange={() => set({ ready: o.value, readyBy: o.value === "by" ? filters.readyBy : "" })}
          />
          {o.label}
        </label>
      ))}
      <input
        className="field"
        type="date"
        aria-label="Ready by date"
        disabled={filters.ready !== "by"}
        value={filters.readyBy}
        onChange={(e) => set({ ready: "by", readyBy: e.target.value })}
      />
    </div>
  );
}

function seenTriggerLabel(f: Filters): string {
  return SEEN_OPTIONS.find((o) => o.value === f.seenDays)?.label ?? "Any";
}

function ListedPanel({ filters, set }: { filters: Filters; set(p: Partial<Filters>): void }) {
  return (
    <div className="flex flex-col gap-[var(--sp-2)]">
      {SEEN_OPTIONS.map((o) => (
        <label key={o.value || "any"} className="flex items-center gap-[var(--sp-2)]">
          <input
            type="radio"
            name="seenDays"
            checked={filters.seenDays === o.value}
            onChange={() => set({ seenDays: o.value })}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

function MorePanel({
  filters,
  set,
  isAdmin,
  q,
  onQ,
}: {
  filters: Filters;
  set(p: Partial<Filters>): void;
  isAdmin: boolean;
  /** The debounced draft, owned by FilterBar so it survives this panel closing. */
  q: string;
  onQ(v: string): void;
}) {
  return (
    <div className="flex flex-col gap-[var(--sp-3)]">
      <div>
        <label className="label" htmlFor="filter-q">
          Search
        </label>
        <input
          id="filter-q"
          className="field"
          placeholder="City, ZIP, note, requirement, sender"
          value={q}
          onChange={(e) => onQ(e.target.value)}
        />
      </div>

      <div>
        <label className="label" htmlFor="filter-deliverby">
          Deliver by
        </label>
        <input
          id="filter-deliverby"
          className="field"
          type="date"
          value={filters.deliverBy}
          onChange={(e) => set({ deliverBy: e.target.value })}
        />
      </div>

      <label className="flex items-center gap-[var(--sp-2)]">
        <input
          type="checkbox"
          checked={filters.hasPrice}
          onChange={(e) => set({ hasPrice: e.target.checked })}
        />
        Has a price
      </label>

      <label className="flex items-center gap-[var(--sp-2)]">
        <input
          type="checkbox"
          checked={filters.showInactive}
          onChange={(e) => set({ showInactive: e.target.checked })}
        />
        Show delisted, taken and expired
      </label>

      {isAdmin && (
        <label className="flex items-center gap-[var(--sp-2)]">
          <input
            type="checkbox"
            checked={filters.review}
            onChange={(e) => set({ review: e.target.checked })}
          />
          Needs review
        </label>
      )}
    </div>
  );
}

function TowardHomeToggle({
  filters,
  set,
}: {
  filters: Filters;
  set(p: Partial<Filters>): void;
}) {
  return (
    <button
      type="button"
      className="pill"
      data-active={filters.towardHome || undefined}
      aria-pressed={filters.towardHome}
      title="Only jobs inside a 100-mile corridor between where you are and home"
      onClick={() => set({ towardHome: !filters.towardHome })}
    >
      ⇄ Toward home{filters.towardHome ? ` ±${CORRIDOR_MILES} mi` : ""}
    </button>
  );
}

function Segment({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="chip"
      aria-pressed={on}
      onClick={onClick}
      style={{
        height: 28,
        cursor: "pointer",
        background: on ? "var(--accent-soft)" : "var(--surface-2)",
        color: on ? "var(--accent)" : "var(--text-2)",
      }}
    >
      {children}
    </button>
  );
}

/** The one-line explanation the empty state shows under its title. */
export const LIFECYCLE_NOTE =
  "Senders re-post daily; jobs disappear when a sender's latest post no longer lists them.";

/** Chips the empty state offers, given what is currently set. */
export function emptyStateSuggestions(
  f: Filters,
): Array<{ label: string; next: Filters }> {
  const out: Array<{ label: string; next: Filters }> = [];
  if (f.deliveryState.length > 0 && !f.deliveryState.includes("tristate")) {
    const extra = ["NY", "PA"].filter((s) => !f.deliveryState.includes(s));
    if (extra.length) {
      out.push({
        label: `+ ${extra.join(", ")}`,
        next: { ...f, deliveryState: [...f.deliveryState, ...extra] },
      });
    }
  }
  if (f.ready !== "any") out.push({ label: "Any ready date", next: { ...f, ready: "any", readyBy: "" } });
  if (f.minCf || f.maxCf || !f.unsized) {
    out.push({ label: "Any size", next: { ...f, minCf: "", maxCf: "", unsized: true } });
  }
  if (!f.showInactive) {
    out.push({ label: "Include recently delisted", next: { ...f, showInactive: true } });
  }
  return out;
}

/** Memo-friendly hook so Board does not rebuild the query string on every render. */
export function useFilterQuery(
  filters: Filters,
  ctx: { current: StoredLocation | null; home: StoredLocation | null; bounds?: BoundsInput | null },
): { visible: string; fetch: string } {
  const { current, home, bounds } = ctx;
  return useMemo(() => {
    const visible = filtersToQuery(filters, { current: null, home: null });
    const full = filtersToQuery(filters, { current, home, bounds });
    return { visible, fetch: full ? `${full}&limit=500` : "limit=500" };
  }, [filters, current, home, bounds]);
}
