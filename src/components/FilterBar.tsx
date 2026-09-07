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
 * so a shared link never carries where somebody was standing. A place the
 * viewer *typed* is a different thing -- it is the search itself -- so those
 * coordinates do travel.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { BoundsInput, MapEnd, SortKey } from "@/lib/loads/types";
import type { StoredLocation } from "@/lib/location";
import { homeQuery, useViewerLocation, viewerQuery } from "@/lib/location";
import { api } from "@/lib/basePath";
import { CORRIDOR_OPTIONS, RADIUS_OPTIONS } from "@/lib/loads/constants";
import { CF_PRESETS, READY_OPTIONS, SEEN_OPTIONS, SORT_OPTIONS } from "@/lib/loads/present";
import { StatePanel, StatePicker, tokenLabel } from "./StatePicker";
import { LocationInput, type ResolvedPlace } from "./LocationInput";
import { PopoverButton } from "./ui";

/**
 * A place the viewer typed into a route control.
 *
 * `lat`/`lng` are nullable because a hand-written URL may carry `origin=Newark,
 * NJ` with no coordinates at all; the server geocodes that itself. `precision`
 * is what stops "Florida" being presented as a pin -- see `RouteWarning`.
 */
export interface RoutePlace {
  label: string;
  lat: number | null;
  lng: number | null;
  /** address | zip | city | state | region, from the geocoder. */
  precision: string | null;
  state: string | null;
  /** What an exact "this city only" match would be pinned to, when there is one. */
  city: string | null;
  zip: string | null;
}

/** "" no route search · "radius" point(s) and a radius · "corridor" along a line. */
export type RouteMode = "" | "radius" | "corridor";

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
  /** `pickupZip` — a 5-digit code, or a prefix ("070" is north Jersey). */
  pickupZip: string;
  deliveryState: string[];
  deliveryZip: string;
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
  /** Route search. In corridor mode a null end means "use my stored location". */
  routeMode: RouteMode;
  origin: RoutePlace | null;
  radius: string;
  dest: RoutePlace | null;
  destRadius: string;
  corridor: string;
  sort: SortKey | "";
}

export const EMPTY_FILTERS: Filters = {
  // A mover with an empty truck is asking "what can I collect near me", so the
  // map opens on the loading end.
  mapEnd: "pickup",
  pickupState: [],
  pickupZip: "",
  deliveryState: [],
  deliveryZip: "",
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
  routeMode: "",
  origin: null,
  radius: "",
  dest: null,
  destRadius: "",
  corridor: "",
  sort: "",
};

/** What "Show delisted / taken / expired" asks the server for. */
const INACTIVE_STATUSES = "available,delisted,pending,taken,expired";

/** The corridor width the Toward-home shortcut starts at. */
const CORRIDOR_MILES = 100;

/** The radius a freshly picked place gets, so the control always filters something. */
const DEFAULT_RADIUS = 50;

/**
 * The radius select's non-numeric option: `pickupCity` / `deliveryCity`, an
 * exact match on the column rather than a circle around a point.
 */
const EXACT = "city";

/**
 * Both route searches are straight-line geometry -- cross-track distance and
 * haversine, never a road network. Every number they produce is labelled with
 * this, because "38 mi off your route" read as road miles is a wrong turn.
 */
const STRAIGHT_LINE_NOTE =
  "Straight-line distance, not driving distance — the board has no road network to measure against.";

// --- Filters <-> query -------------------------------------------------------

function list(v: string | null): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const round5 = (n: number) => String(Math.round(n * 1e5) / 1e5);

/** A stored slot, in the shape the route controls speak. */
function placeFromStored(s: StoredLocation | null): RoutePlace | null {
  return s
    ? { label: s.label, lat: s.lat, lng: s.lng, precision: s.precision, state: s.state, city: null, zip: null }
    : null;
}

/**
 * The two ends a corridor search will actually use: what was typed, or -- when
 * nothing was -- the viewer's own stored slots. Either may still be null, and
 * the panel says so rather than letting the server quietly ignore the search.
 */
export function routeEnds(
  f: Filters,
  ctx: { current: StoredLocation | null; home: StoredLocation | null },
): { start: RoutePlace | null; end: RoutePlace | null } {
  if (f.routeMode !== "corridor") return { start: f.origin, end: f.dest };
  return {
    start: f.origin ?? placeFromStored(ctx.current),
    end: f.dest ?? placeFromStored(ctx.home),
  };
}

/**
 * The Toward-home shortcut: a corridor whose two ends are the stored slots
 * rather than typed places. The map draws that one itself, so it stays a
 * distinguishable state rather than a flag of its own.
 */
