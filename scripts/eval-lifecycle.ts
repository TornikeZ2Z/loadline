/**
 * Lifecycle eval. npm run eval:lifecycle
 *
 * Replays the supersession rules against an in-memory database with a real
 * clock: every pipeline function takes `now` as an argument, so no SQL clock
 * is mocked and the posts are ingested at T0 - 1 day / T0 rather than at
 * absolute dates that would sit four days behind the wall clock.
 *
 *   S1  E (T0-1d) then F (T0): E's 11 delisted, F's 9 available; reprocessing
 *       either in either order changes nothing; five silent days -> F expired.
 *   S2  E then F, then a 1-job "still available:" partial (+1h): that E job is
 *       revived (relist_count 1) and F is untouched; then a full post 30 min
 *       after F omitting one F job: still available (6-hour union).
 *   S3  E, then "UPDATED LIST" with F's body a day later: full, E delisted;
 *       then a small 3-line post with its own header: full, everything else
 *       delisted -- the latest post wins.
 */
process.env.PGLITE_DIR = "memory://";

import { REAL_MESSAGES } from "./fixtures/real-whatsapp";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const DAY = 86_400_000;
const HOUR = 3_600_000;

const failures: string[] = [];
let checks = 0;
function expect(ok: boolean, what: string) {
  checks++;
  if (ok) console.log(`  ${GREEN}✓${RESET} ${what}`);
  else {
    console.log(`  ${RED}✗${RESET} ${what}`);
    failures.push(what);
  }
}

const bodyOf = (letter: string) => REAL_MESSAGES.find((m) => m.format.startsWith(letter))!.body;

