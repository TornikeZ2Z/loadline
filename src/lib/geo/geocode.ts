/**
 * Location normalization + geocoding.
 *
 * Resolution order, cheapest first:
 *   1. `places` cache        (a place is ever geocoded once)
 *   2. explicit "lat,lng"    (map clicks, browser geolocation)
 *   3. alias table           ("philly", "socal", "north jersey")
 *   4. offline gazetteer     ("Newark, NJ", "07102", bare state, region)
 *   5. remote provider       (HERE whenever HERE_API_KEY is set and today's
 *                             budget is unspent; Census or Mapbox only when
 *                             GEOCODER names one of them)
 *
 * `precision` records how specific the answer is, so the UI can be honest:
 * a load posted as "somewhere in Florida" gets a state centroid and is not
 * presented as if its pickup were pinned to a street address.
 */
import { query, queryOne } from "@/lib/db";
import type { OriginRef } from "@/lib/extract/schema";
import { normalizeRuleKey, type LearnedPlace, type RuleSet } from "@/lib/extract/rules-store";
import { CITIES, CITY_BY_KEY, CITY_BY_NAME, nearestCity, type City } from "./cities";
import { REGIONS, STATE_BY_ABBR, resolveState, stateForZip } from "./states";
import { ALIASES, lookupAlias, normalizePlaceQuery } from "./aliases";
import { hereConfigured, hereGeocode } from "./here";

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
// Batch-post geocoding (A §6): origins and destinations from the extractor.
//
// Cache keys are prefixed -- zip:<5>, "city:<city>, <st>", q:<free text> --
// so a ZIP is looked up exactly once ever, and a HERE failure never blocks an
// insert: every step has an offline fallback, and the fallback is honest about
// its precision ("state" + source "zip-approx" for a ZIP nobody could place).
// ---------------------------------------------------------------------------

interface CachedPlace {
  label: string; city: string | null; state: string | null; zip: string | null;
  lat: number; lng: number; precision: string; source: string;
}

async function cachedKey(key: string): Promise<GeocodeResult | null> {
  const row = await queryOne<CachedPlace>(
    `SELECT label, city, state, zip, lat, lng, precision, source FROM places WHERE query = $1`,
    [key],
  );
  return row ? { ...row, precision: row.precision as Precision } : null;
}

async function cacheKey(key: string, r: GeocodeResult): Promise<void> {
  await cache(key, r);
}

function centroid(st: string): GeocodeResult | null {
  const s = STATE_BY_ABBR.get(st);
  if (!s) return null;
  return { label: s.name, city: null, state: s.abbr, zip: null, lat: s.lat, lng: s.lng, precision: "state", source: "state-centroid" };
}

function fromCity(c: City, source: string, zip: string | null = null): GeocodeResult {
  return { ...cityResult(c, source, zip), precision: "city" };
}

function fromLearned(p: LearnedPlace): GeocodeResult {
  return { label: p.label, city: p.city, state: p.state, zip: p.zip, lat: p.lat, lng: p.lng, precision: p.precision, source: "learned" };
}

/** HERE, guarded: null when unconfigured, on error, or when the state disagrees. */
async function here(q: string, expectState: string | null): Promise<GeocodeResult | null> {
  if (!hereConfigured()) return null;
  try {
    const hit = await hereGeocode(q);
    if (!hit) return null;
    if (expectState && hit.state && hit.state.toUpperCase() !== expectState) return null;
    return {
      label: hit.short || hit.label, city: hit.city, state: hit.state?.toUpperCase() ?? expectState,
      zip: hit.postalCode, lat: hit.lat, lng: hit.lng, precision: hit.precision, source: "here",
    };
  } catch {
    return null;
  }
}

/**
 * A ZIP nobody could place precisely: the nearest gazetteer city inside the
 * ZIP's own state supplies a POINT, and nothing else.
 *
 * It deliberately reports no city. The name would be a guess about where the
 * ZIP is, not a reading of what the sender wrote, and the guess is weaker than
 * it looks: `CITIES` is "deliberately curated rather than exhaustive" by its
 * own docblock — three entries for the whole of New Mexico — and when no entry
 * shares the ZIP's first three digits the tie-break is `closestByZip`, which
 * compares the ZIPs as NUMBERS. Numeric ZIP distance is not geography, so on a
 * thinly covered state it returns whatever is arithmetically nearest: NM 87825
 * answers "Santa Fe" because 87501 is 324 away, and FL 32606 answers "Orlando".
 *
 * Returning that name put it in `loads.delivery_city`, where the API served it
 * as fact and no flag disputed it: live, "VA 24040" read back as Roanoke and
 * "ID 83664" as Boise (§6.6). Whether a particular guess lands near the truth
 * is beside the point — the row was asserting a city the message never said.
 *
 * The coordinates stay: a nearby city beats a state centroid, and
 * `precision: "state"` already tells the map and the card to call the point
 * approximate. Only the claim goes.
 *
 * Downstream both writers fall back to the destination the message itself
 * carried — `process.ts` to `e.dest_city`, `web.ts` to the city the poster
 * typed — so a stated city is untouched and an unstated one is simply absent.
 * Once a real geocoder places the ZIP, `geo/zips.ts` fills the name in.
 */
