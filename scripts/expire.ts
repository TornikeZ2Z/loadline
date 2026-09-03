/** Run the expiry sweep. npm run expire */
import { expireStaleLoads } from "../src/lib/pipeline/expire";

async function main() {
  const { expired } = await expireStaleLoads();
  console.log(`${expired} loads expired`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