export function isTowardHome(f: Filters): boolean {
  return f.routeMode === "corridor" && !f.origin && !f.dest;
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
  if (f.pickupZip) sp.set("pickupZip", f.pickupZip);
  if (f.deliveryState.length) sp.set("deliveryState", f.deliveryState.join(","));
  if (f.deliveryZip) sp.set("deliveryZip", f.deliveryZip);
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

  // A typed place is the search and belongs in the shareable URL, coordinates
  // and all. A *stored* slot is not: it is where somebody was standing, so it
  // is added only for the API request, exactly as viewerLat/viewerLng are.
  const writePoint = (place: RoutePlace, textKey: string, latKey: string, lngKey: string) => {
    if (place.label) sp.set(textKey, place.label);
    if (place.lat != null && place.lng != null) {
      sp.set(latKey, round5(place.lat));
      sp.set(lngKey, round5(place.lng));
    }
  };

  if (f.routeMode === "corridor") {
    // The corridor keeps its shape in the shareable URL even when its ends are
    // the viewer's own coordinates: the link then means "along MY way home",
    // which is what the person receiving it wants it to mean.
    sp.set("routeMode", "corridor");
    sp.set("corridor", f.corridor || String(CORRIDOR_MILES));
    if (f.origin) writePoint(f.origin, "origin", "originLat", "originLng");
    else if (ctx.current) {
      sp.set("originLat", round5(ctx.current.lat));
      sp.set("originLng", round5(ctx.current.lng));
    }
    if (f.dest) writePoint(f.dest, "dest", "destLat", "destLng");
    else for (const [k, v] of new URLSearchParams(homeQuery(ctx.home))) sp.set(k, v);
  } else if (f.routeMode === "radius") {
    // "This city only" is `pickupCity`, an exact column match -- not a tiny
    // circle. It is emitted ALONE, with no `origin`, so a link carrying it
    // round-trips to exactly the search it describes and does not quietly
    // acquire a distance sort the URL never asked for.
    if (f.origin) {
      if (f.radius === EXACT && f.origin.city) sp.set("pickupCity", f.origin.city);
      else {
        writePoint(f.origin, "origin", "originLat", "originLng");
        sp.set("radius", f.radius === EXACT || !f.radius ? String(DEFAULT_RADIUS) : f.radius);
      }
    }
    if (f.dest) {
      if (f.destRadius === EXACT && f.dest.city) sp.set("deliveryCity", f.dest.city);
      else {
        writePoint(f.dest, "dest", "destLat", "destLng");
        sp.set(
          "destRadius",
          f.destRadius === EXACT || !f.destRadius ? String(DEFAULT_RADIUS) : f.destRadius,
        );
      }
    }
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

function readPlace(
  sp: URLSearchParams,
  textKey: string,
  latKey: string,
  lngKey: string,
): RoutePlace | null {
  const label = sp.get(textKey)?.trim() ?? "";
  const lat = Number(sp.get(latKey));
  const lng = Number(sp.get(lngKey));
  const hasPoint = sp.has(latKey) && sp.has(lngKey) && Number.isFinite(lat) && Number.isFinite(lng);
  // A point with no label is a *stored* slot round-tripping through the fetch
  // query, not something anybody typed. Only a labelled place is a filter.
  if (!label) return null;
  return {
    label,
    lat: hasPoint ? lat : null,
    lng: hasPoint ? lng : null,
    precision: null,
    state: null,
    city: null,
    zip: null,
  };
}

/** A bare `pickupCity=Kearny` in a hand-written URL is still a place. */
function cityPlace(city: string | null): RoutePlace | null {
  return city ? { label: city, lat: null, lng: null, precision: "city", state: null, city, zip: null } : null;
}

/** Read a query string back into `Filters`. Unknown keys are ignored. */
export function hydrate(qs: string): Filters {
  const sp = new URLSearchParams(qs);
  const seen = sp.get("seenDays");
  const sort = sp.get("sort");
  const pickupCity = sp.get("pickupCity")?.trim() || null;
  const deliveryCity = sp.get("deliveryCity")?.trim() || null;
  const origin = readPlace(sp, "origin", "originLat", "originLng") ?? cityPlace(pickupCity);
  const dest = readPlace(sp, "dest", "destLat", "destLng") ?? cityPlace(deliveryCity);
  const radius = sp.get("radius") ?? (pickupCity ? EXACT : "");
  const destRadius = sp.get("destRadius") ?? (deliveryCity ? EXACT : "");
  const routeMode: RouteMode =
    sp.get("routeMode") === "corridor"
      ? "corridor"
      : (origin && radius) || (dest && destRadius)
        ? "radius"
        : "";
  return {
    mapEnd: sp.get("map") === "delivery" ? "delivery" : "pickup",
    pickupState: list(sp.get("pickupState")),
    pickupZip: (sp.get("pickupZip") ?? "").replace(/\D/g, "").slice(0, 5),
    deliveryState: list(sp.get("deliveryState")),
    deliveryZip: (sp.get("deliveryZip") ?? "").replace(/\D/g, "").slice(0, 5),
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
    routeMode,
    origin: routeMode ? origin : null,
    radius,
    dest: routeMode ? dest : null,
    destRadius,
    corridor: sp.get("corridor") ?? "",
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
    !f.pickupZip &&
    !f.deliveryZip &&
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
    !f.routeMode
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

/** "50 mi of Newark, NJ" / "Miami, FL → Newark, NJ" — how a route reads in prose. */
export function routePhrase(
  f: Filters,
  ctx: { current: StoredLocation | null; home: StoredLocation | null },
): string | null {
  if (f.routeMode === "corridor") {
    const { start, end } = routeEnds(f, ctx);
    if (!start || !end) return null;
    return `${start.label} → ${end.label}`;
  }
  if (f.routeMode === "radius") {
    const legs: string[] = [];
    if (f.origin) legs.push(radiusPhrase(f.origin, f.radius, "pickup"));
    if (f.dest) legs.push(radiusPhrase(f.dest, f.destRadius, "delivery"));
    return legs.length ? legs.join(", ") : null;
  }
  return null;
}

/** "50 mi of Newark, NJ" / "the city of Kearny" — one end of a radius search. */
function radiusPhrase(place: RoutePlace, radius: string, end: "pickup" | "delivery"): string {
  const where = end === "pickup" ? "pickup" : "delivery";
  if (radius === EXACT && place.city) return `${where} in ${place.city}`;
  return `${where} within ${radius === EXACT || !radius ? DEFAULT_RADIUS : radius} mi of ${place.label}`;
}

/** "No jobs from FL to NJ." — the empty state says what was actually asked. */
export function emptyStateTitle(f: Filters): string {
  if (f.routeMode === "corridor") {
    const route = f.origin && f.dest ? ` along ${f.origin.label} → ${f.dest.label}` : " along your route";
    return `No jobs${route}.`;
  }
  if (f.routeMode === "radius" && (f.origin || f.dest)) {
    const phrase = f.origin
      ? radiusPhrase(f.origin, f.radius, "pickup")
      : radiusPhrase(f.dest!, f.destRadius, "delivery");
    return `No jobs with ${phrase}.`;
  }
  const from = f.pickupState.map(tokenLabel).join(", ");
  const to = f.deliveryState.map(tokenLabel).join(", ");
  if (from && to) return `No jobs from ${from} to ${to}.`;
  if (from) return `No jobs out of ${from}.`;
  if (to) return `No jobs into ${to}.`;
  return "No jobs match this search.";
}

/**
 * A search that cannot match anything, and why.
 *
 * `minCf=1000&maxCf=100` used to fall through to "No jobs match this search",
 * which reads as an answer about the freight when it is an answer about the
 * form. The distinction matters on a board whose whole claim is that it does
 * not invent: "nothing is out there" and "you asked for nothing" are different
 * statements.
 */
export function filterConflict(
  f: Filters,
): { title: string; hint: string; fix: { label: string; next: Filters } } | null {
  const min = Number(f.minCf);
  const max = Number(f.maxCf);
  if (f.minCf && f.maxCf && Number.isFinite(min) && Number.isFinite(max) && min > max) {
    return {
      title: "That size range is backwards.",
      hint:
        `The smallest you asked for (${min.toLocaleString()} cf) is bigger than the largest ` +
        `(${max.toLocaleString()} cf), so no job of any size can match. This is the form, not the board.`,
      fix: {
        label: `Use ${max.toLocaleString()}–${min.toLocaleString()} cf`,
        next: { ...f, minCf: f.maxCf, maxCf: f.minCf },
      },
    };
  }
  return null;
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
    (f.routeMode ? 1 : 0) +
    moreCount(f)
  );
}

/* ----------------------------- active chips ------------------------------ */

export interface FilterChip {
  key: string;
  label: string;
  title?: string;
  next: Filters;
}

/**
 * Every filter currently narrowing the board, each one removable.
 *
 * The pills say what a control is set to only while you can see the control;
 * on a phone most of them live inside a sheet, so a driver looking at eleven
 * results had no way to see -- let alone undo -- the four things that got them
 * there.
 */
export function activeFilterChips(
  f: Filters,
  ctx: { current: StoredLocation | null; home: StoredLocation | null },
): FilterChip[] {
  const out: FilterChip[] = [];
  const add = (key: string, label: string, next: Filters, title?: string) =>
    out.push({ key, label, next, title });

  for (const token of f.pickupState) {
    add(`pickup:${token}`, `From ${tokenLabel(token)}`, {
      ...f,
      pickupState: f.pickupState.filter((t) => t !== token),
    });
  }
  if (f.pickupZip) {
    add(
      "pickupZip",
      `From ZIP ${f.pickupZip}${f.pickupZip.length < 5 ? "…" : ""}`,
      { ...f, pickupZip: "" },
      "Jobs whose post gave no ZIP are left out by this filter",
    );
  }
  for (const token of f.deliveryState) {
    add(`delivery:${token}`, `To ${tokenLabel(token)}`, {
      ...f,
      deliveryState: f.deliveryState.filter((t) => t !== token),
    });
  }
  if (f.deliveryZip) {
    add(
      "deliveryZip",
      `To ZIP ${f.deliveryZip}${f.deliveryZip.length < 5 ? "…" : ""}`,
      { ...f, deliveryZip: "" },
      "Jobs whose post gave no ZIP are left out by this filter",
    );
  }

  if (f.routeMode) {
    const phrase = routePhrase(f, ctx);
    add(
      "route",
      f.routeMode === "corridor"
        ? `Along ${phrase ?? "your route"} ±${f.corridor || CORRIDOR_MILES} mi`
        : (phrase ?? "Somewhere in particular"),
      { ...f, routeMode: "", origin: null, dest: null },
      STRAIGHT_LINE_NOTE,
    );
  }

  if (f.minCf || f.maxCf) {
    add("size", `Size ${sizeLabel({ ...f, unsized: true })}`, { ...f, minCf: "", maxCf: "" });
  }
  if (!f.unsized) {
    add("unsized", "Sized jobs only", { ...f, unsized: true }, "Jobs whose post never stated a size are hidden");
  }
  if (f.ready !== "any") {
    add("ready", `Ready ${readyTriggerLabel(f)}`, { ...f, ready: "any", readyBy: "" });
  }
  if (f.seenDays) {
    add("seen", `Listed ${seenTriggerLabel(f).toLowerCase()}`, { ...f, seenDays: "" });
  }
  if (f.q.trim()) add("q", `“${f.q.trim()}”`, { ...f, q: "" });
  if (f.deliverBy) add("deliverBy", `Deliver by ${f.deliverBy}`, { ...f, deliverBy: "" });
  if (f.hasPrice) add("hasPrice", "Has a price", { ...f, hasPrice: false });
  if (f.showInactive) {
    add("showInactive", "Including delisted", { ...f, showInactive: false });
  }
  if (f.review) add("review", "Needs review", { ...f, review: false });
  return out;
}

function ActiveChips({
  filters,
  onChange,
  current,
  home,
}: {
  filters: Filters;
  onChange(next: Filters): void;
  current: StoredLocation | null;
  home: StoredLocation | null;
}) {
  const chips = activeFilterChips(filters, { current, home });
  if (chips.length === 0) return null;
  return (
    <div
      className="flex w-full flex-wrap items-center gap-[var(--sp-1)] px-[var(--sp-3)] pt-[var(--sp-2)] sm:px-[var(--sp-4)]"
      aria-label="Active filters"
    >
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          className="chip chip-accent chip-button"
          title={c.title ?? `Remove: ${c.label}`}
          aria-label={`Remove filter: ${c.label}`}
          onClick={() => onChange(c.next)}
        >
          <span className="max-w-[38ch] truncate">{c.label}</span>
          <span aria-hidden>✕</span>
        </button>
      ))}
      {/* A chip, not a button: on a phone every control in this row is 44 px
          tall for a thumb, and a `btn` among them was a taller, wider shape
          that pushed the wrap one item earlier than it had to. */}
      <button
        type="button"
        className="chip chip-muted chip-button"
        title="Remove every filter. Sort and map end are left alone."
        onClick={() => onChange(clearedFilters(filters))}
      >
        Clear all
      </button>
    </div>
  );
}

