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
 *   S4  the same lane at 300 cf yesterday and 350 cf today pairs into one job;
 *       reprocessing yesterday's post, or receiving it late, never writes 300
 *       back over it.
 *   S5  a reprocess that no longer parses as a load post still rebuilds the
 *       sender: the earlier list comes back instead of staying delisted.
 *   S6  a sender's expired jobs are not resurrected wholesale by a later
 *       one-line partial, and their expiry clock is not pushed forward.
 *   S7  a claim interrupted between claimNext and finish is re-offered, while
 *       a claim that is still fresh is not stolen.
 *   S8  a sender whose number is known from one post is reachable from ALL of
 *       their jobs, the rows say which number came from where, an attached
 *       number reaches the same rows, and nothing borrows another sender's.
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
  const { rebuildSender, SENDER_SILENCE_DAYS } = await import("../src/lib/pipeline/reconcile");
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

  // ------------------------------------------------------------------ S4
  // An older post is not newer information: reprocessing it, or receiving it
  // late, must never write its cubic feet and price back over the live job.
  console.log(`\n${DIM}S4: an older post never rewrites a job's cubic feet or price${RESET}`);
  const OLD_LIST = "FROM MIAMI FL:\n300 - GA 30303 $3.00";
  const NEW_LIST = "FROM MIAMI FL:\n350 - GA 30303 $4.00";
  const live = async (phone: string) =>
    await queryOne<{ job_key: string; cubic_feet: number; price_per_cf: number; rate_usd: number }>(
      `SELECT job_key, cubic_feet::int AS cubic_feet, price_per_cf::float8 AS price_per_cf, rate_usd::float8 AS rate_usd
         FROM loads WHERE sender_key = $1 AND status = 'available'`,
      [`phone:${phone}`],
    );

  const S4 = "+17865550401";
  const oldId = await post(S4, OLD_LIST, new Date(T0.getTime() - DAY), T0);
  await post(S4, NEW_LIST, T0, T0);
  c = await counts(S4);
  let cf = await live(S4);
  expect(
    c.total === 1 && cf?.cubic_feet === 350 && cf.price_per_cf === 4,
    `300 -> 350 on one lane pairs into a single revised job (got ${c.total} row(s), ${JSON.stringify(cf)})`,
  );

  await reprocessMessage(oldId, { now: T0 });
  cf = await live(S4);
  expect(
    cf?.cubic_feet === 350 && cf.price_per_cf === 4 && cf.rate_usd === 1400,
    `reprocessing yesterday's post leaves the live job at 350 cf / $4.00 (got ${JSON.stringify(cf)})`,
  );

  const S4b = "+17865550402";
  await post(S4b, NEW_LIST, T0, T0);
  await post(S4b, OLD_LIST, new Date(T0.getTime() - DAY), T0);
  cf = await live(S4b);
  c = await counts(S4b);
  expect(
    cf?.cubic_feet === 350 && cf.price_per_cf === 4 && c.available === 1 && c.delisted === 1,
    `yesterday's post arriving late is delisted, not merged backwards (got ${JSON.stringify(cf)}, ${c.available}/${c.delisted})`,
  );

  // ------------------------------------------------------------------ S5
  // Dropping the snapshot without rebuilding would leave E's 11 delisted by a
  // post that no longer exists.
  console.log(`\n${DIM}S5: a reprocess that yields no jobs still rebuilds the sender${RESET}`);
  const S5 = "+17865550502";
  await post(S5, bodyOf("E"), new Date(T0.getTime() - DAY), T0);
  const f5 = await post(S5, bodyOf("F"), T0, T0);
  c = await counts(S5);
  expect(c.delisted === 11 && c.available === 9, `S5 baseline: 11 delisted / 9 available (got ${c.delisted}/${c.available})`);

  await query(`UPDATE raw_messages SET body = $2 WHERE id = $1`, [f5, "thanks everyone"]);
  const skipped = await reprocessMessage(f5, { now: T0 });
  expect(skipped.status === "skipped", `the edited message no longer parses as a load post (got ${skipped.status}/${skipped.reason})`);
  c = await counts(S5);
  expect(
    c.available === 11 && c.delisted === 0 && c.total === 11,
    `E's 11 come back when F stops being a load post (got ${c.available}/${c.delisted}/${c.total})`,
  );
  const s5sender = await queryOne<{ last: string; full: string; n: number }>(
    `SELECT last_snapshot_at::text AS last, last_full_at::text AS full, snapshot_count::int AS n FROM senders WHERE key = $1`,
    [`phone:${S5}`],
  );
  expect(
    s5sender?.n === 1 && new Date(s5sender.last).getTime() === T0.getTime() - DAY,
    `the sender's timestamps follow the surviving snapshot (got ${JSON.stringify(s5sender)})`,
  );

  // ------------------------------------------------------------------ S6
  // Expiry is per job, not per sender: a one-line post says nothing about the
  // ten jobs it omits.
  console.log(`\n${DIM}S6: a one-line partial does not resurrect an expired list${RESET}`);
  const S6 = "+17865550603";
  await post(S6, bodyOf("E"), T0, T0);
  const T5b = new Date(T0.getTime() + 5 * DAY);
  await expireStaleLoads(T5b);
  await rebuildSender(`phone:${S6}`, T5b);
  c = await counts(S6);
  expect(c.expired === 11 && c.available === 0, `S6 baseline: five silent days expire all 11 (got ${c.expired}/${c.available})`);

  const T10 = new Date(T0.getTime() + 10 * DAY);
  const late = await post(S6, "still available:\nFROM TUCSON AZ\n200.    PA 16648 $3.25", T10, T10);
  expect((await kindOf(late)).kind === "partial", "the 1-job post ten days later is partial");
  c = await counts(S6);
  expect(
    c.available === 1 && c.expired === 10 && c.delisted === 0,
    `only the job it names comes back: 1 available / 10 expired (got ${c.available}/${c.expired}/${c.delisted})`,
  );
  const stale = await queryOne<{ expires: string }>(
    `SELECT expires_at::text AS expires FROM loads WHERE sender_key = $1 AND status = 'expired' ORDER BY id LIMIT 1`,
    [`phone:${S6}`],
  );
  expect(
    !!stale && new Date(stale.expires).getTime() === T0.getTime() + SENDER_SILENCE_DAYS * DAY,
    `an unmentioned job keeps its own expiry clock (got ${stale?.expires}, wanted ${new Date(T0.getTime() + SENDER_SILENCE_DAYS * DAY).toISOString()})`,
  );

  // ------------------------------------------------------------------ S7
  // A claim with no outcome is a dead worker, not a message to abandon.
  console.log(`\n${DIM}S7: an interrupted claim is re-offered, a fresh one is not${RESET}`);
  const S7 = "+17865550704";
  const strand = async (phone: string, ago: string) => {
    const { messageId } = await ingestMessage({
      waMessageId: `lifecycle.${++seq}`,
      body: bodyOf("F"),
      sentAt: T0,
      authorName: "Dispatcher",
      authorPhone: phone,
      groupName: "Lifecycle",
      groupWaId: "lifecycle",
    });
    await query(
      `UPDATE raw_messages SET status = 'processing', attempts = 1, processed_at = now() - $2::interval WHERE id = $1`,
      [messageId, ago],
    );
    return messageId;
  };

  const dead = await strand(S7, "30 minutes");
  const recovered = await processPending(5, { now: T0 });
  expect(
    recovered.some((r) => r.messageId === dead && r.status === "done"),
    `a message stranded in 'processing' is claimed again (got ${JSON.stringify(recovered.map((r) => [r.messageId, r.status]))})`,
  );
  c = await counts(S7);
  expect(c.available === 9, `the recovered message produces its 9 jobs (got ${c.available})`);

  const inFlight = await strand("+17865550705", "10 seconds");
  const stolen = await processPending(5, { now: T0 });
  expect(stolen.length === 0, `a claim that is still fresh is not stolen (got ${stolen.length} claimed)`);
  const stillHeld = await queryOne<{ status: string; attempts: number }>(
    `SELECT status, attempts::int AS attempts FROM raw_messages WHERE id = $1`,
    [inFlight],
  );
  expect(
    stillHeld?.status === "processing" && stillHeld.attempts === 1,
    `the in-flight message keeps its claim (got ${JSON.stringify(stillHeld)})`,
  );

  // ------------------------------------------------------------------ S8
  // Reachability (§1.3). What makes a job reachable is the SENDER's number, not
  // the post's: a dispatcher who signed one post and not the next is the same
  // dispatcher. Both posts here arrive with no author phone -- the pasted
  // chat-export case, where the WhatsApp author id is missing and reachability
  // is a real problem -- so the sender is keyed by name and the only number
  // anywhere is the one the signed post's footer carried.
  console.log(`\n${DIM}S8: a sender's number reaches every job of theirs${RESET}`);
  const FOOTER = "+12015550199"; // fixture C's "📱 Call/Text Marco: (201) 555-0199"
  const namePost = async (author: string, body: string, at: Date) => {
    const { messageId } = await ingestMessage({
      waMessageId: `lifecycle.${++seq}`,
      body,
      sentAt: at,
      authorName: author,
      authorPhone: null,
      groupName: "Lifecycle",
      groupWaId: "lifecycle",
    });
    const results = await processPending(5, { now: T0 });
    const r = results.find((x) => x.messageId === messageId);
    if (!r || r.status === "error") throw new Error(`message ${messageId} did not process: ${JSON.stringify(r)}`);
    return messageId;
  };
  const reach = async (key: string) =>
    (await queryOne<{ total: number; reachable: number; from_post: number; from_sender: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE contact_phone IS NOT NULL)::int AS reachable,
              count(*) FILTER (WHERE contact_phone_source = 'post')::int AS from_post,
              count(*) FILTER (WHERE contact_phone_source = 'sender')::int AS from_sender
         FROM loads WHERE sender_key = $1`,
      [key],
    ))!;

  // The unsigned post first, then the one whose footer carries the number.
  const unsigned = await namePost("Reachability Dispatcher", bodyOf("B"), new Date(T0.getTime() - 2 * HOUR));
  const nameKey = (await queryOne<{ sender_key: string }>(
    `SELECT sender_key FROM raw_messages WHERE id = $1`,
    [unsigned],
  ))!.sender_key;
  expect(nameKey.startsWith("name:"), `a post with no author phone is keyed by name (got ${nameKey})`);
  let r8 = await reach(nameKey);
  expect(
    r8.total > 0 && r8.reachable === 0,
    `before the signed post, none of the sender's ${r8.total} jobs is reachable (got ${r8.reachable})`,
  );

  const signed = await namePost("Reachability Dispatcher", bodyOf("C"), new Date(T0.getTime() - HOUR));
  r8 = await reach(nameKey);
  expect(
    r8.reachable === r8.total && r8.total > 0,
    `the footer number reaches all ${r8.total} of the sender's jobs (got ${r8.reachable})`,
  );
  expect(
    r8.from_post > 0 && r8.from_sender > 0 && r8.from_post + r8.from_sender === r8.total,
    `every row says where its number came from (post ${r8.from_post}, sender ${r8.from_sender}, total ${r8.total})`,
  );
  const wrong = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM loads WHERE sender_key = $1 AND contact_phone <> $2`,
    [nameKey, FOOTER],
  );
  expect(wrong!.n === 0, `no number is invented: every row carries ${FOOTER} (got ${wrong!.n} others)`);
  const borrowed = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM loads WHERE contact_phone = $1 AND sender_key IS DISTINCT FROM $2`,
    [FOOTER, nameKey],
  );
  expect(borrowed!.n === 0, `no other sender borrowed this number (got ${borrowed!.n} rows)`);

  // Reprocessing the signed post must not strand a marker: rebuildSender undoes
  // its own backfill first, so the answer is recomputed rather than patched.
  await reprocessMessage(signed, { now: T0 });
  const after8 = await reach(nameKey);
  expect(
    after8.reachable === r8.reachable && after8.from_post === r8.from_post && after8.from_sender === r8.from_sender,
    `reprocessing changes nothing (got ${JSON.stringify(after8)}, wanted ${JSON.stringify(r8)})`,
  );

  // The admin escape hatch: a sender with no number anywhere, made reachable
  // once. This is exactly what PATCH /api/admin/senders/:key does.
  const ATTACHED = "+13055550142";
  const silentMsg = await namePost("Silent Dispatcher", bodyOf("B"), new Date(T0.getTime() - 3 * HOUR));
  const silentKey = (await queryOne<{ sender_key: string }>(
    `SELECT sender_key FROM raw_messages WHERE id = $1`,
    [silentMsg],
  ))!.sender_key;
  let s8 = await reach(silentKey);
  expect(s8.total > 0 && s8.reachable === 0, `a sender with no number has ${s8.total} unreachable jobs`);

  await query(`UPDATE senders SET author_phone = $2 WHERE key = $1`, [silentKey, ATTACHED]);
  await rebuildSender(silentKey, T0);
  s8 = await reach(silentKey);
  expect(
    s8.reachable === s8.total && s8.from_sender === s8.total,
    `an attached number reaches all ${s8.total} jobs, all labelled as the sender's (got ${s8.reachable}/${s8.from_sender})`,
  );

  await query(`UPDATE senders SET author_phone = NULL WHERE key = $1`, [silentKey]);
  await rebuildSender(silentKey, T0);
  s8 = await reach(silentKey);
  expect(
    s8.reachable === 0 && s8.from_sender === 0,
    `detaching it puts the rows back exactly as they were (got ${s8.reachable} reachable)`,
  );

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
