/**
 * Pre-fetch a point for every destination ZIP the board has seen. npm run zips:warm
 *
 * Each ZIP costs one HERE call ever (the answer is cached in `places` as
 * zip:<5>). With no HERE_API_KEY the pipeline stores an honest approximation
 * (source 'zip-approx', the nearest gazetteer city in the ZIP's state); this
 * script upgrades those rows once a key is configured, and warms any ZIP that
 * is not cached at all.
 *
 * Note: tsx does not load .env.local -- pass the key explicitly:
 *   HERE_API_KEY=... npm run zips:warm
 */
import { query } from "../src/lib/db";
import { geocodeZip } from "../src/lib/geo/geocode";
import { hereConfigured } from "../src/lib/geo/here";

async function main() {
  const rows = await query<{ zip: string }>(
    `SELECT DISTINCT delivery_zip AS zip FROM loads WHERE delivery_zip IS NOT NULL
     UNION
     SELECT DISTINCT pickup_zip AS zip FROM loads WHERE pickup_zip IS NOT NULL
     ORDER BY zip`,
  );
  const cached = await query<{ query: string; source: string }>(`SELECT query, source FROM places WHERE query LIKE 'zip:%'`);
  const sourceByZip = new Map(cached.map((r) => [r.query.slice(4), r.source]));

  console.log(`${rows.length} distinct ZIPs on the board; ${cached.length} cached; HERE ${hereConfigured() ? "configured" : "NOT configured (offline approximations only)"}`);

  let fetched = 0;
  let upgraded = 0;
  let kept = 0;
  for (const { zip } of rows) {
    const src = sourceByZip.get(zip);
    if (src && src !== "zip-approx") { kept++; continue; }
    if (src === "zip-approx" && !hereConfigured()) { kept++; continue; }
    const r = await geocodeZip(zip, { force: src === "zip-approx" });
    if (!r) continue;
    if (src === "zip-approx") upgraded += r.source === "zip-approx" ? 0 : 1;
    else fetched++;
  }
  console.log(`fetched ${fetched}, upgraded ${upgraded} approximations, kept ${kept}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