// --- the bar -----------------------------------------------------------------

/**
 * What the current results actually contain, for the controls that would
 * otherwise lie about themselves. Only `deliverBy` needs it today: the filter
 * and the sort are both wired correctly, and both are inert because no job in
 * the corpus carries a deadline.
 */
export interface ResultStats {
  /** Rows on the board right now. */
  count: number;
  /** How many of them state a deliver-by date. */
  withDeliverBy: number;
  /** How many carry a ZIP on each end -- pickups usually do not. */
  withPickupZip: number;
  withDeliveryZip: number;
  loading: boolean;
}

/**
 * How much of the board a ZIP filter can even see.
 *
 * 84 of 98 jobs give a pickup city and no pickup ZIP, so "pickup ZIP 070"
 * returning nothing is a fact about the posts, not about north Jersey. The
 * control says which.
 */
function ZipCoverageNote({ stats, end }: { stats?: ResultStats; end: "pickup" | "delivery" }) {
  const have = end === "pickup" ? stats?.withPickupZip : stats?.withDeliveryZip;
  const noun = end === "pickup" ? "pickup" : "delivery";
  if (!stats || stats.loading || stats.count === 0 || have == null) {
    return (
      <p className="mt-[5px] text-(length:--fs-xs)" style={{ color: "var(--muted)" }}>
        Jobs whose post gave no {noun} ZIP are left out by this filter.
      </p>
    );
  }
  if (have === 0) {
    return (
      <p className="mt-[5px] text-(length:--fs-xs)" style={{ color: "var(--warn)" }} role="status">
        None of the {stats.count.toLocaleString()} jobs on the board gives a {noun} ZIP, so this
        filter can only return nothing. Use the state grid above instead.
      </p>
    );
  }
  return (
    <p className="mt-[5px] text-(length:--fs-xs)" style={{ color: "var(--muted)" }}>
      {have.toLocaleString()} of the {stats.count.toLocaleString()} jobs on the board give a {noun}{" "}
      ZIP; the other {(stats.count - have).toLocaleString()} gave a city only, and{" "}
      {stats.count - have === 1 ? "it is" : "they are"} left out by this filter.
    </p>
  );
}

