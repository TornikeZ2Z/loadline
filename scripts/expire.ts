/** Run the expiry sweeps. npm run expire */
import { expireStaleLoads } from "../src/lib/pipeline/expire";
import { expireTrucks } from "../src/lib/pipeline/trucks";

async function main() {
  const { expired } = await expireStaleLoads();
  const { trucksDeparted, trucksExpired } = await expireTrucks();
  // Three lines, never a total: a job whose sender went silent, a truck that
  // drove away and a truck nobody dated are three different things.
  console.log(`${expired} loads expired`);
  console.log(`${trucksDeparted} trucks departed`);
  console.log(`${trucksExpired} trucks expired`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