async function main() {
  const { query, queryOne } = await import("../src/lib/db");
  const { ingestMessage } = await import("../src/lib/pipeline/ingest");
  const { processPending, reprocessMessage } = await import("../src/lib/pipeline/process");
  const { rebuildSender } = await import("../src/lib/pipeline/reconcile");
  const { expireStaleLoads } = await import("../src/lib/pipeline/expire");

  const T0 = new Date();
  let seq = 0;
  const post = async (phone: string, body: string, at: Date, now: Date = at) => {
    const { messageId } = await ingestMessage({
      waMessageId: `lifecycle.${++seq}`,
      body,
      sentAt: at,
      authorName: "Dispatcher",
      authorPhone: phone,
      groupName: "Lifecycle",
      groupWaId: "lifecycle",
    });
    const results = await processPending(5, { now });
    const r = results.find((x) => x.messageId === messageId);
    if (!r || r.status === "error") throw new Error(`message ${messageId} did not process: ${JSON.stringify(r)}`);
    return messageId;
  };
  const counts = async (phone: string) =>
    (await queryOne<{ available: number; delisted: number; expired: number; total: number }>(
      `SELECT count(*) FILTER (WHERE status='available')::int AS available,
              count(*) FILTER (WHERE status='delisted')::int AS delisted,
              count(*) FILTER (WHERE status='expired')::int AS expired,
              count(*)::int AS total
         FROM loads WHERE sender_key = $1`,
      [`phone:${phone}`],
    ))!;
  const kindOf = async (messageId: number) =>
    (await queryOne<{ kind: string; kind_reason: string | null }>(`SELECT kind, kind_reason FROM sender_snapshots WHERE message_id = $1`, [messageId]))!;
  const eLines = (body: string) => body;

  // ------------------------------------------------------------------ S1
  console.log(`\n${DIM}S1: E then F, reprocess both orders, expire${RESET}`);
  const S1 = "+17865550128";
  const e1 = await post(S1, bodyOf("E"), new Date(T0.getTime() - DAY), T0);
  let c = await counts(S1);
  expect(c.available === 11 && c.total === 11, `after E: 11 available (got ${c.available}/${c.total})`);
  const f1 = await post(S1, bodyOf("F"), T0, T0);
  c = await counts(S1);
  expect(c.delisted === 11 && c.available === 9 && c.total === 20, `after F: E's 11 delisted, F's 9 available (got ${c.delisted}/${c.available}/${c.total})`);
  const relist = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM loads WHERE sender_key = $1 AND relist_count > 0`, [`phone:${S1}`]);
  expect(relist!.n === 0, "relist_count is 0 everywhere");
  expect((await kindOf(e1)).kind === "full" && (await kindOf(f1)).kind === "full", "both snapshots are full");

  await reprocessMessage(e1, { now: T0 });
  c = await counts(S1);
  expect(c.delisted === 11 && c.available === 9 && c.total === 20, `reprocess E (older): unchanged (got ${c.delisted}/${c.available}/${c.total})`);
  await reprocessMessage(f1, { now: T0 });
  await reprocessMessage(e1, { now: T0 });
  c = await counts(S1);
  expect(c.delisted === 11 && c.available === 9 && c.total === 20, `reprocess F then E: unchanged (got ${c.delisted}/${c.available}/${c.total})`);
  const seen = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM loads WHERE sender_key = $1 AND seen_count <> 1`, [`phone:${S1}`]);
  expect(seen!.n === 0, "reprocessing never inflates seen_count");

  const T5 = new Date(T0.getTime() + 5 * DAY);
  const swept = await expireStaleLoads(T5);
  await rebuildSender(`phone:${S1}`, T5);
  c = await counts(S1);
  expect(c.expired === 9 && c.delisted === 11, `five silent days: F's 9 expired, E's 11 still delisted (got expired ${c.expired}, delisted ${c.delisted}; sweep ${swept.expired})`);

  // ------------------------------------------------------------------ S2
  console.log(`\n${DIM}S2: partial revival and the 6-hour union window${RESET}`);
  const S2 = "+17865550201";
  await post(S2, bodyOf("E"), new Date(T0.getTime() - DAY), T0);
  await post(S2, bodyOf("F"), T0, T0);
  c = await counts(S2);
  expect(c.delisted === 11 && c.available === 9, `S2 baseline: 11 delisted / 9 available (got ${c.delisted}/${c.available})`);

  const partialId = await post(S2, "still available:\nFROM TUCSON AZ\n200.    PA 16648 $3.25", new Date(T0.getTime() + HOUR), new Date(T0.getTime() + HOUR));
  const pk = await kindOf(partialId);
  expect(pk.kind === "partial" && pk.kind_reason === "partial:phrase", `"still available" 1-job post is partial (${pk.kind}, ${pk.kind_reason})`);
  const tucson = await queryOne<{ status: string; relist_count: number; seen_count: number }>(
    `SELECT status, relist_count, seen_count FROM loads WHERE sender_key = $1 AND pickup_city = 'Tucson' AND delivery_zip = '16648'`,
    [`phone:${S2}`],
  );
  expect(!!tucson && tucson.status === "available" && tucson.relist_count === 1, `Tucson -> PA 16648 revived: available, relist_count 1 (got ${JSON.stringify(tucson)})`);
  c = await counts(S2);
  expect(c.available === 10 && c.delisted === 10 && c.total === 20, `partial delists nothing: 10 available / 10 delisted, no new rows (got ${c.available}/${c.delisted}/${c.total})`);

  const fMinusOne = bodyOf("F").split("\n").filter((l) => !l.includes("CA 91977")).join("\n");
  const unionId = await post(S2, fMinusOne, new Date(T0.getTime() + 30 * 60_000), new Date(T0.getTime() + 2 * HOUR));
  expect((await kindOf(unionId)).kind === "full", "the 30-minute-later post is full");
  const omitted = await queryOne<{ status: string }>(`SELECT status FROM loads WHERE sender_key = $1 AND delivery_zip = '91977'`, [`phone:${S2}`]);
  expect(omitted?.status === "available", `job omitted from a post 30 min after F is still available (got ${omitted?.status})`);

  // ------------------------------------------------------------------ S3
  console.log(`\n${DIM}S3: "UPDATED LIST" is a full post; a small self-contained post retires the rest${RESET}`);
  const S3 = "+17865550302";
  await post(S3, bodyOf("E"), new Date(T0.getTime() - DAY), T0);
  c = await counts(S3);
  expect(c.available === 11, `S3 baseline: E's 11 available (got ${c.available})`);
  const T1 = new Date(T0.getTime() + DAY);
  const updId = await post(S3, "UPDATED LIST\n" + eLines(bodyOf("F")), T1, T1);
  const uk = await kindOf(updId);
  expect(uk.kind === "full", `"UPDATED LIST" post is full (${uk.kind}, ${uk.kind_reason})`);
  c = await counts(S3);
  expect(c.delisted === 11 && c.available === 9, `after UPDATED LIST: E's 11 delisted, 9 available (got ${c.delisted}/${c.available})`);

  const T2 = new Date(T0.getTime() + 2 * DAY);
  const smallId = await post(S3, "FROM MIAMI FL:\n300 - GA 30303\n400 - NC 28202", T2, T2);
  const sk = await kindOf(smallId);
  expect(sk.kind === "full" && sk.kind_reason === "full:small", `3-line post with its own header and no partial phrase is full (${sk.kind}, ${sk.kind_reason})`);
  c = await counts(S3);
  expect(c.available === 2 && c.delisted === 20, `latest post wins: 2 available, 20 delisted (got ${c.available}/${c.delisted})`);
  const review = await queryOne<{ needs_review: boolean; retired_count: number }>(`SELECT needs_review, retired_count FROM sender_snapshots WHERE message_id = $1`, [smallId]);
  expect(!!review?.needs_review && review.retired_count === 9, `retiring 9 of 9 flags the snapshot for review (retired ${review?.retired_count}, review ${review?.needs_review})`);

  // Manual status survives reposts.
  const taken = await queryOne<{ id: number }>(`SELECT id FROM loads WHERE sender_key = $1 AND status = 'available' ORDER BY id LIMIT 1`, [`phone:${S3}`]);
  const { setManualStatus } = await import("../src/lib/pipeline/reconcile");
  await setManualStatus(taken!.id, "taken", null);
  const T3 = new Date(T0.getTime() + 3 * DAY);
  await post(S3, "FROM MIAMI FL:\n300 - GA 30303\n400 - NC 28202", T3, T3);
  const still = await queryOne<{ status: string; status_source: string; seen_count: number }>(`SELECT status, status_source, seen_count FROM loads WHERE id = $1`, [taken!.id]);
  expect(still?.status === "taken" && still.status_source === "manual" && still.seen_count === 2, `a job marked taken stays taken through a repost while last_seen advances (got ${JSON.stringify(still)})`);

  const orphanEvents = await query<{ n: number }>(`SELECT count(*)::int AS n FROM load_events WHERE kind = 'viewed_contact'`);
  expect(orphanEvents[0].n === 0, "no contact reveals were logged by the pipeline");

  console.log("");
  if (failures.length) {
    console.log(`${RED}${failures.length} of ${checks} lifecycle checks failed${RESET}\n`);
    process.exit(1);
  }
  console.log(`${GREEN}✓${RESET} ${checks} lifecycle checks passed\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