function zipApprox(zip: string): GeocodeResult | null {
  const st = stateForZip(zip);
  if (!st) return null;
  const inState = CITIES.filter((c) => c.state === st.abbr);
  const best = inState.find((c) => c.zip.slice(0, 3) === zip.slice(0, 3)) ?? closestByZip(inState, zip);
  const at = best ?? st;
  return { label: `${st.abbr} ${zip}`, city: null, state: st.abbr, zip, lat: at.lat, lng: at.lng, precision: "state", source: "zip-approx" };
}

/**
 * One ZIP -> one point, one HERE call ever. `force` re-fetches a cached
 * approximation (scripts/warm-zips.ts, once a key is configured).
 */
export async function geocodeZip(zip: string, opts: { force?: boolean } = {}): Promise<GeocodeResult | null> {
  const z = zip.replace(/\D/g, "").slice(0, 5);
  if (z.length !== 5 || !stateForZip(z)) return null;
  const key = `zip:${z}`;
  const cached = await cachedKey(key);
  if (cached && !(opts.force && cached.source === "zip-approx")) return cached;

  const st = stateForZip(z)!.abbr;
  const remote = await here(z, null);
  let result: GeocodeResult | null = null;
  if (remote && (remote.zip === z || remote.precision === "zip" || remote.precision === "city")) {
    result = { ...remote, zip: z, state: remote.state ?? st, precision: "zip", label: remote.city ? `${remote.city}, ${remote.state ?? st} ${z}` : `${st} ${z}` };
  }
  if (!result) result = zipApprox(z);
  if (!result) return null;
  if (cached && opts.force) {
    await query(`DELETE FROM places WHERE query = $1`, [key]);
  }
  await cacheKey(key, result);
  return result;
}

async function geocodeCityState(city: string, st: string): Promise<GeocodeResult | null> {
  const key = `city:${city.toLowerCase()}, ${st.toLowerCase()}`;
  const cached = await cachedKey(key);
  if (cached) return cached;
  const g = CITY_BY_KEY.get(`${city.toLowerCase()}, ${st.toLowerCase()}`);
  if (g) return fromCity(g, "gazetteer");
  const alias = ALIASES[city.toLowerCase()];
  if (alias?.city) {
    const ac = CITY_BY_KEY.get(alias.city.toLowerCase());
    if (ac && ac.state === st) return { ...fromCity(ac, "alias"), label: `${titleCase(city.toLowerCase())}, ${st}` };
  }
  const remote = await here(`${city}, ${st}`, st);
  if (remote) {
    const r = { ...remote, city: remote.city ?? city, state: st, precision: (remote.precision === "state" ? "city" : remote.precision) as Precision };
    await cacheKey(key, r);
    return r;
  }
  return null;
}

export interface OriginGeocode {
  result: GeocodeResult | null;
  /** Flags the geocoder adds to the job: origin_unresolved, origin_zip_state_conflict. */
  flags: string[];
}

/**
 * Place an origin header (A §6.1). The label always comes from the header
 * text (the extractor built it); the geocoder only supplies coordinates,
 * precision and source.
 */
