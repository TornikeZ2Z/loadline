/** Drain the pending message queue. npm run process */
import { processPending } from "../src/lib/pipeline/process";

async function main() {
  const results = await processPending(200);
  if (!results.length) return console.log("nothing pending");
  for (const r of results) {
    console.log(`  msg ${r.messageId}: ${r.status} (+${r.loadsCreated} loads${r.duplicates ? `, ${r.duplicates} dup` : ""})${r.reason ? ` -- ${r.reason}` : ""}`);
  }
  console.log(`${results.length} messages processed`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
