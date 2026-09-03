/**
 * Location normalization + geocoding.
 *
 * Resolution order, cheapest first:
 *   1. `places` cache        (a place is ever geocoded once)
 *   2. explicit "lat,lng"    (map clicks, browser geolocation)
 *   3. alias table           ("philly", "socal", "north jersey")
 *   4. offline gazetteer     ("Newark, NJ", "07102", bare state, region)
 *   5. remote provider       (Census or Mapbox, only if GEOCODER says so)
 *
 * `precision` records how specific the answer is, so the UI can be honest:
 * a load posted as "somewhere in Florida" gets a state centroid and is not
 * presented as if its pickup were pinned to a street address.
 */
import { query, queryOne } from "@/lib/db";
import { CITIES, CITY_BY_KEY, CITY_BY_NAME, nearestCity, type City } from "./cities";
import { REGIONS, STATE_BY_ABBR, resolveState, stateForZip } from "./states";
import { lookupAlias, normalizePlaceQuery } from "./aliases";

export type Precision = "address" | "zip" | "city" | "region" | "state";

export interface GeocodeResult {
  label: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  lat: number;
  lng: number;
  precision: Precision;
  source: string;
}

const ZIP_RE = /^\d{5}(?:-\d{4})?$/;
const LATLNG_RE = /^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/;
// "Newark, NJ" / "Newark NJ" / "Newark, NJ 07102"
const CITY_STATE_RE = /^(.+?)[,\s]+([a-z]{2})(?:\s+(\d{5}))?$/;

function cityResult(c: City, source: string, zip?: string | null): GeocodeResult {
  const z = zip ?? null;
  return {
    label: z ? `${c.city}, ${c.state} ${z}` : `${c.city}, ${c.state}`,
    city: c.city,
    state: c.state,
    zip: z,
    lat: c.lat,
    lng: c.lng,
    precision: z ? "zip" : "city",
    source,
  };
}

/** Resolve a free-text place. Returns null when nothing plausible matches. */
export async function geocode(raw: string): Promise<GeocodeResult | null> {
  const input = (raw ?? "").trim();
  if (!input) return null;

  const normalized = normalizePlaceQuery(input);
  if (!normalized) return null;

  const cached = await queryOne<{
    label: string; city: string | null; state: string | null; zip: string | null;
    lat: number; lng: number; precision: string; source: string;
  }>(`SELECT label, city, state, zip, lat, lng, precision, source FROM places WHERE query = $1`, [
    normalized,
  ]);
  if (cached) return { ...cached, precision: cached.precision as Precision };

  const result = await resolve(input, normalized);
  if (result) await cache(normalized, result);
  return result;
}

async function cache(normalized: string, r: GeocodeResult): Promise<void> {
  await query(
    `INSERT INTO places (query, label, city, state, zip, lat, lng, precision, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (query) DO NOTHING`,
    [normalized, r.label, r.city, r.state, r.zip, r.lat, r.lng, r.precision, r.source],
  );
}

