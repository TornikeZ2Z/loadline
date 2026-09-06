/**
 * Making a live board's ZIPs precise.
 *
 * The pipeline never blocks an insert on a geocoder. A destination written as
 * "FL 33180" is stored the moment it is read, and if HERE is unreachable — no
 * key, spent budget, an outage — `geocodeZip` falls back to `zipApprox`: the
 * nearest gazetteer city inside the ZIP's own state, honestly recorded as
 * precision `state`, source `zip-approx`. That is the right trade at ingest
 * time. It is the wrong thing to leave on the map, because a state-precision
 * point draws as a hollow "approximate" marker sitting nowhere near the job.
 *
 * `npm run zips:warm` fixed that locally by walking the board's ZIPs with a key
 * configured. Production could never run it: the database is inside a VPC and
 * nothing outside can reach it. So the same work lives here, callable from an
 * admin route, and the script became a thin wrapper around it.
 *
 * Three properties this has to hold, because the caller is a button:
 *
 *   - **Idempotent.** A ZIP already answered by a real geocoder is skipped
 *     without an API call, and a job endpoint already at zip/city/address
 *     precision is never touched. The second run reports zeroes.
 *   - **Bounded.** One call visits at most `limit` ZIPs and returns a cursor.
 *     A board with ten thousand ZIPs is swept in batches by a caller that can
 *     stop, rather than by one request held open for ten minutes.
 *   - **Cheap to be wrong.** Every fetch goes through `geocodeZip`, so it
 *     obeys the daily budget in here.ts, and a ZIP the router cannot place
 *     keeps its approximation instead of losing its point.
 *
 * What it deliberately does NOT do: reprocess messages. Re-running the
 * extractor would rebuild labels, flags and review state from rules that may
 * have moved since, which is a much larger blast radius than "this marker is
 * in the wrong place". Only coordinates, precision and the caches that depend
 * on them are rewritten.
 */
import { query } from "@/lib/db";
import { haversineMiles } from "./math";
import { geocodeZip, type Precision } from "./geocode";
import { HERE_DAILY_BUDGET, hereCallsToday, hereConfigured } from "./here";

/** Precisions that draw as "approximate", and so are worth upgrading. */
const COARSE: ReadonlySet<string> = new Set(["state", "region"]);

/**
 * `places.precision` is free text; `loads.*_precision` has a CHECK constraint.
 * A cache row written by some future provider with a word the loads table does
 * not accept would turn this sweep into a 500, so it is filtered, not cast.
 */
const PRECISIONS: ReadonlySet<string> = new Set(["address", "zip", "city", "region", "state"]);

/** SQL for the same test, for one end of the lane. */
function coarseSql(end: "pickup" | "delivery"): string {
  return `(${end}_precision IS NULL OR ${end}_precision IN ('state', 'region'))`;
}

/** Default ZIPs per call: ~40 HERE calls, a few seconds, well inside any timeout. */
export const WARM_BATCH = 40;
export const WARM_BATCH_MAX = 200;

export interface ZipSurvey {
  /** Distinct ZIPs the board's jobs point at. */
  boardZips: number;
  /** ZIPs whose cached answer came from a real geocoder. */
  precise: number;
  /** ZIPs cached only as an in-state approximation. */
  approximate: number;
  /** ZIPs never geocoded at all. */
  uncached: number;
  /** Job endpoints still drawn at state/region precision. */
  coarsePickups: number;
  coarseDeliveries: number;
  /** ZIPs a full sweep would still visit — the work left to do. */
  pending: number;
}

export interface HereStatus {
  configured: boolean;
  callsToday: number;
  budget: number;
}

export interface ZipWarmResult {
  /** Where the board stands *after* this call. */
  survey: ZipSurvey;
  /** ZIPs this call looked at. */
  examined: number;
  /** ZIPs geocoded for the first time. */
  fetched: number;
  /** Approximations replaced by a real answer. */
  upgraded: number;
  /** ZIPs already precise, so not asked about again. */
  skipped: number;
  /** ZIPs asked about that came back approximate anyway (no key, spent budget, router said no). */
  unresolved: number;
  /** Job rows whose point moved. */
  loadsUpdated: number;
  pickupsUpgraded: number;
  deliveriesUpgraded: number;
  here: HereStatus & { spent: number };
  /** Pass back as `after` to continue the sweep; null when the sweep is done. */
  nextAfter: string | null;
  /** ZIPs still ahead of the cursor. */
  remaining: number;
  done: boolean;
}

