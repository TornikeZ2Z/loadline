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
import { hashPassword } from "../src/lib/password";
import { ingestMessage } from "../src/lib/pipeline/ingest";
import { processPending } from "../src/lib/pipeline/process";
import { expireStaleLoads } from "../src/lib/pipeline/expire";
import { GROUPS, MESSAGES } from "./seed-data";

const DEMO_USERS = [
  {
    email: "carrier@example.com",
    password: "demo1234",
    name: "Dan Carrier",
    role: "carrier",
    phone: "+19735550000",
    company: "Kaz Trucking LLC",
    home_label: "Newark, NJ",
    home_lat: 40.7357,
    home_lng: -74.1724,
  },
  {
    email: "broker@example.com",
    password: "demo1234",
    name: "Rosa Broker",
    role: "broker",
    phone: "+19085557788",
    company: "Rosa Logistics",
    home_label: "Philadelphia, PA",
    home_lat: 39.9526,
    home_lng: -75.1652,
  },
  {
    email: "admin@example.com",
    password: "demo1234",
    name: "Ops Admin",
    role: "admin",
    phone: null,
    company: null,
    home_label: "Newark, NJ",
    home_lat: 40.7357,
    home_lng: -74.1724,
  },
];

async function main() {
  console.log(`database backend: ${await dbKind()}`);
  console.log("extractor: deterministic rules (no API, no cost)");

  for (const u of DEMO_USERS) {
    await query(
      `INSERT INTO users (email, password_hash, name, role, phone, company, home_label, home_lat, home_lng)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (email) DO NOTHING`,
      [u.email, hashPassword(u.password), u.name, u.role, u.phone, u.company, u.home_label, u.home_lat, u.home_lng],
    );
  }
  console.log(`users: ${DEMO_USERS.length} demo accounts (password "demo1234")`);

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
  console.log("\nsign in at http://localhost:3000/login as carrier@example.com / demo1234");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
