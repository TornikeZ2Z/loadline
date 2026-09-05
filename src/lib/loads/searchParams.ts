/**
 * URLSearchParams <-> LoadSearchParams.
 *
 * Shared by the API route and the board page so a search is always a URL: it
 * can be linked, bookmarked, and saved as a "saved search" without a second
 * serialization format.
 */
import { geocode } from "@/lib/geo/geocode";
import type { DatePreset, LoadSearchParams, LoadStatus, SortKey } from "./types";

export { RADIUS_OPTIONS } from "./constants";

const DATE_PRESETS: DatePreset[] = ["any", "today", "tomorrow", "week", "next3", "custom"];
const SORTS: SortKey[] = ["newest", "pickup_date", "distance", "trip_miles", "rate"];
const STATUSES: LoadStatus[] = ["available", "pending", "taken", "expired", "cancelled"];

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

/**
 * Parse a query string into search params, resolving place text to
 * coordinates. Async because "50 miles from Newark" needs a geocode first.
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

  const datePreset = asEnum(sp.get("date"), DATE_PRESETS) ?? "any";
  const bounds =
    num(sp, "minLat") != null && num(sp, "maxLat") != null
      ? {
          minLat: num(sp, "minLat")!,
          maxLat: num(sp, "maxLat")!,
          minLng: num(sp, "minLng")!,
          maxLng: num(sp, "maxLng")!,
        }
      : null;

  return {
    datePreset,
    dateFrom: sp.get("from") || null,
    dateTo: sp.get("to") || null,

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

    statuses: (list(sp, "status").filter((s) => STATUSES.includes(s as LoadStatus)) as LoadStatus[]) ,
    loadTypes: list(sp, "type"),
    minWeight: num(sp, "minWeight"),
    maxWeight: num(sp, "maxWeight"),
    q: sp.get("q") || null,

    includeDuplicates: sp.get("dupes") === "1",
    needsReviewOnly: sp.get("review") === "1",

    viewer,

    sort: asEnum(sp.get("sort"), SORTS) ?? (origin || viewer ? "distance" : "newest"),
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
  return hit
    ? { lat: hit.lat, lng: hit.lng, label: hit.label, precision: hit.precision }
    : null;
}

function asEnum<T extends string>(value: string | null, allowed: T[]): T | null {
  return value && (allowed as string[]).includes(value) ? (value as T) : null;
}

/** Inverse: build a query string from params. Used by saved searches. */
export function toQueryString(p: Partial<LoadSearchParams>): string {
  const sp = new URLSearchParams();
  const set = (k: string, v: unknown) => {
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) return;
    sp.set(k, Array.isArray(v) ? v.join(",") : String(v));
  };

  if (p.datePreset && p.datePreset !== "any") set("date", p.datePreset);
  set("from", p.dateFrom);
  set("to", p.dateTo);
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
  set("type", p.loadTypes);
  set("minWeight", p.minWeight);
  set("maxWeight", p.maxWeight);
  set("q", p.q);
  if (p.includeDuplicates) set("dupes", "1");
  if (p.needsReviewOnly) set("review", "1");
  if (p.statuses?.length) set("status", p.statuses);
  if (p.sort) set("sort", p.sort);
  return sp.toString();
}