interface CachedZip {
  zip: string;
  source: string;
  precision: string;
  city: string | null;
  state: string | null;
  lat: number;
  lng: number;
}

/** Five digits, or null for anything that is not a US ZIP. */
function zip5(raw: string | null): string | null {
  const z = (raw ?? "").replace(/\D/g, "").slice(0, 5);
  return z.length === 5 ? z : null;
}

/** Every `zip:` row in the places cache, keyed by the bare five digits. */
async function cachedZips(): Promise<Map<string, CachedZip>> {
  const rows = await query<{
    query: string; source: string; precision: string;
    city: string | null; state: string | null; lat: number; lng: number;
  }>(
    `SELECT query, source, precision, city, state, lat, lng FROM places WHERE query LIKE 'zip:%'`,
  );
  const map = new Map<string, CachedZip>();
  for (const r of rows) {
    const z = r.query.slice(4);
    map.set(z, { zip: z, source: r.source, precision: r.precision, city: r.city, state: r.state, lat: r.lat, lng: r.lng });
  }
  return map;
}

/** Distinct ZIPs on the board, as the rows actually store them. */
async function boardZips(): Promise<string[]> {
  const rows = await query<{ zip: string }>(
    `SELECT DISTINCT delivery_zip AS zip FROM loads WHERE delivery_zip IS NOT NULL
     UNION
     SELECT DISTINCT pickup_zip AS zip FROM loads WHERE pickup_zip IS NOT NULL
     ORDER BY zip`,
  );
  return rows.map((r) => r.zip);
}

/** ZIPs with at least one job endpoint still plotted at state/region precision. */
async function coarseZips(): Promise<Set<string>> {
  const rows = await query<{ zip: string }>(
    `SELECT DISTINCT delivery_zip AS zip FROM loads
       WHERE delivery_zip IS NOT NULL AND ${coarseSql("delivery")}
     UNION
     SELECT DISTINCT pickup_zip AS zip FROM loads
       WHERE pickup_zip IS NOT NULL AND ${coarseSql("pickup")}`,
  );
  return new Set(rows.map((r) => r.zip));
}

/**
 * The work list: every board ZIP that either still needs a geocoder answer or
 * still has a job sitting on an approximate point.
 *
 * The second half matters for resumability. A call that geocoded a ZIP and then
 * died before updating its jobs would otherwise leave those jobs stranded —
 * the ZIP is cached and precise, so a cache-only work list would skip it
 * forever. Asking the jobs, not just the cache, makes the sweep self-healing.
 */
function pendingZips(
  board: string[],
  cache: Map<string, CachedZip>,
  coarse: Set<string>,
  onlyCoarse = false,
): string[] {
  return board.filter((raw) => {
    if (coarse.has(raw)) return true;
    if (onlyCoarse) return false;
    const z = zip5(raw);
    if (!z) return false;
    const hit = cache.get(z);
    return !hit || hit.source === "zip-approx";
  });
}

/** Counts only — no geocoding, no writes, nothing billable. */
export async function surveyBoardZips(): Promise<ZipSurvey> {
  const [board, cache, coarse] = await Promise.all([boardZips(), cachedZips(), coarseZips()]);
  const counts = await query<{ coarse_pickups: number; coarse_deliveries: number }>(
    `SELECT (SELECT count(*) FROM loads WHERE pickup_zip IS NOT NULL AND ${coarseSql("pickup")})::int AS coarse_pickups,
            (SELECT count(*) FROM loads WHERE delivery_zip IS NOT NULL AND ${coarseSql("delivery")})::int AS coarse_deliveries`,
  );

  let precise = 0;
  let approximate = 0;
  let uncached = 0;
  for (const raw of board) {
    const hit = zip5(raw) ? cache.get(zip5(raw)!) : undefined;
    if (!hit) uncached += 1;
    else if (hit.source === "zip-approx") approximate += 1;
    else precise += 1;
  }

  return {
    boardZips: board.length,
    precise,
    approximate,
    uncached,
    coarsePickups: counts[0]?.coarse_pickups ?? 0,
    coarseDeliveries: counts[0]?.coarse_deliveries ?? 0,
    pending: pendingZips(board, cache, coarse).length,
  };
}