async function resolve(input: string, normalized: string): Promise<GeocodeResult | null> {
  // 2. raw coordinates
  const coords = input.trim().match(LATLNG_RE);
  if (coords) {
    const lat = Number(coords[1]);
    const lng = Number(coords[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      const near = nearestCity(lat, lng);
      return {
        label: near ? `near ${near.city}, ${near.state}` : `${lat.toFixed(3)}, ${lng.toFixed(3)}`,
        city: near?.city ?? null,
        state: near?.state ?? null,
        zip: null,
        lat,
        lng,
        precision: "address",
        source: "coordinates",
      };
    }
  }

  // 3. informal names
  const alias = lookupAlias(normalized);
  if (alias) {
    if (alias.city) {
      const c = CITY_BY_KEY.get(alias.city.toLowerCase());
      if (c) return { ...cityResult(c, "alias"), label: c.city + ", " + c.state };
    }
    if (alias.region) {
      const region = REGIONS[alias.region];
      if (region) {
        return {
          label: region.label,
          city: null,
          state: alias.state ?? null,
          zip: null,
          lat: region.lat,
          lng: region.lng,
          precision: "region",
          source: "alias",
        };
      }
    }
    if (alias.state) {
      const s = STATE_BY_ABBR.get(alias.state);
      if (s) {
        return {
          label: s.name,
          city: null, state: s.abbr, zip: null,
          lat: s.lat, lng: s.lng,
          precision: "state", source: "alias",
        };
      }
    }
  }

  // 4a. bare ZIP
  const zipOnly = normalized.replace(/\s/g, "");
  if (ZIP_RE.test(zipOnly)) {
    const zip5 = zipOnly.slice(0, 5);
    const remote = await remoteGeocode(zip5);
    if (remote) return remote;
    const state = stateForZip(zip5);
    if (state) {
      // No exact ZIP centroid offline; anchor on the nearest gazetteer city in
      // that state and mark it as ZIP-level so the UI can show the caveat.
      const inState = CITIES.filter((c) => c.state === state.abbr);
      const best =
        inState.find((c) => c.zip.slice(0, 3) === zip5.slice(0, 3)) ??
        closestByZip(inState, zip5) ??
        null;
      if (best) return { ...cityResult(best, "gazetteer", zip5), precision: "zip" };
      return {
        label: `${zip5} (${state.abbr})`,
        city: null, state: state.abbr, zip: zip5,
        lat: state.lat, lng: state.lng,
        precision: "state", source: "gazetteer",
      };
    }
  }

  // 4b. region name
  const region = REGIONS[normalized.replace(/[\s,]/g, "")];
  if (region) {
    return {
      label: region.label, city: null, state: null, zip: null,
      lat: region.lat, lng: region.lng, precision: "region", source: "gazetteer",
    };
  }

  // 4c. bare state
  const asState = resolveState(normalized);
  if (asState) {
    return {
      label: asState.name, city: null, state: asState.abbr, zip: null,
      lat: asState.lat, lng: asState.lng, precision: "state", source: "gazetteer",
    };
  }

  // 4d. "City, ST" / "City ST 07102"
  const m = normalized.match(CITY_STATE_RE);
  if (m) {
    const [, cityPart, statePart, zipPart] = m;
    const st = resolveState(statePart);
    if (st) {
      const c = CITY_BY_KEY.get(`${cityPart.trim()}, ${st.abbr.toLowerCase()}`);
      if (c) return cityResult(c, "gazetteer", zipPart ?? null);

      // The city half may itself be a nickname: "jax fl", "philly pa",
      // "atl ga". The alias pass above only saw the whole string, so retry it
      // on the city alone now that the state has been split off.
      const cityAlias = lookupAlias(normalizePlaceQuery(cityPart));
      if (cityAlias?.city) {
        const aliased = CITY_BY_KEY.get(cityAlias.city.toLowerCase());
        // Only trust the nickname if it agrees with the stated state, so
        // "Springfield, MA" is never quietly rewritten to a different state.
        if (aliased && aliased.state === st.abbr) {
          return cityResult(aliased, "alias", zipPart ?? null);
        }
      }

      const remote = await remoteGeocode(`${cityPart}, ${st.abbr}`);
      if (remote) return remote;
      // Unknown town, known state: keep the town name, place it at the state
      // center, and be explicit that this is state-level precision.
      const title = titleCase(cityPart);
      return {
        label: `${title}, ${st.abbr}`,
        city: title, state: st.abbr, zip: zipPart ?? null,
        lat: st.lat, lng: st.lng,
        precision: "state", source: "gazetteer",
      };
    }
  }

  // 4e. bare city name -- ambiguous, take the first (list is population-ordered)
  const byName = CITY_BY_NAME.get(normalized.replace(/,.*$/, "").trim());
  if (byName?.length) return cityResult(byName[0], "gazetteer");

  // 5. remote
  return remoteGeocode(input);
}

function closestByZip(cities: City[], zip: string): City | null {
  if (!cities.length) return null;
  const target = Number(zip);
  return cities.reduce((best, c) =>
    Math.abs(Number(c.zip) - target) < Math.abs(Number(best.zip) - target) ? c : best,
  );
}

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

// ---------------------------------------------------------------------------
// Remote providers. Optional by design: the pipeline must not depend on a
// third-party geocoder being reachable to produce usable loads.
// ---------------------------------------------------------------------------

async function remoteGeocode(q: string): Promise<GeocodeResult | null> {
  const provider = process.env.GEOCODER ?? "local";
  try {
    if (provider === "census") return await censusGeocode(q);
    if (provider === "mapbox") return await mapboxGeocode(q);
  } catch {
    // A geocoder outage degrades precision, it does not fail the pipeline.
    return null;
  }
  return null;
}

async function censusGeocode(q: string): Promise<GeocodeResult | null> {
  const url = new URL("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress");
  url.searchParams.set("address", q);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("format", "json");
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    result?: { addressMatches?: Array<{
      matchedAddress: string;
      coordinates: { x: number; y: number };
      addressComponents?: { city?: string; state?: string; zip?: string };
    }> };
  };
  const match = json.result?.addressMatches?.[0];
  if (!match) return null;
  const comp = match.addressComponents ?? {};
  return {
    label: match.matchedAddress,
    city: comp.city ? titleCase(comp.city.toLowerCase()) : null,
    state: comp.state ?? null,
    zip: comp.zip ?? null,
    lat: match.coordinates.y,
    lng: match.coordinates.x,
    precision: "address",
    source: "census",
  };
}

async function mapboxGeocode(q: string): Promise<GeocodeResult | null> {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) return null;
  const url = new URL("https://api.mapbox.com/search/geocode/v6/forward");
  url.searchParams.set("q", q);
  url.searchParams.set("country", "us");
  url.searchParams.set("limit", "1");
  url.searchParams.set("access_token", token);
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    features?: Array<{
      properties: {
        full_address?: string; name?: string;
        feature_type?: string;
        context?: { place?: { name?: string }; region?: { region_code?: string }; postcode?: { name?: string } };
        coordinates: { latitude: number; longitude: number };
      };
    }>;
  };
  const f = json.features?.[0];
  if (!f) return null;
  const p = f.properties;
  const typeMap: Record<string, Precision> = {
    address: "address", street: "address", postcode: "zip",
    place: "city", locality: "city", district: "region", region: "state",
  };
  return {
    label: p.full_address ?? p.name ?? q,
    city: p.context?.place?.name ?? null,
    state: p.context?.region?.region_code ?? null,
    zip: p.context?.postcode?.name ?? null,
    lat: p.coordinates.latitude,
    lng: p.coordinates.longitude,
    precision: typeMap[p.feature_type ?? ""] ?? "city",
    source: "mapbox",
  };
}