export async function geocodeOrigin(ref: OriginRef, hint: string | null, rules?: RuleSet): Promise<OriginGeocode> {
  const flags: string[] = [];
  // 1. learned place
  const learned = rules?.places[normalizeRuleKey(ref.raw_text)] ?? rules?.places[normalizeRuleKey(ref.label)];
  if (learned) return { result: fromLearned(learned), flags };

  const state = ref.state ?? hint;
  const city = ref.city;

  // 2. ZIP
  if (ref.zip) {
    const zs = stateForZip(ref.zip)?.abbr ?? null;
    if (zs && state && zs !== state) flags.push("origin_zip_state_conflict");
    const st = zs ?? state;
    if (city && st) {
      const g = CITY_BY_KEY.get(`${city.toLowerCase()}, ${st.toLowerCase()}`);
      if (g) return { result: { ...fromCity(g, "gazetteer", ref.zip), precision: "city" }, flags };
      const cached = await cachedKey(`zip:${ref.zip}`);
      if (cached) return { result: { ...cached, city: cached.city ?? city, precision: "zip" }, flags };
      const remote = await here(`${city}, ${st} ${ref.zip}`, st);
      if (remote) {
        const r: GeocodeResult = { ...remote, city, state: st, zip: ref.zip, precision: "zip" };
        await cacheKey(`zip:${ref.zip}`, r);
        return { result: r, flags };
      }
    }
    const z = await geocodeZip(ref.zip);
    if (z) return { result: { ...z, city: city ?? z.city, state: st ?? z.state }, flags };
    if (st) return { result: centroid(st), flags };
  }

  // 3. city + state
  if (city && state) {
    const r = await geocodeCityState(city, state);
    if (r) return { result: { ...r, city, state, zip: null }, flags };
    if (ref.context) {
      const ctxCity = CITY_BY_KEY.get(`${ref.context.toLowerCase()}, ${state.toLowerCase()}`);
      if (ctxCity) return { result: { ...fromCity(ctxCity, "context"), city, label: `${city}, ${state}` }, flags };
    }
    flags.push("origin_unresolved");
    return { result: centroid(state), flags };
  }

  // 4. city, no state (the extractor already tried the gazetteer/alias/hint)
  if (city) {
    const any = CITY_BY_NAME.get(city.toLowerCase());
    if (any?.length === 1) return { result: fromCity(any[0], "gazetteer"), flags };
    const remote = hint ? await here(`${city}, ${hint}`, null) : null;
    const remote2 = remote ?? (await here(city, null));
    if (remote2) {
      const r = { ...remote2, city: remote2.city ?? city };
      await cacheKey(`q:${normalizeRuleKey(city)}`, r);
      return { result: r, flags };
    }
    flags.push("origin_unresolved");
    return { result: null, flags };
  }

  // 5. state only
  if (state) return { result: centroid(state), flags };
  flags.push("origin_unresolved");
  return { result: null, flags };
}

export interface DestinationInput {
  state: string | null;
  zip: string | null;
  city: string | null;
}

/** Place one destination (A §6.2). web.ts and the pipeline both call this. */
export async function geocodeDestination(d: DestinationInput, rules?: RuleSet): Promise<GeocodeResult | null> {
  const st = d.state?.toUpperCase() ?? null;
  if (d.zip) {
    const z = await geocodeZip(d.zip);
    if (z) {
      // On a written/ZIP disagreement the ZIP point is used only when it agrees
      // with the written state; else the written state's centroid.
      if (st && z.state && z.state !== st) return centroid(st);
      return { ...z, state: st ?? z.state };
    }
    if (st) return centroid(st);
    return null;
  }
  if (d.city && st) {
    const r = await geocodeCityState(d.city, st);
    if (r) return { ...r, city: r.city ?? d.city, state: st };
    return centroid(st);
  }
  if (d.city) {
    const learned = rules?.places[normalizeRuleKey(d.city)];
    if (learned) return fromLearned(learned);
    const any = CITY_BY_NAME.get(d.city.toLowerCase());
    if (any?.length === 1) return fromCity(any[0], "gazetteer");
    const remote = await here(d.city, null);
    if (remote) {
      await cacheKey(`q:${normalizeRuleKey(d.city)}`, remote);
      return remote;
    }
    return null;
  }
  if (st) return centroid(st);
  return null;
}

/** Distinct keys, concurrency 4. Results align with the input list. */
export async function geocodeDestinations(list: DestinationInput[], rules?: RuleSet): Promise<Array<GeocodeResult | null>> {
  const keyOf = (d: DestinationInput) => `${d.state ?? ""}|${d.zip ?? ""}|${(d.city ?? "").toLowerCase()}`;
  const distinct = new Map<string, DestinationInput>();
  for (const d of list) if (!distinct.has(keyOf(d))) distinct.set(keyOf(d), d);
  const keys = [...distinct.keys()];
  const results = new Map<string, GeocodeResult | null>();
  let next = 0;
  const worker = async () => {
    while (next < keys.length) {
      const k = keys[next++];
      results.set(k, await geocodeDestination(distinct.get(k)!, rules));
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, keys.length) }, worker));
  return list.map((d) => results.get(keyOf(d)) ?? null);
}

// ---------------------------------------------------------------------------
// Remote providers. Optional by design: the pipeline must not depend on a
// third-party geocoder being reachable to produce usable loads.
// ---------------------------------------------------------------------------

async function remoteGeocode(q: string): Promise<GeocodeResult | null> {
  const provider = process.env.GEOCODER ?? (hereConfigured() ? "here" : "local");
  try {
    if (provider === "here") return await hereLookup(q);
    if (provider === "census") return await censusGeocode(q);
    if (provider === "mapbox") return await mapboxGeocode(q);
  } catch {
    // A geocoder outage degrades precision, it does not fail the pipeline.
    return null;
  }
  return null;
}

async function hereLookup(q: string): Promise<GeocodeResult | null> {
  const hit = await hereGeocode(q);
  if (!hit) return null;
  return {
    label: hit.short || hit.label,
    city: hit.city,
    state: hit.state,
    zip: hit.postalCode,
    lat: hit.lat,
    lng: hit.lng,
    precision: hit.precision,
    source: "here",
  };
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
