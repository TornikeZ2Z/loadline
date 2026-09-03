/** Drop all data (keeps schema). npm run db:reset */
import { exec, dbKind } from "../src/lib/db";

async function main() {
  console.log(`backend: ${await dbKind()}`);
  await exec(`TRUNCATE load_events, loads, raw_messages, saved_searches, places, whatsapp_groups, users RESTART IDENTITY CASCADE`);
  console.log("all tables truncated");
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
