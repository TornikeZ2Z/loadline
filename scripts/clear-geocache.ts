/**
 * Clear the geocode cache. npm run geocache:clear
 *
 * `places` memoizes every place string the system has ever resolved, which is
 * what keeps geocoding cheap. The flip side is that a place resolved badly
 * before you added an alias or a gazetteer entry stays resolved badly forever.
 * Run this after changing src/lib/geo/*, then re-run the pipeline over the
 * affected messages from the admin console.
 */
import { query } from "../src/lib/db";

async function main() {
  const rows = await query<{ query: string }>(`DELETE FROM places RETURNING query`);
  console.log(`cleared ${rows.length} cached place lookups`);
  console.log("re-run affected messages from /admin -> Message feed -> Re-run");
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
