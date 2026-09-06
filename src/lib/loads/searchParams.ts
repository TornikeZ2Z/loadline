/**
 * URLSearchParams <-> LoadSearchParams.
 *
 * Shared by the API route and the board page so a search is always a URL: it
 * can be linked, bookmarked and shared without a second serialization format.
 *
 * The pickup-date window of the freight era is gone. A mover's post says "ready
 * now" or "ready from the 12th", so the filters are readiness, deadline and
 * freshness -- and an undated job is never hidden by a default window.
 */
import { geocode } from "@/lib/geo/geocode";
import type { LoadSearchParams, LoadStatus, SortKey } from "./types";

export { RADIUS_OPTIONS } from "./constants";

const SORTS: SortKey[] = [
  "newest",
  "last_seen",
  "ready",
  "distance",
  "trip_miles",
  "rate",
  "cf",
  "deliver_by",
];

const STATUSES: LoadStatus[] = [
  "available",
  "delisted",
  "pending",
  "taken",
  "expired",
  "cancelled",
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function list(sp: URLSearchParams, key: string): string[] {
  return sp
    .getAll(key)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}

function num(sp: URLSearchParams, key: string): number | null {
  const raw = sp.get(key);
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** An ISO date or nothing -- a half-typed "2026-09" must not become a filter. */
function isoDate(sp: URLSearchParams, key: string): string | null {
  const raw = sp.get(key)?.trim();
  return raw && ISO_DATE.test(raw) ? raw : null;
}

/**
 * Parse a query string into search params, resolving place text to
 * coordinates. Async because "50 miles from Newark" needs a geocode first.
 *
 * `fallbackViewer` is legacy and optional: the viewer's location now lives in
 * the browser and arrives as viewerLat/viewerLng.
 */
export async function parseSearchParams(
  sp: URLSearchParams,
  fallbackViewer?: { lat: number; lng: number; label?: string } | null,
): Promise<LoadSearchParams> {
  const originText = sp.get("origin")?.trim() || null;
  const destText = sp.get("dest")?.trim() || null;

  let origin = pointFrom(sp, "originLat", "originLng", originText);
  if (!origin && originText) origin = await resolveText(originText);

  let destination = pointFrom(sp, "destLat", "destLng", destText);
  if (!destination && destText) destination = await resolveText(destText);

  const viewer = pointFrom(sp, "viewerLat", "viewerLng", "your location") ?? fallbackViewer ?? null;

  // All four or none. Testing only the latitudes would let the longitudes come
  // through as nulls behind a `number` type, and `lng BETWEEN NULL AND NULL` is
  // NULL for every row -- the whole result set silently dropped, 200 and empty.
  const minLat = num(sp, "minLat");
  const maxLat = num(sp, "maxLat");
  const minLng = num(sp, "minLng");
  const maxLng = num(sp, "maxLng");
  const bounds =
    minLat != null && maxLat != null && minLng != null && maxLng != null
      ? { minLat, maxLat, minLng, maxLng }
      : null;

  const seenDaysRaw = num(sp, "seenDays");
  const seenDays = seenDaysRaw == null ? null : clamp(Math.round(seenDaysRaw), 1, 30);

  return {
    pickupStates: list(sp, "pickupState"),
    pickupCity: sp.get("pickupCity") || null,
    pickupZip: sp.get("pickupZip") || null,

    deliveryStates: list(sp, "deliveryState"),
    deliveryCity: sp.get("deliveryCity") || null,
    deliveryZip: sp.get("deliveryZip") || null,

    origin,
    radiusMiles: num(sp, "radius"),
    destination,
    destRadiusMiles: num(sp, "destRadius"),

    routeMode: sp.get("routeMode") === "corridor" ? "corridor" : "endpoints",
    corridorMiles: num(sp, "corridor"),

    bounds,

    minCf: num(sp, "minCf"),
    maxCf: num(sp, "maxCf"),
    includeUnsized: sp.get("unsized") !== "0",

    readyOnly: sp.get("readyOnly") === "1",
    readyBy: isoDate(sp, "readyBy"),
    deliverBy: isoDate(sp, "deliverBy"),
    seenDays,

    hasPrice: sp.get("hasPrice") === "1",

    statuses: list(sp, "status").filter((s) =>
      STATUSES.includes(s as LoadStatus),
    ) as LoadStatus[],
    senderKey: sp.get("sender") || null,
    q: sp.get("q") || null,

    includeDuplicates: sp.get("dupes") === "1",
    needsReviewOnly: sp.get("review") === "1",

    viewer,

    sort: asEnum(sp.get("sort"), SORTS) ?? (origin || viewer ? "distance" : "ready"),
    limit: num(sp, "limit") ?? 50,
    offset: num(sp, "offset") ?? 0,
  };
}

function pointFrom(
  sp: URLSearchParams,
  latKey: string,
  lngKey: string,
  label: string | null,
): { lat: number; lng: number; label?: string } | null {
  const lat = num(sp, latKey);
  const lng = num(sp, lngKey);
  if (lat == null || lng == null) return null;
  return { lat, lng, label: label ?? undefined };
}

async function resolveText(
  text: string,
): Promise<{ lat: number; lng: number; label: string; precision: string } | null> {
  const hit = await geocode(text);
  return hit ? { lat: hit.lat, lng: hit.lng, label: hit.label, precision: hit.precision } : null;
}

function asEnum<T extends string>(value: string | null, allowed: T[]): T | null {
  return value && (allowed as string[]).includes(value) ? (value as T) : null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** Inverse: build a query string from params. */
export function toQueryString(p: Partial<LoadSearchParams>): string {
  const sp = new URLSearchParams();
  const set = (k: string, v: unknown) => {
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) return;
    sp.set(k, Array.isArray(v) ? v.join(",") : String(v));
  };

  set("pickupState", p.pickupStates);
  set("pickupCity", p.pickupCity);
  set("pickupZip", p.pickupZip);
  set("deliveryState", p.deliveryStates);
  set("deliveryCity", p.deliveryCity);
  set("deliveryZip", p.deliveryZip);
  if (p.origin) {
    set("origin", p.origin.label);
    set("originLat", p.origin.lat);
    set("originLng", p.origin.lng);
  }
  set("radius", p.radiusMiles);
  if (p.destination) {
    set("dest", p.destination.label);
    set("destLat", p.destination.lat);
    set("destLng", p.destination.lng);
  }
  set("destRadius", p.destRadiusMiles);
  if (p.routeMode === "corridor") set("routeMode", "corridor");
  set("corridor", p.corridorMiles);

  set("minCf", p.minCf);
  set("maxCf", p.maxCf);
  if (p.includeUnsized === false) set("unsized", "0");
  if (p.readyOnly) set("readyOnly", "1");
  set("readyBy", p.readyBy);
  set("deliverBy", p.deliverBy);
  set("seenDays", p.seenDays);
  if (p.hasPrice) set("hasPrice", "1");

  set("q", p.q);
  set("sender", p.senderKey);
  if (p.includeDuplicates) set("dupes", "1");
  if (p.needsReviewOnly) set("review", "1");
  if (p.statuses?.length) set("status", p.statuses);
  if (p.sort) set("sort", p.sort);
  return sp.toString();
}
