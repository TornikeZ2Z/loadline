/**
 * Seed the database with demo users and sample WhatsApp traffic, then run the
 * real pipeline over it.
 *
 *   npm run seed
 *
 * Messages are pushed through `ingestMessage` -- the same entry point the
 * Cloud API webhook uses -- so this exercises extraction, geocoding, dedup and
 * expiry exactly as production would.
 */
import { query, queryOne, dbKind } from "../src/lib/db";
import { ingestMessage } from "../src/lib/pipeline/ingest";
import { processPending } from "../src/lib/pipeline/process";
import { expireStaleLoads } from "../src/lib/pipeline/expire";
import { createDemoAccounts, DEMO_ACCOUNTS, DEMO_PASSWORD } from "../src/lib/demo/accounts";
import { GROUPS, MESSAGES } from "./seed-data";


async function main() {
  console.log(`database backend: ${await dbKind()}`);
  console.log("extractor: deterministic rules (no API, no cost)");

  await createDemoAccounts();
  console.log(`users: ${DEMO_ACCOUNTS.length} demo accounts (one-click sign-in, or password "${DEMO_PASSWORD}")`);

  for (const g of GROUPS) {
    await query(
      `INSERT INTO whatsapp_groups (wa_group_id, name, description)
       VALUES ($1,$2,$3) ON CONFLICT (wa_group_id) DO UPDATE SET description = EXCLUDED.description`,
      [g.waId, g.name, g.description],
    );
  }
  console.log(`groups: ${GROUPS.length}`);

  const groupIdByName = new Map(GROUPS.map((g) => [g.name, g.waId]));
  const now = Date.now();
  let ingested = 0;
  let skipped = 0;

  for (const [i, m] of MESSAGES.entries()) {
    const res = await ingestMessage({
      waMessageId: `seed.${i}.${m.group.replace(/\W/g, "")}`,
      body: m.body,
      sentAt: new Date(now - m.hoursAgo * 3_600_000),
      authorName: m.author,
      authorPhone: m.phone ?? null,
      groupWaId: groupIdByName.get(m.group) ?? null,
      groupName: m.group,
      payload: { source: "seed" },
    });
    if (res.duplicate) skipped++;
    else ingested++;
  }
  console.log(`messages: ${ingested} ingested, ${skipped} already present`);

  console.log("\nrunning pipeline...");
  const started = Date.now();
  const results = await processPending(MESSAGES.length + 10);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  const done = results.filter((r) => r.status === "done").length;
  const skippedMsgs = results.filter((r) => r.status === "skipped");
  const errors = results.filter((r) => r.status === "error");
  const created = results.reduce((n, r) => n + r.loadsCreated, 0);
  const dupes = results.reduce((n, r) => n + r.duplicates, 0);

  console.log(`  processed ${results.length} messages in ${elapsed}s`);
  console.log(`  ${done} produced loads, ${skippedMsgs.length} skipped as non-loads, ${errors.length} errored`);
  console.log(`  ${created} loads created, ${dupes} flagged as duplicates`);

  if (skippedMsgs.length) {
    const reasons = new Map<string, number>();
    for (const s of skippedMsgs) reasons.set(s.reason ?? "?", (reasons.get(s.reason ?? "?") ?? 0) + 1);
    console.log(`  skip reasons: ${[...reasons].map(([r, n]) => `${r} (${n})`).join(", ")}`);
  }
  for (const e of errors) console.log(`  ERROR message ${e.messageId}: ${e.reason}`);

  const { expired } = await expireStaleLoads();
  console.log(`  expiry sweep: ${expired} loads expired`);

  const summary = await queryOne<{ total: number; available: number; review: number; states: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'available' AND is_canonical)::int AS available,
            count(*) FILTER (WHERE needs_review)::int AS review,
            count(DISTINCT pickup_state)::int AS states
       FROM loads`,
  );
  console.log(
    `\nloads table: ${summary?.total} rows, ${summary?.available} live and canonical, ` +
      `${summary?.review} flagged for review, ${summary?.states} pickup states`,
  );
  console.log("
open http://localhost:3000 and press \"Sign in as Carrier\" -- no password needed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