export function hereStatus(): HereStatus {
  return {
    // `hereConfigured()` folds "no key" and "budget spent" together; the console
    // needs to tell those apart, so the key is tested on its own here.
    configured: Boolean(process.env.HERE_API_KEY),
    callsToday: hereCallsToday(),
    budget: HERE_DAILY_BUDGET,
  };
}

export interface WarmOptions {
  /** ZIPs to visit in this call. */
  limit?: number;
  /** Resume after this ZIP — the previous call's `nextAfter`. */
  after?: string | null;
  /**
   * Visit only ZIPs with a job still drawn approximate, skipping ZIPs that are
   * merely uncached. `resetDemoData` uses this: a reset that ran with a key
   * configured already cached every ZIP the pipeline needed, and paying for the
   * ones it did not need buys nothing anybody can see.
   */
  onlyCoarse?: boolean;
}

/**
 * Warm one batch of the board's ZIPs and move the jobs that were waiting on
 * them. Safe to call repeatedly; the second sweep is a no-op.
 */
export async function warmBoardZips(opts: WarmOptions = {}): Promise<ZipWarmResult> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? WARM_BATCH) || WARM_BATCH, 1), WARM_BATCH_MAX);
  const after = opts.after ?? null;
  const callsAtStart = hereCallsToday();

  const [board, before, coarse] = await Promise.all([boardZips(), cachedZips(), coarseZips()]);
  const pending = pendingZips(board, before, coarse, opts.onlyCoarse).filter((z) => (after ? z > after : true));
  const batch = pending.slice(0, limit);

  let fetched = 0;
  let upgraded = 0;
  let skipped = 0;
  let unresolved = 0;

  // Concurrency 4, matching `geocodeDestinations`: enough to keep a batch under
  // a couple of seconds, far short of anything HERE would call a stampede.
  let next = 0;
  const worker = async () => {
    while (next < batch.length) {
      const raw = batch[next++]!;
      const z = zip5(raw);
      if (!z) { skipped += 1; continue; }
      const was = before.get(z);

      // Already answered by a real geocoder: this ZIP is only in the batch
      // because some job still points at an old approximation, and the update
      // pass below fixes that for free.
      if (was && was.source !== "zip-approx") { skipped += 1; continue; }

      // No key, or today's budget is gone. Re-fetching an approximation would
      // delete a good-enough row and write the identical one back.
      if (was && !hereConfigured()) { skipped += 1; continue; }

      const r = await geocodeZip(z, { force: was?.source === "zip-approx" });
      if (!r) { skipped += 1; continue; }
      if (r.source === "zip-approx") unresolved += 1;
      else if (was) upgraded += 1;
      else fetched += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, batch.length) }, worker));

  const moved = await upgradeLoads(batch, before);

  const survey = await surveyBoardZips();
  const nextAfter = pending.length > batch.length ? (batch[batch.length - 1] ?? null) : null;

  return {
    survey,
    examined: batch.length,
    fetched,
    upgraded,
    skipped,
    unresolved,
    ...moved,
    here: { ...hereStatus(), spent: hereCallsToday() - callsAtStart },
    nextAfter,
    remaining: Math.max(pending.length - batch.length, 0),
    done: nextAfter === null,
  };
}

interface MovedCounts {
  loadsUpdated: number;
  pickupsUpgraded: number;
  deliveriesUpgraded: number;
}

interface CoarseEnd {
  id: number;
  zip: string;
  state: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  other_lat: number | null;
  other_lng: number | null;
}

/**
 * Move every job endpoint that these ZIPs can now place better.
 *
 * The rules mirror `geocodeDestination`, deliberately narrowly:
 *
 *   - only endpoints currently at state/region precision — a point that came
 *     from the gazetteer, a learned place or an address match is already
 *     better than a ZIP centroid and is left alone;
 *   - never when the job's own written state disagrees with the ZIP's state.
 *     `geocodeDestination` chose the written state's centroid on purpose there
 *     ("FL 90210" is a typo, and the state is the more trustworthy half);
 *   - `trip_miles` is recomputed, and the cached road route is dropped, because
 *     both were measured to the old point. They refill on the next open.
 */
