/**
 * URLSearchParams -> TruckSearchParams.
 *
 * A sibling of `./searchParams.ts`, and the differences are the point.
 *
 * TEN KEYS ARE REFUSED WITH A 400, not ignored. A URL copied from the job board
 * describes freight: `minCf` is how big the shipment is, `readyBy` is when the
 * furniture is on the sidewalk, `hasPrice` is a price a truck never carries.
 * Silently dropping them would answer a question nobody asked with an
 * unfiltered board -- "18 trucks over 600 cf" that is really every truck on the
 * network. Failing loudly is the only honest option, and it is cheap: the
 * Trucks tab builds its own URLs.
 *
 * `visibility` is refused for the same reason it is not a field on
 * `TruckSearchParams`: the review state is pinned in SQL by `searchTrucks`'
 * required scope, and a public filter axis over it would be an anonymously
 * enumerable queue of machine-invented rows.
 *
 * The error is a plain class rather than an HttpError so this module stays free
 * of `next/headers` and remains safe to import anywhere; the route turns it
 * into a 400, exactly as `POST /api/loads` does with `WebJobValidationError`.
 */
import { geocode } from "@/lib/geo/geocode";
import type { TruckSearchParams, TruckSortKey, TruckStatus } from "./truckTypes";

export class TruckSearchParamError extends Error {
  constructor(readonly key: string, message: string) {
    super(message);
    this.name = "TruckSearchParamError";
  }
}

const SORTS: TruckSortKey[] = ["depart", "last_seen", "newest", "distance", "free_cf", "leg_miles"];

const STATUSES: TruckStatus[] = ["available", "booked", "departed", "expired", "cancelled"];

/**
 * A job-shaped key, and what the driver should have typed instead.
 *
 * Written as a table so the 400 says which control they wanted rather than
 * "bad request" -- the Trucks tab has a free-space filter and a departure
 * filter, they are just not spelled the way the job board spells its own.
 */
const REFUSED: Record<string, string> = {
  hasPrice: "trucks never carry a price in v1, so there is nothing to filter on",
  deliverBy: "a truck has no delivery deadline — use departsBy for when it leaves",
  readyBy: "a truck departs rather than becoming ready — use departsBy",
  readyOnly: "a truck departs rather than becoming ready — use departsBy",
  minCf: "that is freight volume — use minFreeCf for space on a truck",
  maxCf: "that is freight volume — use maxFreeCf for space on a truck",
  pickupState: "a truck has an origin, not a pickup — use originState",
  deliveryState: "use destState for where a truck is headed",
  dupes: "trucks have no duplicate groups",
  visibility: "not a filter: which trucks are public is decided by the server, not by the URL",
};

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
 * Parse a truck-board query string, resolving place text to coordinates.
 *
 * Throws `TruckSearchParamError` on a job-shaped key. Note that the refusal
 * looks at whether the key is PRESENT, not at whether it has a value:
 * `?minCf=` is still a job board's URL, and answering it with an unfiltered
 * truck board would be the silent behaviour this exists to prevent.
 */
export async function parseTruckSearchParams(sp: URLSearchParams): Promise<TruckSearchParams> {
  for (const [key, why] of Object.entries(REFUSED)) {
    if (sp.has(key)) {
      throw new TruckSearchParamError(key, `"${key}" is not a truck filter — ${why}`);
    }
  }

  const originText = sp.get("origin")?.trim() || null;
  const destText = sp.get("dest")?.trim() || null;

  let origin = pointFrom(sp, "originLat", "originLng", originText);
  if (!origin && originText) origin = await resolveText(originText);

  let destination = pointFrom(sp, "destLat", "destLng", destText);
  if (!destination && destText) destination = await resolveText(destText);

  const viewer = pointFrom(sp, "viewerLat", "viewerLng", "your location");

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
    originStates: list(sp, "originState"),
    originCity: sp.get("originCity") || null,
    originZip: sp.get("originZip") || null,

    destStates: list(sp, "destState"),
    destCity: sp.get("destCity") || null,
    destZip: sp.get("destZip") || null,

    origin,
    radiusMiles: num(sp, "radius"),
    destination,
    destRadiusMiles: num(sp, "destRadius"),

    routeMode: sp.get("routeMode") === "corridor" ? "corridor" : "endpoints",
    corridorMiles: num(sp, "corridor"),

    bounds,

    minFreeCf: num(sp, "minFreeCf"),
    maxFreeCf: num(sp, "maxFreeCf"),
    includeUnsized: sp.get("unsized") !== "0",

    departsBy: isoDate(sp, "departsBy"),
    noDestOnly: sp.get("noDest") === "1",
    seenDays,

    statuses: list(sp, "status").filter((s) =>
      STATUSES.includes(s as TruckStatus),
    ) as TruckStatus[],
    senderKey: sp.get("sender") || null,
    needsReviewOnly: sp.get("review") === "1",
    q: sp.get("q") || null,

    viewer,

    sort: asEnum(sp.get("sort"), SORTS) ?? (origin || viewer ? "distance" : "depart"),
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
