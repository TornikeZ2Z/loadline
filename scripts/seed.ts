/**
 * Seed the database with demo users and the sample WhatsApp corpus, then run
 * the real pipeline over it.
 *
 *   npm run seed
 *
 * Messages are pushed through `ingestMessage` -- the same entry point the
 * Cloud API webhook uses -- so this exercises extraction, geocoding,
 * supersession and expiry exactly as production would. Running it twice on
 * the same database is safe: messages already present are skipped and the
 * schema replays without error.
 */
import { query, queryOne, dbKind } from "../src/lib/db";
import { ingestMessage } from "../src/lib/pipeline/ingest";
import { processPending } from "../src/lib/pipeline/process";
import { expireStaleLoads } from "../src/lib/pipeline/expire";
import { createDemoAccounts, DEMO_ACCOUNTS, DEMO_PASSWORD } from "../src/lib/demo/accounts";
import { GROUPS, MESSAGES } from "../src/lib/demo/sample-messages";

async function main() {
  console.log(`database backend: ${await dbKind()}`);
  console.log("extractor: inventory-v1 -- deterministic rules (no API, no cost)");

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
  let present = 0;

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
    if (res.duplicate) present++;
    else ingested++;
  }
  console.log(`messages: ${ingested} ingested, ${present} already present`);

  console.log("\nrunning pipeline...");
  const started = Date.now();
  const results = await processPending(MESSAGES.length + 10);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  const done = results.filter((r) => r.status === "done").length;
  const skippedMsgs = results.filter((r) => r.status === "skipped");
  const errors = results.filter((r) => r.status === "error");
  const created = results.reduce((n, r) => n + r.loadsCreated, 0);

  console.log(`  processed ${results.length} messages in ${elapsed}s`);
  console.log(`  ${done} produced jobs, ${skippedMsgs.length} skipped, ${errors.length} errored, ${created} jobs created`);
  if (skippedMsgs.length) {
    const reasons = new Map<string, number>();
    for (const s of skippedMsgs) reasons.set(s.reason ?? "?", (reasons.get(s.reason ?? "?") ?? 0) + 1);
    console.log(`  skip reasons: ${[...reasons].map(([r, n]) => `${r} (${n})`).join(", ")}`);
  }
  for (const e of errors) console.log(`  ERROR message ${e.messageId}: ${e.reason}`);

  const { expired } = await expireStaleLoads();
  console.log(`  expiry sweep: ${expired} jobs expired`);

  // --- the summary the acceptance checklist reads (D §5 item 10) --------------
  const bySender = async (phone: string) =>
    (await queryOne<{ available: number; delisted: number; expired: number }>(
      `SELECT count(*) FILTER (WHERE status = 'available')::int AS available,
              count(*) FILTER (WHERE status = 'delisted')::int AS delisted,
              count(*) FILTER (WHERE status = 'expired')::int AS expired
         FROM loads WHERE sender_key = $1`,
      [`phone:${phone}`],
    ))!;
  const ef = await bySender("+17865550128");
  const k = await bySender("+12145550199");
  const skips = await query<{ skip_reason: string; n: number }>(
    `SELECT skip_reason, count(*)::int AS n FROM raw_messages WHERE status = 'skipped' GROUP BY skip_reason ORDER BY skip_reason`,
  );
  const totals = await queryOne<{
    total: number; available: number; delisted: number; expired: number; review: number; senders: number;
    fl_nj: number; new_format: number; attention: number; states: number;
  }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'available')::int AS available,
            count(*) FILTER (WHERE status = 'delisted')::int AS delisted,
            count(*) FILTER (WHERE status = 'expired')::int AS expired,
            count(*) FILTER (WHERE needs_review)::int AS review,
            (SELECT count(*) FROM senders)::int AS senders,
            count(*) FILTER (WHERE pickup_state = 'FL' AND delivery_state = 'NJ' AND status = 'available')::int AS fl_nj,
            (SELECT count(*) FROM raw_messages WHERE attention = 'new_format')::int AS new_format,
            (SELECT count(*) FROM raw_messages WHERE attention IS NOT NULL)::int AS attention,
            count(DISTINCT pickup_state)::int AS states
       FROM loads`,
  );

  console.log(`\nsenders: ${totals?.senders}`);
  console.log(`sender +1786…0128 (messages E then F): E delisted ${ef.delisted} / F available ${ef.available}`);
  console.log(`skipped: ${skips.map((s) => `${s.skip_reason} (${s.n})`).join(", ") || "none"}`);
  console.log(`sender +1214…0199 (message K, silent 5 days): expired ${k.expired}`);
  console.log(`FL → NJ available: ${totals?.fl_nj}`);
  console.log(`attention='new_format' rows: ${totals?.new_format} (messages needing attention: ${totals?.attention})`);
  console.log(
    `\njobs table: ${totals?.total} rows — ${totals?.available} available, ${totals?.delisted} delisted, ${totals?.expired} expired, ` +
      `${totals?.review} flagged for review, ${totals?.states} pickup states`,
  );
  console.log(
    '\nopen http://localhost:3000 — the board is public; press "Show contact" on any job to sign in as the demo driver; /login for poster/admin',
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