async function upgradeLoads(zips: string[], before: Map<string, CachedZip>): Promise<MovedCounts> {
  const empty: MovedCounts = { loadsUpdated: 0, pickupsUpgraded: 0, deliveriesUpgraded: 0 };
  if (!zips.length) return empty;

  const keys = [...new Set(zips.map(zip5).filter((z): z is string => z !== null))].map((z) => `zip:${z}`);
  if (!keys.length) return empty;

  const rows = await query<{
    query: string; city: string | null; state: string | null;
    lat: number; lng: number; precision: string; source: string;
  }>(
    `SELECT query, city, state, lat, lng, precision, source FROM places WHERE query = ANY($1::text[])`,
    [keys],
  );
  const now = new Map(rows.map((r) => [r.query.slice(4), r]));

  const touched = new Set<number>();
  const deliveries = await upgradeEnd("delivery", zips, before, now, touched);
  const pickups = await upgradeEnd("pickup", zips, before, now, touched);

  return { loadsUpdated: touched.size, pickupsUpgraded: pickups, deliveriesUpgraded: deliveries };
}

async function upgradeEnd(
  end: "pickup" | "delivery",
  zips: string[],
  before: Map<string, CachedZip>,
  now: Map<string, { city: string | null; state: string | null; lat: number; lng: number; precision: string; source: string }>,
  touched: Set<number>,
): Promise<number> {
  const other = end === "pickup" ? "delivery" : "pickup";
  const rows = await query<CoarseEnd>(
    `SELECT id, ${end}_zip AS zip, ${end}_state AS state, ${end}_city AS city,
            ${end}_lat AS lat, ${end}_lng AS lng,
            ${other}_lat AS other_lat, ${other}_lng AS other_lng
       FROM loads
      WHERE ${end}_zip = ANY($1::text[]) AND ${coarseSql(end)}`,
    [zips],
  );

  let moved = 0;
  for (const row of rows) {
    const z = zip5(row.zip);
    const place = z ? now.get(z) : undefined;
    if (!place || COARSE.has(place.precision) || !PRECISIONS.has(place.precision)) continue;

    // A ZIP that contradicts the written state was placed at the state centroid
    // on purpose. Upgrading it would move the job into the wrong state.
    const rowState = row.state?.toUpperCase() ?? null;
    const zipState = place.state?.toUpperCase() ?? null;
    if (rowState && zipState && rowState !== zipState) continue;

    const same =
      row.lat !== null && row.lng !== null &&
      Math.abs(row.lat - place.lat) < 1e-7 && Math.abs(row.lng - place.lng) < 1e-7;

    // The city stored on a destination came from the geocoder, so when the old
    // answer was the in-state approximation the stored city is that
    // approximation's city — "Orlando" for a Miami ZIP. Replace it, but only
    // when it is still exactly that: a city the post itself stated, or one the
    // pipeline took from the extractor, is the poster's word and stays.
    const wasApprox = z ? before.get(z) : undefined;
    const cityFromApprox =
      end === "delivery" &&
      wasApprox?.source === "zip-approx" &&
      row.city !== null &&
      wasApprox.city === row.city;
    const city = cityFromApprox ? (place.city ?? row.city) : row.city;

    // No early exit on "the point did not move": the row is here because its
    // precision is coarse and the place's is not, so at minimum that word is
    // wrong and the map is calling a real ZIP point approximate.
    const trip =
      row.other_lat !== null && row.other_lng !== null
        ? haversineMiles({ lat: place.lat, lng: place.lng }, { lat: row.other_lat, lng: row.other_lng })
        : null;

    // Only a genuine move invalidates the cached road route; a city-name
    // correction alone must not throw away a billable router answer.
    const routeSql = same ? "" : ", road_miles = NULL, road_minutes = NULL, road_path = NULL";

    await query(
      `UPDATE loads
          SET ${end}_lat = $1, ${end}_lng = $2, ${end}_precision = $3, ${end}_city = $4,
              trip_miles = COALESCE($5::float8, trip_miles)${routeSql},
              updated_at = now()
        WHERE id = $6`,
      [place.lat, place.lng, place.precision as Precision, city, same ? null : trip, row.id],
    );
    touched.add(row.id);
    moved += 1;
  }

  return moved;
}
