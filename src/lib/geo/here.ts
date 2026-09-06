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

const AUTOCOMPLETE = "https://autocomplete.search.hereapi.com/v1/autocomplete";
const LOOKUP = "https://lookup.search.hereapi.com/v1/lookup";
const GEOCODE = "https://geocode.search.hereapi.com/v1/geocode";
const REVGEOCODE = "https://revgeocode.search.hereapi.com/v1/revgeocode";
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

/**
 * A daily ceiling on billable HERE calls.
 *
 * Every place route is public now — no session in front of suggest, resolve or
 * the job detail — so a bored script can spend real money on someone else's
 * invoice. The counter is per process and per UTC day, and when it runs out
 * `hereConfigured()` simply reports false: the public routes fall back to the
 * offline gazetteer and straight-line distance, exactly as they do on a machine
 * with no key at all. Degrading silently is deliberate — an error page because
 * a quota ran out would be a worse product than a slightly coarser label.
 */
export const HERE_DAILY_BUDGET = Number(process.env.HERE_DAILY_BUDGET ?? 2000);

let usage = { day: "", calls: 0 };

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function callsToday(): number {
  const day = utcDay();
  if (usage.day !== day) usage = { day, calls: 0 };
  return usage.calls;
}

/** Count one billable call. Every fetch below goes through this first. */
function spend(): void {
  callsToday();
  usage.calls += 1;
}

/** How many calls have been spent today — read by nothing but diagnostics. */
export function hereCallsToday(): number {
  return callsToday();
}

export function hereConfigured(): boolean {
  return Boolean(process.env.HERE_API_KEY) && callsToday() < HERE_DAILY_BUDGET;
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
 * Type-ahead suggestions.
 *
 * Uses `/autocomplete`, not `/autosuggest`. Autosuggest is point-of-interest
 * weighted: typing "newar" returns PATH-Newark Station, Newark City Hall and a
 * phone shop, but never the city of Newark -- useless for "where are you" or
 * "pick up near". Autocomplete returns localities and addresses, correctly
 * ranked, and handles partials that geocoding fumbles ("phila" -> Philadelphia,
 * where /geocode returns Phila St in Saratoga Springs).
 *
 * The trade is that autocomplete carries no coordinates. Rather than pay a
 * lookup per keystroke, items come back with a `hereId` and are resolved only
 * when the user actually picks one -- see `hereLookupPosition`.
 */
export async function hereAutocomplete(q: string): Promise<HerePlace[]> {
  if (!hereConfigured() || q.trim().length < 2) return [];

  const url = new URL(AUTOCOMPLETE);
  url.searchParams.set("q", q);
  url.searchParams.set("in", "countryCode:USA");
  url.searchParams.set("limit", "8");
  url.searchParams.set("apiKey", key());

  spend();
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return [];

  const json = (await res.json()) as { items?: HereItem[] };
  return (json.items ?? [])
    .map((item) => {
      const a = item.address ?? {};
      const state = a.stateCode ?? a.state ?? null;
      const city = a.city ?? null;
      const isAddress = item.resultType === "houseNumber" || item.resultType === "street";

      // A city needs "City, ST"; a street address needs the street too.
      const short = isAddress
        ? (a.label ?? "").replace(/, United States$/, "")
        : [city, state].filter(Boolean).join(", ") || (a.label ?? "").replace(/, United States$/, "");
      if (!short) return null;

      return {
        id: item.id ?? short,
        label: (a.label ?? short).replace(/, United States$/, ""),
        short,
        // Resolved on pick.
        lat: 0,
        lng: 0,
        city,
        state,
        postalCode: a.postalCode ?? null,
        precision: precisionOf(item.resultType, item.localityType),
      } satisfies HerePlace;
    })
    .filter((p): p is HerePlace => p !== null);
}

/** The address parts a lookup or reverse geocode can give back. */
export interface HereAddress {
  city: string | null;
  state: string | null;
  postalCode: string | null;
}

/**
 * Turn an autocomplete result id into coordinates. One call, on selection.
 *
 * The address parts come back too, because the caller almost always needs them:
 * the post form fills `pickupState`/`pickupZip` from a picked suggestion, and
 * the admin console builds a learned place out of city/state/zip. They are on
 * the same response, so asking for them costs nothing extra.
 */
export async function hereLookupPosition(
  id: string,
): Promise<{ lat: number; lng: number; address: HereAddress | null } | null> {
  if (!hereConfigured() || !id) return null;

  const url = new URL(LOOKUP);
  url.searchParams.set("id", id);
  url.searchParams.set("apiKey", key());

  spend();
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;

  const json = (await res.json()) as HereItem;
  const pos = json.position ?? json.access?.[0];
  if (!pos) return null;

  const a = json.address;
  return {
    lat: pos.lat,
    lng: pos.lng,
    address: a
      ? {
          city: a.city ?? null,
          state: a.stateCode ?? a.state ?? null,
          postalCode: a.postalCode ?? null,
        }
      : null,
  };
}

/** Resolve a full place string to coordinates. */
export async function hereGeocode(q: string): Promise<HerePlace | null> {
  if (!hereConfigured() || !q.trim()) return null;

  const url = new URL(GEOCODE);
  url.searchParams.set("q", q);
  url.searchParams.set("in", "countryCode:USA");
  url.searchParams.set("limit", "1");
  url.searchParams.set("apiKey", key());

  spend();
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;

  const json = (await res.json()) as { items?: HereItem[] };
  const first = json.items?.[0];
  return first ? toPlace(first) : null;
}

/**
 * Coordinates -> a place label. This is the server half of "Use GPS".
 *
 * The browser gives a precise position and nothing a human recognises; the
 * driver needs to see "Miami, FL" to believe the board is sorted around them.
 * The coordinates the caller supplied stay authoritative — only the label comes
 * from here, so a wrong or missing reverse geocode can never move the pin.
 */
export async function hereReverseGeocode(
  lat: number,
  lng: number,
): Promise<{ label: string; city: string | null; state: string | null; zip: string | null } | null> {
  if (!hereConfigured() || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const url = new URL(REVGEOCODE);
  url.searchParams.set("at", `${lat},${lng}`);
  url.searchParams.set("lang", "en-US");
  url.searchParams.set("limit", "1");
  url.searchParams.set("apiKey", key());

  spend();
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;

  const json = (await res.json()) as { items?: HereItem[] };
  const a = json.items?.[0]?.address;
  if (!a) return null;

  const city = a.city ?? null;
  const state = a.stateCode ?? a.state ?? null;
  const label =
    [city, state].filter(Boolean).join(", ") ||
    (a.label ?? "").replace(/, United States$/, "") ||
    "Your location";

  return { label, city, state, zip: a.postalCode ?? null };
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

  spend();
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