export interface FilterBarProps {
  filters: Filters;
  onChange(next: Filters): void;
  current: StoredLocation | null;
  home: StoredLocation | null;
  isAdmin: boolean;
  /**
   * One row -- a Lane pill and a "Filters (n)" sheet holding the rest --
   * instead of the full bar. True on a phone, and also on any screen too short
   * to spend two rows on filters: a phone lying down is 390 px tall, and the
   * full bar was taking 119 of them.
   */
  compact: boolean;
  stats?: ResultStats;
}

export function FilterBar({
  filters,
  onChange,
  current,
  home,
  isAdmin,
  compact,
  stats,
}: FilterBarProps) {
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
  // option disappears from the list, which then reads "Auto", while
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
    set({
      pickupState: filters.deliveryState,
      deliveryState: filters.pickupState,
      pickupZip: filters.deliveryZip,
      deliveryZip: filters.pickupZip,
    });

  const swapButton = (
    <button
      type="button"
      /* Square, and as wide as it is tall. `width: 36` on a flex item inside the
         phone's horizontal scroller rendered it 14 px wide, because nothing
         stopped it shrinking. */
      className="btn btn-ghost btn-square shrink-0"
      title="Swap pickup and delivery"
      aria-label="Swap pickup and delivery"
      disabled={isDefaultLane(filters)}
      onClick={swap}
    >
      ⇄
    </button>
  );

  const sortTrigger = (
    <PopoverButton
      label={<>Sort: {sortOptions.find((o) => o.value === (sortAvailable ? filters.sort : ""))?.label}</>}
      width={320}
      ariaLabel="Sort jobs"
      panelTitle="Sort"
      fullScreen={false}
    >
      {(close) => (
        <SortPanel
          value={sortAvailable ? filters.sort : ""}
          options={sortOptions}
          stats={stats}
          onPick={(v) => {
            set({ sort: v });
            close();
          }}
        />
      )}
    </PopoverButton>
  );

  const routeTrigger = (
    <PopoverButton
      label={<>Route: {routeTriggerLabel(filters, { current, home })}</>}
      active={filters.routeMode !== ""}
      width={360}
      fullScreen={compact}
      panelTitle="Route"
      ariaLabel="Search along a route or near a place"
    >
      {() => (
        <RoutePanel filters={filters} set={set} current={current} home={home} />
      )}
    </PopoverButton>
  );

  if (compact) {
    return (
      <div className="flex w-full flex-col">
        {/* One pill for the lane, one for everything else, and nothing that
            scrolls sideways.

            What was here scrolled five controls through a 294 px window at
            390 px: the Delivery picker started at x = 362 and was, in practice,
            invisible (§5.2). A driver could set a pickup state and never learn
            that the other half of a backhaul board existed. Both ends are now
            named on the face of one pill -- "Any → Any" -- and both panels are
            stacked inside it, so the delivery filter cannot be missed. */}
        <div className="flex w-full items-center gap-[var(--sp-2)] px-[var(--sp-3)]">
          <LanePill
            filters={filters}
            set={set}
            pickupGhost={pickupGhost}
            homeGhost={homeGhost}
            onSwap={swap}
            stats={stats}
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
            triggerClassName="pill shrink-0"
            fullScreen
            panelTitle="Filters"
            ariaLabel="All filters"
            doneLabel={showJobsLabel(stats)}
          >
            {() => (
              <div className="flex flex-col gap-[var(--sp-4)]">
                <Section title="Route">
                  <RoutePanel filters={filters} set={set} current={current} home={home} />
                </Section>
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
                  <MorePanel
                    filters={filters}
                    set={set}
                    isAdmin={isAdmin}
                    q={qDraft}
                    onQ={setQDraft}
                    stats={stats}
                  />
                </Section>
                <Section title="Sort">
                  <SortPanel
                    value={sortAvailable ? filters.sort : ""}
                    options={sortOptions}
                    stats={stats}
                    onPick={(v) => set({ sort: v })}
                  />
                </Section>
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
        <ActiveChips filters={filters} onChange={onChange} current={current} home={home} />
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col">
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
          zip={filters.pickupZip}
          onZip={(v) => set({ pickupZip: v })}
          zipNote={<ZipCoverageNote stats={stats} end="pickup" />}
        />
        {swapButton}
        <StatePicker
          label="Delivery"
          value={filters.deliveryState}
          onChange={(v) => set({ deliveryState: v })}
          ghost={homeGhost}
          zip={filters.deliveryZip}
          onZip={(v) => set({ deliveryZip: v })}
          zipNote={<ZipCoverageNote stats={stats} end="delivery" />}
        />

        {routeTrigger}

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
          {() => (
            <MorePanel
              filters={filters}
              set={set}
              isAdmin={isAdmin}
              q={qDraft}
              onQ={setQDraft}
              stats={stats}
            />
          )}
        </PopoverButton>

        {current && home && <TowardHomeToggle filters={filters} set={set} />}

        {/* No "Clear" pill here any more. It appeared under exactly the
            condition the chip row does, and the row's own "Clear all" sits
            beside the individual chips it undoes -- two buttons a row apart
            doing the same thing was one too many. */}

        <div className="ml-auto">{sortTrigger}</div>
      </div>
      <ActiveChips filters={filters} onChange={onChange} current={current} home={home} />
    </div>
  );
}

/** "Show 42 jobs" — what the sheet's close button is actually going to do. */
function showJobsLabel(stats?: ResultStats): string {
  if (!stats || stats.loading) return "Show jobs";
  return `Show ${stats.count.toLocaleString()} ${stats.count === 1 ? "job" : "jobs"}`;
}

/* ------------------------------- the lane --------------------------------- */

/**
 * Both ends of the lane on one pill, for the phone bar.
 *
 * The face reads "Any → Any", so the delivery half of a backhaul search is
 * stated before anything is opened; the sheet behind it stacks the two state
 * panels with the swap between them.
 */
function LanePill({
  filters,
  set,
  pickupGhost,
  homeGhost,
  onSwap,
  stats,
}: {
  filters: Filters;
  set(p: Partial<Filters>): void;
  pickupGhost: { text: string; state: string } | null;
  homeGhost: { text: string; state: string } | null;
  onSwap(): void;
  stats?: ResultStats;
}) {
  const from = laneEndLabel(filters.pickupState, filters.pickupZip);
  const to = laneEndLabel(filters.deliveryState, filters.deliveryZip);
  const active = !isDefaultLane(filters);

  return (
    <span className="flex min-w-0 flex-1">
      <PopoverButton
        label={
          <span className="flex min-w-0 items-center gap-[6px]">
            <span className="shrink-0" style={{ color: "var(--muted)" }}>
              Lane
            </span>
            <span className="min-w-0 truncate">
              <span style={{ color: active ? "var(--text)" : "var(--placeholder)" }}>{from}</span>
              <span aria-hidden style={{ color: "var(--muted-2)" }}>
                {" → "}
              </span>
              <span style={{ color: active ? "var(--text)" : "var(--placeholder)" }}>{to}</span>
            </span>
            <span aria-hidden className="shrink-0" style={{ color: "var(--muted-2)" }}>
              ▾
            </span>
          </span>
        }
        active={active}
        triggerClassName="pill w-full min-w-0"
        fullScreen
        panelTitle="Lane"
        doneLabel={showJobsLabel(stats)}
        ariaLabel={`Lane: ${from} to ${to}`}
      >
        {() => (
          <LaneSheet
            filters={filters}
            set={set}
            pickupGhost={pickupGhost}
            homeGhost={homeGhost}
            onSwap={onSwap}
            stats={stats}
          />
        )}
      </PopoverButton>
    </span>
  );
}

/**
 * The lane sheet: both ends named at the top, one grid open at a time.
 *
 * Stacking the two state panels put "Delivery state" 730 px down a 844 px
 * sheet -- better than the scroller that hid it completely, but still below the
 * fold. A tab that reads "Delivery · Any" states the filter exists and what it
 * is currently set to without anybody scrolling to find out, which is the whole
 * point of the fix.
 */
function LaneSheet({
  filters,
  set,
  pickupGhost,
  homeGhost,
  onSwap,
  stats,
}: {
  filters: Filters;
  set(p: Partial<Filters>): void;
  pickupGhost: { text: string; state: string } | null;
  homeGhost: { text: string; state: string } | null;
  onSwap(): void;
  stats?: ResultStats;
}) {
  const [end, setEnd] = useState<"pickup" | "delivery">("pickup");
  const tabId = useId();
  const selected = end === "pickup" ? filters.pickupState : filters.deliveryState;
  const key = end === "pickup" ? "pickupState" : "deliveryState";
  const zipKey = end === "pickup" ? "pickupZip" : "deliveryZip";
  const ghost = end === "pickup" ? pickupGhost : homeGhost;

  return (
    <div className="flex flex-col gap-[var(--sp-3)]">
      <div className="seg" style={{ display: "flex", width: "100%" }} role="tablist" aria-label="Lane end">
        {(["pickup", "delivery"] as const).map((e) => (
          <button
            key={e}
            id={`${tabId}-${e}`}
            type="button"
            role="tab"
            className="seg-option min-w-0 flex-1 justify-center truncate"
            data-on={end === e || undefined}
            aria-selected={end === e}
            aria-controls={`${tabId}-panel`}
            onClick={() => setEnd(e)}
          >
            {e === "pickup" ? "Pickup" : "Delivery"} ·{" "}
            {e === "pickup"
              ? laneEndLabel(filters.pickupState, filters.pickupZip)
              : laneEndLabel(filters.deliveryState, filters.deliveryZip)}
          </button>
        ))}
      </div>

      <div id={`${tabId}-panel`} role="tabpanel" aria-labelledby={`${tabId}-${end}`}>
        {ghost && selected.length === 0 && (
          <GhostButton text={ghost.text} onClick={() => set({ [key]: [ghost.state] })} />
        )}

        <StatePanel
          selected={selected}
          onToggle={(t) =>
            set({
              [key]: selected.includes(t) ? selected.filter((x) => x !== t) : [...selected, t],
            })
          }
          onClear={() => set({ [key]: [] })}
          zip={filters[zipKey]}
          onZip={(v) => set({ [zipKey]: v })}
          zipLabel={end === "pickup" ? "Pickup ZIP" : "Delivery ZIP"}
          zipNote={<ZipCoverageNote stats={stats} end={end} />}
        />
      </div>

      <button type="button" className="btn self-start" disabled={isDefaultLane(filters)} onClick={onSwap}>
        ⇄ Swap pickup and delivery
      </button>

      {/* The map end travels with the pickers rather than staying in the bar:
          it answers the same question they do -- which end of the lane am I
          looking at -- and at 390 px the segmented control alone was 168 of the
          row's 290 usable pixels. */}
      <Section title="Map points">
        <MapEndToggle value={filters.mapEnd} onChange={(mapEnd) => set({ mapEnd })} />
      </Section>
    </div>
  );
}

/** Nothing is set on either end of the lane. */
function isDefaultLane(f: Filters): boolean {
  return (
    f.pickupState.length === 0 &&
    f.deliveryState.length === 0 &&
    !f.pickupZip &&
    !f.deliveryZip
  );
}

/** "Any" / "FL" / "FL +2" / "07032" — one end of the lane, short enough for a pill. */
function laneEndLabel(tokens: string[], zip = ""): string {
  const parts: string[] = [];
  if (tokens.length) {
    const head = tokenLabel(tokens[0]).replace(" Area", "");
    parts.push(tokens.length > 1 ? `${head} +${tokens.length - 1}` : head);
  }
  if (zip) parts.push(zip);
  return parts.length ? parts.join(" ") : "Any";
}

function GhostButton({ text, onClick }: { text: string; onClick(): void }) {
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm mb-[var(--sp-2)]"
      style={{ color: "var(--accent)" }}
      onClick={onClick}
    >
      {text}
    </button>
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
    <div className="seg shrink-0" role="group" aria-label="Map points">
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

  const conflict = filterConflict(filters);

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
        <span className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
          cf
        </span>
      </div>

      {/* Said at the control, not only in the empty state: by the time a driver
          reads "no jobs match", they are looking for freight that is missing
          rather than a number they typed backwards. */}
      {conflict && (
        <p className="text-(length:--fs-sm)" style={{ color: "var(--warn)" }} role="alert">
          {conflict.title} {conflict.hint}{" "}
          <button
            type="button"
            className="btn btn-sm mt-[var(--sp-1)]"
            onClick={() => set({ minCf: filters.maxCf, maxCf: filters.minCf })}
          >
            {conflict.fix.label}
          </button>
        </p>
      )}

      {/* Plenty of real posts never state a size; hiding them by default would
          quietly drop a third of the board. */}
      <label className="check-row">
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
        <label key={o.value} className="check-row">
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
        <label key={o.value || "any"} className="check-row">
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

/**
 * What each sort actually orders by.
 *
 * Freshest and Newest are genuinely different -- `last_seen_at` against
 * `first_seen_at` -- and on a board where senders re-post their whole list
 * daily they are different in a way that matters. Nothing said so.
 */
const SORT_HINTS: Record<string, string> = {
  "": "Nearest pickup when you have set a truck location, otherwise ready soonest.",
  distance: "Straight-line distance from your truck location to the pickup.",
  last_seen: "Last time the sender's posts still listed the job — most recently confirmed first.",
  ready: "Earliest ready date first. Jobs with no stated date come after those that have one.",
  cf: "Biggest cubic feet first. Jobs with no stated size come last.",
  rate: "Highest price per cubic foot, whether the post gave a rate or a flat price.",
  deliver_by: "Earliest stated delivery deadline first.",
  newest: "First time this job appeared on the board — new listings first.",
};

function SortPanel({
  value,
  options,
  stats,
  onPick,
}: {
  value: SortKey | "";
  options: Array<{ value: SortKey | ""; label: string; needsViewer?: boolean }>;
  stats?: ResultStats;
  onPick(v: SortKey | ""): void;
}) {
  const noDeadlines = Boolean(stats && !stats.loading && stats.count > 0 && stats.withDeliverBy === 0);
  return (
    <div className="flex flex-col gap-[var(--sp-2)]">
      {options.map((o) => (
        <label key={o.value || "auto"} className="flex cursor-pointer items-start gap-[var(--sp-2)]">
          <input
            type="radio"
            name="sort"
            className="mt-[3px]"
            checked={value === o.value}
            onChange={() => onPick(o.value)}
          />
          <span className="min-w-0">
            <span className="block text-(length:--fs-base) font-semibold">{o.label}</span>
            <span className="block text-(length:--fs-xs)" style={{ color: "var(--muted)" }}>
              {SORT_HINTS[o.value] ?? ""}
              {o.value === "deliver_by" && noDeadlines && (
                <>
                  {" "}
                  <b style={{ color: "var(--warn)" }}>
                    No job in these results states one, so this changes nothing.
                  </b>
                </>
              )}
            </span>
          </span>
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
  stats,
}: {
  filters: Filters;
  set(p: Partial<Filters>): void;
  isAdmin: boolean;
  /** The debounced draft, owned by FilterBar so it survives this panel closing. */
  q: string;
  onQ(v: string): void;
  stats?: ResultStats;
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
        <DeliverByNote stats={stats} />
      </div>

      <label className="check-row">
        <input
          type="checkbox"
          checked={filters.hasPrice}
          onChange={(e) => set({ hasPrice: e.target.checked })}
        />
        Has a price
      </label>

      <label className="check-row">
        <input
          type="checkbox"
          checked={filters.showInactive}
          onChange={(e) => set({ showInactive: e.target.checked })}
        />
        Show delisted, taken and expired
      </label>

      {isAdmin && (
        <label className="check-row">
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

/**
 * The deadline filter, told on itself.
 *
 * It is wired correctly -- a job with no stated deadline passes, which is the
 * right choice -- and it is inert, because not one job in the corpus carries a
 * `deliver_by`. A control that silently does nothing is the one thing this
 * board cannot afford, so it says which of those two things is happening.
 */
function DeliverByNote({ stats }: { stats?: ResultStats }) {
  if (!stats || stats.loading || stats.count === 0) {
    return (
      <p className="mt-[var(--sp-1)] text-(length:--fs-xs)" style={{ color: "var(--muted)" }}>
        A job whose post never stated a deadline always passes this filter.
      </p>
    );
  }
  if (stats.withDeliverBy === 0) {
    return (
      <p
        className="mt-[var(--sp-1)] text-(length:--fs-xs)"
        style={{ color: "var(--warn)" }}
        role="status"
      >
        None of the {stats.count.toLocaleString()} jobs on the board right now states a delivery
        deadline — WhatsApp posts rarely give one. Jobs without a stated deadline always pass, so
        setting a date here will not remove a single job.
      </p>
    );
  }
  return (
    <p className="mt-[var(--sp-1)] text-(length:--fs-xs)" style={{ color: "var(--muted)" }}>
      {stats.withDeliverBy.toLocaleString()} of {stats.count.toLocaleString()} jobs here state a
      deadline. The rest never stated one and always pass this filter.
    </p>
  );
}

/* -------------------------------- route ---------------------------------- */

function routeTriggerLabel(
  f: Filters,
  ctx: { current: StoredLocation | null; home: StoredLocation | null },
): string {
  if (f.routeMode === "corridor") {
    if (isTowardHome(f)) return `home ±${f.corridor || CORRIDOR_MILES} mi`;
    const phrase = routePhrase(f, ctx);
    return phrase ? `${phrase} ±${f.corridor || CORRIDOR_MILES} mi` : "incomplete";
  }
  if (f.routeMode === "radius") {
    if (f.origin) {
      return f.radius === EXACT && f.origin.city
        ? f.origin.city
        : `${f.radius === EXACT || !f.radius ? DEFAULT_RADIUS : f.radius} mi of ${shortPlace(f.origin.label)}`;
    }
    if (f.dest) {
      return f.destRadius === EXACT && f.dest.city
        ? `→ ${f.dest.city}`
        : `→ ${f.destRadius === EXACT || !f.destRadius ? DEFAULT_RADIUS : f.destRadius} mi of ${shortPlace(f.dest.label)}`;
    }
    return "incomplete";
  }
  return "Any";
}

/** "Kearny, NJ 07032" -> "Kearny" — a trigger pill has room for one word. */
function shortPlace(label: string): string {
  return label.split(",")[0]?.trim() || label;
}

const ROUTE_MODES: Array<{ value: RouteMode; label: string }> = [
  { value: "", label: "Anywhere" },
  { value: "corridor", label: "Along a route" },
  { value: "radius", label: "Near a place" },
];

/**
 * Point-and-radius and corridor search — the controls for the six query
 * parameters (`origin`, `radius`, `dest`, `destRadius`, `routeMode`,
 * `corridor`) the API has always honoured and nothing ever emitted.
 */
function RoutePanel({
  filters,
  set,
  current,
  home,
}: {
  filters: Filters;
  set(p: Partial<Filters>): void;
  current: StoredLocation | null;
  home: StoredLocation | null;
}) {
  const mode = filters.routeMode;
  const { start, end } = routeEnds(filters, { current, home });

  const setMode = (next: RouteMode) => {
    if (next === mode) return;
    if (next === "") return set({ routeMode: "", origin: null, dest: null });
    if (next === "corridor") {
      return set({ routeMode: "corridor", corridor: filters.corridor || String(CORRIDOR_MILES) });
    }
    set({ routeMode: "radius", radius: filters.radius || String(DEFAULT_RADIUS) });
  };

  return (
    <div className="flex flex-col gap-[var(--sp-3)]">
      <div className="flex flex-wrap gap-[var(--sp-1)]">
        {ROUTE_MODES.map((m) => (
          <Segment key={m.value || "any"} on={mode === m.value} onClick={() => setMode(m.value)}>
            {m.label}
          </Segment>
        ))}
      </div>

      {mode === "corridor" && (
        <>
          <PlaceField
            id="route-start"
            label="Starting from"
            place={filters.origin}
            fallback={current}
            fallbackNote="Using your truck location"
            onPlace={(p) => set({ routeMode: "corridor", origin: p })}
          />
          <PlaceField
            id="route-end"
            label="Ending at"
            place={filters.dest}
            fallback={home}
            fallbackNote="Using your home base"
            onPlace={(p) => set({ routeMode: "corridor", dest: p })}
          />

          <label className="flex items-center gap-[var(--sp-2)]">
            <span className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
              Corridor width
            </span>
            <CorridorSelect value={filters.corridor} onChange={(v) => set({ corridor: v })} />
          </label>

          {!start || !end ? (
            <p className="text-(length:--fs-xs)" style={{ color: "var(--warn)" }} role="status">
              A corridor needs both ends. {!start ? "Set where you are starting from" : "Set where you are ending"}
              {" — until then this search is not being applied."}
            </p>
          ) : (
            <p className="text-(length:--fs-xs)" style={{ color: "var(--muted)" }}>
              Jobs whose pickup sits within the corridor and whose delivery carries you onward.{" "}
              {STRAIGHT_LINE_NOTE}
            </p>
          )}
        </>
      )}

      {mode === "radius" && (
        <>
          <div>
            <PlaceField
              id="route-pickup-near"
              label="Pickup near"
              place={filters.origin}
              onPlace={(p) => set({ routeMode: "radius", origin: p })}
            />
            <label className="mt-[var(--sp-2)] flex items-center gap-[var(--sp-2)]">
              <span className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
                within
              </span>
              <RadiusSelect
                value={filters.radius}
                city={filters.origin?.city ?? null}
                onChange={(v) => set({ radius: v })}
              />
            </label>
            <ApproxPlaceWarning
              place={filters.origin}
              onUseState={(st) =>
                set({
                  routeMode: "",
                  origin: null,
                  pickupState: filters.pickupState.includes(st)
                    ? filters.pickupState
                    : [...filters.pickupState, st],
                })
              }
            />
          </div>

          <div>
            <PlaceField
              id="route-delivery-near"
              label="Delivery near"
              place={filters.dest}
              onPlace={(p) => set({ routeMode: "radius", dest: p })}
            />
            <label className="mt-[var(--sp-2)] flex items-center gap-[var(--sp-2)]">
              <span className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
                within
              </span>
              <RadiusSelect
                value={filters.destRadius}
                city={filters.dest?.city ?? null}
                onChange={(v) => set({ destRadius: v })}
              />
            </label>
            <ApproxPlaceWarning
              place={filters.dest}
              onUseState={(st) =>
                set({
                  routeMode: "",
                  dest: null,
                  deliveryState: filters.deliveryState.includes(st)
                    ? filters.deliveryState
                    : [...filters.deliveryState, st],
                })
              }
            />
          </div>

          <p className="text-(length:--fs-xs)" style={{ color: "var(--muted)" }}>
            {STRAIGHT_LINE_NOTE}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * A place a route control was given, and the honest caveat when it is one.
 *
 * "Florida" geocodes to a point in the middle of the state. A 50-mile circle
 * around that point is not a search of Florida -- it excludes Miami, Jacksonville
 * and Pensacola -- so a state-level answer is named as one and the state filter,
 * which is what the driver meant, is offered instead.
 */
function ApproxPlaceWarning({
  place,
  onUseState,
}: {
  place: RoutePlace | null;
  onUseState(state: string): void;
}) {
  if (!place || (place.precision !== "state" && place.precision !== "region")) return null;
  return (
    <p className="mt-[var(--sp-1)] text-(length:--fs-xs)" style={{ color: "var(--warn)" }} role="status">
      “{place.label}” is only known to {place.precision === "region" ? "a region" : "a whole state"}, so
      this circle is drawn around its middle — it is not a search of the whole area.
      {place.state && (
        <>
          {" "}
          <button
            type="button"
            className="btn btn-sm mt-[var(--sp-1)]"
            onClick={() => onUseState(place.state!)}
          >
            Filter by {place.state} instead
          </button>
        </>
      )}
    </p>
  );
}

/**
 * One place input that commits on pick, or resolves what was typed.
 *
 * The panel unmounts with its popover, so the *committed* place lives in
 * `Filters` and only the half-typed text is local -- a place is picked
 * deliberately, unlike the search box, so losing an unfinished one costs
 * nothing.
 */
function PlaceField({
  id,
  label,
  place,
  fallback,
  fallbackNote,
  onPlace,
}: {
  id: string;
  label: string;
  place: RoutePlace | null;
  fallback?: StoredLocation | null;
  fallbackNote?: string;
  onPlace(p: RoutePlace | null): void;
}) {
  const [text, setText] = useState(place?.label ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Text that is not yet the committed place — the only state "Use" applies to. */
  const pending = text.trim().length > 0 && text.trim() !== place?.label;

  const commit = async () => {
    const label = text.trim();
    if (!label) return onPlace(null);
    if (label === place?.label) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(api("/api/places/resolve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) {
        setError("We could not find that place — try a city or ZIP.");
        return;
      }
      const j = (await res.json()) as ResolvedPlace;
      onPlace({
        label: j.label,
        lat: j.lat,
        lng: j.lng,
        precision: j.precision,
        state: j.state,
        city: j.city,
        zip: j.zip,
      });
    } catch {
      setError("We could not reach the place lookup — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div id={id}>
        <LocationInput
          ariaLabel={label}
          placeholder={fallback ? fallback.label : "City, ZIP or address…"}
          value={text}
          onChange={setText}
          onPick={(p) =>
            onPlace({
              label: p.label,
              lat: p.lat,
              lng: p.lng,
              precision: p.precision,
              state: p.state,
              city: p.city,
              zip: p.zip,
            })
          }
        />
      </div>
      {/* Only the two actions that mean something right now. A picked
          suggestion has already committed itself; this is the way out for text
          typed but never picked, which the geocoder still has to answer for. */}
      {(pending || place) && (
        <div className="mt-[var(--sp-1)] flex items-center gap-[var(--sp-2)]">
          {pending && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void commit()}>
              {busy ? "One moment…" : "Use this place"}
            </button>
          )}
          {place && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setText("");
                onPlace(null);
              }}
            >
              Clear
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="mt-[var(--sp-1)] text-(length:--fs-xs)" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
      {!place && fallback && fallbackNote && (
        <p className="mt-[var(--sp-1)] text-(length:--fs-xs)" style={{ color: "var(--muted)" }}>
          {fallbackNote}: {fallback.label}
        </p>
      )}
    </div>
  );
}

/**
 * How near "near" is — and the one non-numeric answer.
 *
 * "This city only" is `pickupCity` / `deliveryCity`: an exact match on the city
 * the extractor recorded, not a small circle. The two are genuinely different
 * searches and a driver should be able to ask for either, which is what the API
 * has always allowed and nothing ever offered.
 */
function RadiusSelect({
  value,
  city,
  onChange,
}: {
  value: string;
  city: string | null;
  onChange(v: string): void;
}) {
  return (
    <span className="select-pill">
      <select
        className="pill"
        aria-label="How near, in straight-line miles"
        value={value || String(DEFAULT_RADIUS)}
        onChange={(e) => onChange(e.target.value)}
      >
        {city && <option value={EXACT}>{city} only</option>}
        {RADIUS_OPTIONS.map((r) => (
          <option key={r} value={r}>
            {r} mi
          </option>
        ))}
      </select>
    </span>
  );
}

export function CorridorSelect({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <span className="select-pill">
      <select
        className="pill"
        aria-label="Corridor width in straight-line miles either side of the route"
        value={value || String(CORRIDOR_MILES)}
        onChange={(e) => onChange(e.target.value)}
      >
        {CORRIDOR_OPTIONS.map((c) => (
          <option key={c} value={c}>
            ± {c} mi
          </option>
        ))}
      </select>
    </span>
  );
}

function TowardHomeToggle({
  filters,
  set,
}: {
  filters: Filters;
  set(p: Partial<Filters>): void;
}) {
  const on = isTowardHome(filters);
  return (
    <button
      type="button"
      className="pill"
      data-active={on || undefined}
      aria-pressed={on}
      title="Only jobs inside a corridor between where you are and home"
      onClick={() =>
        set(
          on
            ? { routeMode: "", origin: null, dest: null }
            : {
                routeMode: "corridor",
                origin: null,
                dest: null,
                corridor: filters.corridor || String(CORRIDOR_MILES),
              },
        )
      }
    >
      ⇄ Toward home{on ? ` ±${filters.corridor || CORRIDOR_MILES} mi` : ""}
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
      className="chip chip-button"
      aria-pressed={on}
      onClick={onClick}
      style={{
        background: on ? "var(--accent-soft)" : "var(--surface-2)",
        color: on ? "var(--accent)" : "var(--text-2)",
      }}
    >
      {children}
    </button>
  );
}

/* ---------------------------- the route cockpit ---------------------------- */

/**
 * What a corridor search actually found, folded from the rows on screen.
 *
 * The API has always returned `off_route_miles` and `detour_miles` per job and
 * nothing rendered either, so the one thing this board can do that a plain list
 * cannot was invisible (§7.2).
 */
export interface CorridorStats {
  /** Jobs matched by the corridor. */
  matched: number;
  minDetour: number | null;
  maxDetour: number | null;
  /** Jobs whose pickup or delivery is only known to a state or region centroid. */
  approximate: number;
}

/**
 * The corridor read-out: the route being searched, its width, and the extra
 * driving the matches cost.
 *
 * Every number here is straight-line geometry, and says so. Where an endpoint
 * resolved only to a state centroid the figures are called approximate rather
 * than quoted to the mile -- the detour is computed from a point the post never
 * actually gave.
 */
export function RouteStrip({
  filters,
  onChange,
  current,
  home,
  stats,
}: {
  filters: Filters;
  onChange(next: Filters): void;
  current: StoredLocation | null;
  home: StoredLocation | null;
  stats: CorridorStats | null;
}) {
  if (filters.routeMode !== "corridor") return null;
  const { start, end } = routeEnds(filters, { current, home });
  const width = filters.corridor || String(CORRIDOR_MILES);

  return (
    <div
      className="mb-[var(--sp-2)] rounded-[var(--radius-sm)] border border-border px-[var(--sp-3)] py-[var(--sp-2)]"
      style={{ background: "var(--surface-2)" }}
    >
      {/* One row that cannot wrap: the width control is the knob a driver
          reaches for while reading these results, and it should not move down
          the page as the route's name gets longer. The name truncates instead —
          the chip in the filter bar above carries it in full. */}
      <div className="flex items-center gap-[var(--sp-2)]">
        <span className="min-w-0 flex-1 truncate text-(length:--fs-sm) font-semibold">
          {start && end ? (
            <>
              Along {start.label} → {end.label}
            </>
          ) : (
            "Along your route"
          )}
        </span>
        <span className="shrink-0">
          <CorridorSelect
            value={filters.corridor}
            onChange={(v) => onChange({ ...filters, corridor: v })}
          />
        </span>
      </div>

      <p className="mt-[var(--sp-1)] text-(length:--fs-xs)" style={{ color: "var(--muted)" }}>
        {!start || !end ? (
          <span style={{ color: "var(--warn)" }}>
            This needs both ends of the route before it can filter anything. Set them in Route, or
            set your truck location and home base.
          </span>
        ) : stats == null || stats.matched === 0 ? (
          <>
            Nothing sits within {width} straight-line miles of that line and still carries you
            onward. {STRAIGHT_LINE_NOTE}
          </>
        ) : (
          <>
            {stats.matched} {stats.matched === 1 ? "job is" : "jobs are"} within {width} mi of the
            line
            {stats.minDetour != null && stats.maxDetour != null && (
              <>
                , costing{" "}
                {stats.minDetour === stats.maxDetour
                  ? `about ${stats.minDetour} extra mi`
                  : `about ${stats.minDetour}–${stats.maxDetour} extra mi`}
              </>
            )}
            . {STRAIGHT_LINE_NOTE}
            {stats.approximate > 0 && (
              <>
                {" "}
                <b style={{ color: "var(--approx)" }}>
                  {stats.approximate} of them {stats.approximate === 1 ? "has an end" : "have an end"}{" "}
                  the post only placed to a state, so {stats.approximate === 1 ? "its" : "their"}{" "}
                  detour is an estimate from a state centre, not a measured figure.
                </b>
              </>
            )}
          </>
        )}
      </p>
    </div>
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
  if (f.routeMode === "corridor") {
    const current = Number(f.corridor || CORRIDOR_MILES);
    const wider = CORRIDOR_OPTIONS.find((c) => c > current);
    if (wider) out.push({ label: `Widen to ±${wider} mi`, next: { ...f, corridor: String(wider) } });
    out.push({ label: "Anywhere", next: { ...f, routeMode: "", origin: null, dest: null } });
  }
  if (f.routeMode === "radius") {
    const current = Number(f.radius || DEFAULT_RADIUS);
    const wider = RADIUS_OPTIONS.find((r) => r > current);
    if (wider) out.push({ label: `Widen to ${wider} mi`, next: { ...f, radius: String(wider) } });
  }
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
