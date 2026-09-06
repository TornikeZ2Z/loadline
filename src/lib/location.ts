"use client";

/**
 * Where the viewer is, kept in the browser and nowhere else.
 *
 * The board is public, so there is no account to hang a home base on -- and
 * even for signed-in drivers we deliberately do not store a position on the
 * server: it is the one piece of data a mover would not want a job board to
 * keep. Two slots live in localStorage:
 *
 *   current -- "where I am / where I'll be empty". Drives distance-to-pickup,
 *              the default sort, the you-are-here marker and the road-time
 *              line in the job detail.
 *   home    -- "where I'm heading back to". Only feeds the optional
 *              Toward-home corridor and the delivery-state ghost hint.
 *
 * Coordinates travel to the server as ordinary query parameters on each search
 * (`viewerLat`/`viewerLng`), never in the shareable URL and never in a cookie.
 *
 * Client-only by construction: no database, no session, no `next/headers`.
 */

import { useSyncExternalStore } from "react";

export type LocationSlot = "current" | "home";

export const LOCATION_KEYS = {
  current: "loadline.viewer.v1",
  home: "loadline.home.v1",
} as const;

/** Fired on this window whenever a slot is written or cleared. detail: { slot }. */
export const LOCATION_CHANGED_EVENT = "loadline:location-changed";

/**
 * Fired by anyone who wants the header's location popover opened --
 * the Board's first-visit nudge and the detail's "From you" tile.
 * detail: { slot: "current" | "home" }. `CurrentLocation` listens.
 */
export const OPEN_LOCATION_EVENT = "loadline:open-location";

export interface StoredLocation {
  /** "Miami, FL" */
  label: string;
  lat: number;
  lng: number;
  /** "FL" when known. */
  state: string | null;
  /** address | zip | city | region | state */
  precision: string | null;
  /** Optional "Truck size (cf)" from the current-location popover; the home slot is always null. */
  truckCf: number | null;
  /** ISO timestamp of the write. */
  setAt: string;
}

export interface ViewerLocations {
  current: StoredLocation | null;
  home: StoredLocation | null;
  hydrated: boolean;
}

// --- reading -----------------------------------------------------------------

function parseStored(raw: string | null): StoredLocation | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  // A stored value written by an older build may be missing fields; anything
  // without usable coordinates or a label is treated as absent rather than
  // half-applied, since a bad position silently mis-sorts the whole board.
  if (typeof v.label !== "string" || !v.label) return null;
  if (typeof v.lat !== "number" || !Number.isFinite(v.lat)) return null;
  if (typeof v.lng !== "number" || !Number.isFinite(v.lng)) return null;
  return {
    label: v.label,
    lat: v.lat,
    lng: v.lng,
    state: typeof v.state === "string" ? v.state : null,
    precision: typeof v.precision === "string" ? v.precision : null,
    truckCf: typeof v.truckCf === "number" && Number.isFinite(v.truckCf) ? v.truckCf : null,
    setAt: typeof v.setAt === "string" ? v.setAt : new Date(0).toISOString(),
  };
}

function rawFor(slot: LocationSlot): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LOCATION_KEYS[slot]);
  } catch {
    // Safari in private mode and "block all cookies" both throw on access.
    return null;
  }
}

/** The stored location for a slot, or null on the server and for anything unusable. */
export function readLocation(slot: LocationSlot): StoredLocation | null {
  return parseStored(rawFor(slot));
}

// --- writing -----------------------------------------------------------------

function announce(slot: LocationSlot): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(LOCATION_CHANGED_EVENT, { detail: { slot } }));
}

/** Store a location, stamp it, tell every listener. Returns what was stored. */
export function writeLocation(
  slot: LocationSlot,
  v: Omit<StoredLocation, "setAt">,
): StoredLocation {
  const stored: StoredLocation = { ...v, setAt: new Date().toISOString() };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(LOCATION_KEYS[slot], JSON.stringify(stored));
    } catch {
      // Storage is full or blocked: the value still applies for this page view.
    }
  }
  announce(slot);
  return stored;
}

/** Forget a slot. */
export function clearLocation(slot: LocationSlot): void {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(LOCATION_KEYS[slot]);
    } catch {
      // ignore
    }
  }
  announce(slot);
}

// --- the hook ----------------------------------------------------------------

const SERVER_SNAPSHOT: ViewerLocations = { current: null, home: null, hydrated: false };

// useSyncExternalStore compares snapshots by identity, so a fresh object per
// read would re-render forever. Cache one snapshot per pair of raw strings.
let cachedRawCurrent: string | null = null;
let cachedRawHome: string | null = null;
let cachedSnapshot: ViewerLocations = { current: null, home: null, hydrated: true };

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(LOCATION_CHANGED_EVENT, onChange);
  window.addEventListener("storage", onChange); // another tab
  return () => {
    window.removeEventListener(LOCATION_CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function getSnapshot(): ViewerLocations {
  const rawCurrent = rawFor("current");
  const rawHome = rawFor("home");
  if (rawCurrent !== cachedRawCurrent || rawHome !== cachedRawHome) {
    cachedRawCurrent = rawCurrent;
    cachedRawHome = rawHome;
    cachedSnapshot = {
      current: parseStored(rawCurrent),
      home: parseStored(rawHome),
      hydrated: true,
    };
  }
  return cachedSnapshot;
}

function getServerSnapshot(): ViewerLocations {
  return SERVER_SNAPSHOT;
}

/**
 * The two slots plus `hydrated`, which is false during SSR and the first client
 * paint so nothing that depends on a stored position renders differently on the
 * two passes (that is what produces hydration warnings).
 */
export function useViewerLocation(): ViewerLocations {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// --- query strings -----------------------------------------------------------

const round5 = (n: number) => String(Math.round(n * 1e5) / 1e5);

/** "" | "viewerLat=25.7617&viewerLng=-80.1918" -- coordinates only, never the label. */
export function viewerQuery(current: StoredLocation | null): string {
  if (!current) return "";
  return `viewerLat=${round5(current.lat)}&viewerLng=${round5(current.lng)}`;
}

/** "" | "destLat=…&destLng=…" -- used by the Toward-home corridor toggle only. */
export function homeQuery(home: StoredLocation | null): string {
  if (!home) return "";
  return `destLat=${round5(home.lat)}&destLng=${round5(home.lng)}`;
}
