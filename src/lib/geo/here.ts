/**
 * HERE Location Services.
 *
 * Three things it gives us that the offline gazetteer cannot:
 *   - autosuggest, so a driver types "newar" and picks a real place;
 *   - address-level geocoding for anything outside the curated city list;
 *   - **truck** road distance and drive time, which is the number a driver
 *     actually cares about. Great-circle miles understate a real trip by 15-30%
 *     and say nothing about hours behind the wheel.
 *
 * The API key stays server-side. Every browser call goes through our own
 * /api/places/* routes -- a key embedded in the client bundle is a key on
 * someone else's invoice.
 *
 * Everything degrades: with no HERE_API_KEY the app falls back to the offline
 * gazetteer and straight-line distance, exactly as before.
 */

const AUTOSUGGEST = "https://autosuggest.search.hereapi.com/v1/autosuggest";
const GEOCODE = "https://geocode.search.hereapi.com/v1/geocode";
const ROUTER = "https://router.hereapi.com/v8/routes";

export interface HerePlace {
  id: string;
  /** "Newark, NJ 07102, United States" */
  label: string;
  /** Short form for the input box: "Newark, NJ" */
  short: string;
  lat: number;
  lng: number;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  /** HERE result type, mapped onto our precision vocabulary. */
  precision: "address" | "zip" | "city" | "region" | "state";
}

export interface RoadDistance {
  miles: number;
  minutes: number;
}

export function hereConfigured(): boolean {
  return Boolean(process.env.HERE_API_KEY);
}

function key(): string {
  const k = process.env.HERE_API_KEY;
  if (!k) throw new Error("HERE_API_KEY is not set");
  return k;
}

/** HERE result types -> our precision vocabulary. */
function precisionOf(resultType: string | undefined, localityType?: string): HerePlace["precision"] {
  switch (resultType) {
    case "houseNumber":
    case "street":
    case "place":
      return "address";
    case "postalCodePoint":
      return "zip";
    case "locality":
      return localityType === "postalCode" ? "zip" : "city";
    case "administrativeArea":
      return "state";
    default:
      return "city";
  }
}

interface HereItem {
  id?: string;
  title?: string;
  resultType?: string;
  localityType?: string;
  position?: { lat: number; lng: number };
  access?: Array<{ lat: number; lng: number }>;
  address?: {
    label?: string;
    city?: string;
    state?: string;
    stateCode?: string;
    postalCode?: string;
    countryCode?: string;
  };
}

function toPlace(item: HereItem): HerePlace | null {
  const pos = item.position ?? item.access?.[0];
  if (!pos) return null;

  const a = item.address ?? {};
  const state = a.stateCode ?? a.state ?? null;
  const city = a.city ?? null;
  const short = [city, state].filter(Boolean).join(", ") || (item.title ?? a.label ?? "");

  return {
    id: item.id ?? `${pos.lat},${pos.lng}`,
    label: a.label ?? item.title ?? short,
    short: a.postalCode && city ? `${short} ${a.postalCode}` : short,
    lat: pos.lat,
    lng: pos.lng,
    city,
    state,
    postalCode: a.postalCode ?? null,
    precision: precisionOf(item.resultType, item.localityType),
  };
}

/**
 * Type-ahead suggestions. `near` biases results toward the user, which is what
 * makes "newar" return Newark NJ for someone in New Jersey rather than Newark
 * in five other states.
 */
export async function hereAutosuggest(
  q: string,
  near?: { lat: number; lng: number } | null,
): Promise<HerePlace[]> {
  if (!hereConfigured() || q.trim().length < 2) return [];

  const url = new URL(AUTOSUGGEST);
  url.searchParams.set("q", q);
  // `at` is required by autosuggest; fall back to the middle of the US.
  url.searchParams.set("at", near ? `${near.lat},${near.lng}` : "39.5,-98.35");
  url.searchParams.set("in", "countryCode:USA");
  url.searchParams.set("limit", "8");
  url.searchParams.set("apiKey", key());

  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return [];

  const json = (await res.json()) as { items?: HereItem[] };
  return (json.items ?? [])
    .map(toPlace)
    .filter((p): p is HerePlace => p !== null)
    // Autosuggest also returns chains and categories; keep real locations.
    .filter((p) => p.lat !== 0 || p.lng !== 0);
}

/** Resolve a full place string to coordinates. */
export async function hereGeocode(q: string): Promise<HerePlace | null> {
  if (!hereConfigured() || !q.trim()) return null;

  const url = new URL(GEOCODE);
  url.searchParams.set("q", q);
  url.searchParams.set("in", "countryCode:USA");
  url.searchParams.set("limit", "1");
  url.searchParams.set("apiKey", key());

  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;

  const json = (await res.json()) as { items?: HereItem[] };
  const first = json.items?.[0];
  return first ? toPlace(first) : null;
}

/**
 * Road distance and drive time for a truck.
 *
 * `transportMode=truck` matters: it respects height, weight and hazmat
 * restrictions and avoids roads a tractor-trailer cannot legally use, so the
 * answer is the one a driver would get from their own navigation rather than a
 * car's shortcut.
 */
export async function hereRoute(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
): Promise<RoadDistance | null> {
  if (!hereConfigured()) return null;

  const url = new URL(ROUTER);
  url.searchParams.set("transportMode", "truck");
  url.searchParams.set("origin", `${origin.lat},${origin.lng}`);
  url.searchParams.set("destination", `${destination.lat},${destination.lng}`);
  url.searchParams.set("return", "summary");
  url.searchParams.set("apiKey", key());

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;

  const json = (await res.json()) as {
    routes?: Array<{ sections?: Array<{ summary?: { length?: number; duration?: number } }> }>;
  };

  // A route can come back in several sections; the trip is their sum.
  const sections = json.routes?.[0]?.sections ?? [];
  if (!sections.length) return null;

  const meters = sections.reduce((n, s) => n + (s.summary?.length ?? 0), 0);
  const seconds = sections.reduce((n, s) => n + (s.summary?.duration ?? 0), 0);
  if (!meters) return null;

  return {
    miles: Math.round(meters / 1609.344),
    minutes: Math.round(seconds / 60),
  };
}

/** "6h 20m" */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} m`;
}
