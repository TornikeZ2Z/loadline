/**
 * Drop all data (keeps schema). npm run db:reset [-- --all]
 *
 * Learned extraction rules and accepted pattern cases survive a plain reset:
 * they are the product of someone solving an unknown format once, and a reset
 * of the demo data must not undo that. `--all` empties them too.
 */
import { exec, dbKind } from "../src/lib/db";
import { RESET_TABLES } from "../src/lib/demo/reset";

async function main() {
  const all = process.argv.includes("--all");
  console.log(`backend: ${await dbKind()}`);
  await exec(`TRUNCATE ${RESET_TABLES}, saved_searches, users RESTART IDENTITY CASCADE`);
  if (all) {
    await exec(`TRUNCATE extraction_rules, pattern_cases RESTART IDENTITY CASCADE`);
    console.log("all tables truncated (including learned rules and pattern cases)");
  } else {
    console.log("all tables truncated (learned rules and pattern cases kept; use --all to drop them)");
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
