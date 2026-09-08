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
 *       back over it; and a lane offering two candidates on either side pairs
 *       with neither, claims no edit, and flags the snapshot instead.
 *   S5  a reprocess that no longer parses as a load post still rebuilds the
 *       sender: the earlier list comes back instead of staying delisted.
 *   S6  a sender's expired jobs are not resurrected wholesale by a later
 *       one-line partial, and their expiry clock is not pushed forward.
 *   S7  a claim interrupted between claimNext and finish is re-offered, while
 *       a claim that is still fresh is not stolen.
 *   S8  a sender whose number is known from one post is reachable from ALL of
 *       their jobs, the rows say which number came from where, an attached
 *       number reaches the same rows, and nothing borrows another sender's.
 *   S9  the 50-99 % band: an explicit "still available" makes a post partial at
 *       60 %, at 90 %, above 100 % and with no previous list at all, delisting
 *       nothing; the same bodies without the phrase, and "UPDATED LIST", are
 *       still full and still retire what they omit; a truncated post delists
 *       nothing either.
 *   S10 the truncated branch on its own: a post cut off with no "Read more"
 *       marker, a cut-off post that also carries a partial phrase, the jobs
 *       such a post repeats still being sighted, and `last_full_at` staying
 *       on the earlier list so a later full post still retires what it omits.
 *   S11 who may name a city: an unresolved ZIP carries none, the geo/zips.ts
 *       sweep supplies one once a real geocoder places the ZIP, and a city the
 *       poster wrote is never overwritten.
 *
 *   R1  readiness is what the POST said and nothing else: the reviewer's own
 *       evidence (message F, Fort Lauderdale -> CA 91977) names no readiness
 *       anywhere, so it stays unknown through the row, the card, the strict
 *       filter, the sort and the headline count -- and comes back only when a
 *       driver deliberately asks to include unknown dates.
 *   R2  the requirement chips are the sender's own words: HHG + DOT +
 *       insurance produces exactly those three and never an MC nobody wrote.
 *   R3  the website form cannot publish an assumed readiness, and refuses a
 *       ready date that falls after the delivery deadline.
 *   R4  a ZIP that contradicts the state posted beside it is asked about --
 *       "07102 is a New Jersey ZIP, but the delivery state says Florida. Which
 *       is right?" -- at both ends of a job and both ends of a truck, while a
 *       ZIP nobody can place, a blank one, a stateless one and a leading zero
 *       all keep working.
 *
 * And then the OTHER lifecycle, which shares none of that machinery:
 *
 *   T4  a truck with a stated departure day is available 12 h into it and
 *       departed the day after, with an event reading `departure_passed` --
 *       never `sender_silent`, because a driver who said Tuesday and drove away
 *       on Tuesday was not silent.
 *   T5  a dateless truck lives 48 h, not the jobs' four days, and a repost
 *       renews the clock from the NEW sighting.
 *   T6  `booked` is sticky at every horizon, and `status_source = 'manual'` is
 *       NOT a shield: a truck set back to available is still swept once its
 *       stated window has passed. And the doors as well as the safety net: the
 *       API refuses to put a truck on the board with a departure that has
 *       already happened, from all three directions -- a relist carrying old
 *       dates, an edit that drags an available truck's dates backwards, and a
 *       POST of a window that was already behind us when it was typed. The
 *       boundary is asserted with them: a window ending TODAY is not past.
 *   T8  the two sweeps cannot see each other's table.
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

  // The lane alone was the pairing key, so two distinct same-lane jobs plus one
  // new size collapsed into one row that kept the older first_seen_at and
  // seen_count and gained an `edited` event asserting a correction that never
  // happened. Nothing may pair when the lane offers more than one candidate.
  const edits = async (phone: string) =>
    (await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM load_events e JOIN loads l ON l.id = e.load_id
        WHERE l.sender_key = $1 AND e.kind = 'edited'`,
      [`phone:${phone}`],
    ))!.n;
  const snapReview = async (phone: string) =>
    (await queryOne<{ needs_review: boolean }>(
      `SELECT needs_review FROM sender_snapshots WHERE sender_key = $1 ORDER BY sent_at DESC, id DESC LIMIT 1`,
      [`phone:${phone}`],
    ))!.needs_review;

  const S4c = "+17865550403";
  await post(S4c, "FROM MIAMI FL:\n350 - GA 30303 $3.00\n900 - GA 30303 $2.50", new Date(T0.getTime() - DAY), T0);
  await post(S4c, "FROM MIAMI FL:\n400 - GA 30303 $3.50", T0, T0);
  c = await counts(S4c);
  const kept4c = await queryOne<{ cubic_feet: number; seen_count: number; first_seen: string }>(
    `SELECT cubic_feet::int AS cubic_feet, seen_count, first_seen_at::text AS first_seen
       FROM loads WHERE sender_key = $1 AND status = 'available'`,
    [`phone:${S4c}`],
  );
  expect(
    c.total === 3 && c.available === 1 && c.delisted === 2 &&
      kept4c?.cubic_feet === 400 && kept4c.seen_count === 1 &&
      new Date(kept4c.first_seen).getTime() === T0.getTime(),
    `two same-lane jobs plus one new size stay three rows, and the new one keeps its own history ` +
      `(got ${c.available}/${c.delisted}/${c.total}, ${JSON.stringify(kept4c)})`,
  );
  expect(await edits(S4c) === 0, `no edit is claimed when the lane offers two candidates (got ${await edits(S4c)})`);
  expect(await snapReview(S4c), "the ambiguous snapshot is flagged for review");

  // The same ambiguity in the other direction: one absent row, two new sizes.
  // Greedy |Δcf| would have paired the closest and called the other new.
  const S4d = "+17865550404";
  await post(S4d, "FROM MIAMI FL:\n350 - GA 30303 $3.00", new Date(T0.getTime() - DAY), T0);
  await post(S4d, "FROM MIAMI FL:\n400 - GA 30303 $3.50\n500 - GA 30303 $3.25", T0, T0);
  c = await counts(S4d);
  expect(
    c.total === 3 && c.available === 2 && c.delisted === 1 && (await edits(S4d)) === 0,
    `two new sizes against one absent row pair with neither (got ${c.available}/${c.delisted}/${c.total}, ${await edits(S4d)} edits)`,
  );

  // Guard the feature the rule must not retire: one against one still pairs.
  const S4e = "+17865550405";
  await post(S4e, "FROM MIAMI FL:\n300 - GA 30303 $3.00\n400 - NC 28202 $3.10", new Date(T0.getTime() - DAY), T0);
  await post(S4e, "FROM MIAMI FL:\n350 - GA 30303 $4.00\n400 - NC 28202 $3.10", T0, T0);
  c = await counts(S4e);
  expect(
    c.total === 2 && c.available === 2 && (await edits(S4e)) === 1,
    `one candidate per side on a two-lane list still pairs (got ${c.available}/${c.total}, ${await edits(S4e)} edits)`,
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

  // ------------------------------------------------------------------ S9
  // The 50-99 % band. S2 and S6 only ever exercise a 1-job partial, far under
  // the old `small` gate, so nothing here was covered: a 10-job sender posting
  // "STILL AVAILABLE:" over 6 of those jobs produced a `full` snapshot and
  // silently delisted the other 4, while the same post naming 4 delisted none.
  console.log(`\n${DIM}S9: an explicit partial phrase is decisive at any size${RESET}`);
  const TEN = [
    "FROM FORT LAUDERDALE FL:",
    "700 - OR 97396", "200 - WA 98109", "400 - OH 44473", "300 - MI 49456", "400 - NY 14075",
    "200 - NY 14850", "300 - AZ 85281", "200 - CA 91977", "250 - TX 75201", "350 - CO 80202",
  ];
  /** The header plus the first `n` of the ten lanes -- verbatim, so the job keys match. */
  const subset = (n: number) => [TEN[0], ...TEN.slice(1, 1 + n)].join("\n");

  let s9seq = 0;
  /** A fresh sender with the full 10-job list at T0-1d, then `body` at T0. */
  const band = async (body: string) => {
    const phone = `+178655590${String(++s9seq).padStart(2, "0")}`;
    await post(phone, subset(10), new Date(T0.getTime() - DAY), T0);
    const base = await counts(phone);
    if (base.available !== 10) throw new Error(`S9 setup: wanted 10 available, got ${base.available}`);
    const id = await post(phone, body, T0, T0);
    return { ...(await kindOf(id)), ...(await counts(phone)) };
  };

  const marked6 = await band("STILL AVAILABLE:\n" + subset(6));
  expect(
    marked6.kind === "partial" && marked6.kind_reason === "partial:phrase" &&
      marked6.available === 10 && marked6.delisted === 0 && marked6.total === 10,
    `60 % with a marker delists NOTHING (${marked6.kind}/${marked6.kind_reason}, ` +
      `${marked6.available} available / ${marked6.delisted} delisted / ${marked6.total} rows)`,
  );

  const bare6 = await band(subset(6));
  expect(
    bare6.kind === "full" && bare6.available === 6 && bare6.delisted === 4,
    `the same 60 % body with no marker still retires the 4 it omits (${bare6.kind}/${bare6.kind_reason}, ` +
      `${bare6.available} available / ${bare6.delisted} delisted)`,
  );

  const marked9 = await band("STILL AVAILABLE:\n" + subset(9));
  expect(
    marked9.kind === "partial" && marked9.available === 10 && marked9.delisted === 0,
    `90 % with a marker delists NOTHING (${marked9.kind}/${marked9.kind_reason}, ` +
      `${marked9.available} available / ${marked9.delisted} delisted)`,
  );

  // The decision this fix must not reverse (D §0.10 / D25): "updated" is a
  // TITLE word, never a PARTIAL one, so a daily UPDATED LIST is still a full
  // list that retires what it omits.
  const updated6 = await band("UPDATED LIST\n" + subset(6));
  expect(
    updated6.kind === "full" && updated6.available === 6 && updated6.delisted === 4,
    `"UPDATED LIST" over 60 % is still full and retires the other 4 (${updated6.kind}/${updated6.kind_reason}, ` +
      `${updated6.available} available / ${updated6.delisted} delisted)`,
  );

  // Below the gate, unchanged: shape-only heuristics still decide a post that
  // says nothing about itself.
  const bare4 = await band(subset(4));
  expect(
    bare4.kind === "full" && bare4.kind_reason === "full:small" && bare4.available === 4 && bare4.delisted === 6,
    `40 % with no marker is still full:small (${bare4.kind}/${bare4.kind_reason}, ` +
      `${bare4.available} available / ${bare4.delisted} delisted)`,
  );

  // A post WhatsApp cut off is classified before any of this and never delists.
  const cut = await band(subset(6) + "\nRead more");
  expect(
    cut.kind === "truncated" && cut.available === 10 && cut.delisted === 0,
    `a truncated post delists nothing (${cut.kind}/${cut.kind_reason}, ` +
      `${cut.available} available / ${cut.delisted} delisted)`,
  );

  // Over 100 %: "also have" means in addition to, not instead of.
  const S9grow = "+17865559080";
  await post(S9grow, subset(4), new Date(T0.getTime() - DAY), T0);
  const growId = await post(S9grow, "ALSO HAVE:\n" + subset(10), T0, T0);
  const grow = { ...(await kindOf(growId)), ...(await counts(S9grow)) };
  expect(
    grow.kind === "partial" && grow.available === 10 && grow.delisted === 0,
    `a marked post naming MORE than the previous full list keeps all 10 (${grow.kind}/${grow.kind_reason}, ` +
      `${grow.available} available / ${grow.delisted} delisted)`,
  );

  // No previous full snapshot at all: a marked first post is partial, and a
  // sender whose only snapshots are partial still has available jobs --
  // `rebuildSender` delists against `latestFull`, which is null here.
  const S9first = "+17865559081";
  const firstId = await post(S9first, "STILL AVAILABLE:\n" + subset(3), T0, T0);
  const first = { ...(await kindOf(firstId)), ...(await counts(S9first)) };
  expect(
    first.kind === "partial" && first.available === 3 && first.delisted === 0,
    `a marked first post still lists its jobs (${first.kind}/${first.kind_reason}, ` +
      `${first.available} available / ${first.delisted} delisted)`,
  );

  // ----------------------------------------------------------------- S10
  // The `truncated` branch runs before every other test in `recordSnapshot`
  // and had no check of its own beyond the one read_more case above: a post
  // WhatsApp cut off is a fragment of a list, never a replacement for it.
  console.log(`\n${DIM}S10: a post WhatsApp cut off is a fragment, not a new list${RESET}`);

  // (a) No "Read more" marker at all -- the tail is simply gone mid-line, and
  //     the shape of the last line is the only evidence.
  const S10a = "+17865559090";
  await post(S10a, subset(10), new Date(T0.getTime() - DAY), T0);
  const tailId = await post(S10a, subset(6) + "\n300 - OR", T0, T0);
  const tail = { ...(await kindOf(tailId)), ...(await counts(S10a)) };
  expect(
    tail.kind === "truncated" && tail.kind_reason === "truncated:tail" &&
      tail.available === 10 && tail.delisted === 0,
    `a post cut off with no "Read more" is truncated:tail and delists nothing (${tail.kind}/${tail.kind_reason}, ` +
      `${tail.available} available / ${tail.delisted} delisted)`,
  );

  // (b) Truncation is decided before the partial phrase and before the size
  //     gate, so a cut-off post is truncated whatever else it says.
  const S10b = "+17865559091";
  await post(S10b, subset(10), new Date(T0.getTime() - DAY), T0);
  const bothId = await post(S10b, "STILL AVAILABLE:\n" + subset(6) + "\nRead more", T0, T0);
  const both = { ...(await kindOf(bothId)), ...(await counts(S10b)) };
  expect(
    both.kind === "truncated" && both.available === 10 && both.delisted === 0,
    `a cut-off post carrying a partial phrase is still truncated (${both.kind}/${both.kind_reason}, ` +
      `${both.available} available / ${both.delisted} delisted)`,
  );

  // (c) Not delisting is not the same as being ignored. The jobs a truncated
  //     post names are sighted, so their freshness and expiry clocks advance.
  const S10c = "+17865559092";
  await post(S10c, subset(10), new Date(T0.getTime() - DAY), T0);
  await post(S10c, subset(6) + "\nRead more", T0, T0);
  const sight = await queryOne<{ named: number; unnamed: number }>(
    `SELECT count(*) FILTER (WHERE seen_count = 2)::int AS named,
            count(*) FILTER (WHERE seen_count = 1)::int AS unnamed
       FROM loads WHERE sender_key = $1`,
    [`phone:${S10c}`],
  );
  expect(
    sight?.named === 6 && sight.unnamed === 4,
    `the 6 jobs a truncated post repeats are seen again; the 4 it omits are not (got ${JSON.stringify(sight)})`,
  );

  // (d) The point of the branch: a truncated post must not become the
  //     reference every later delisting is measured against. `last_full_at`
  //     stays on the earlier full list, and a genuine full post afterwards
  //     still retires what it omits.
  const s10cSender = await queryOne<{ full: string; last: string }>(
    `SELECT last_full_at::text AS full, last_snapshot_at::text AS last FROM senders WHERE key = $1`,
    [`phone:${S10c}`],
  );
  expect(
    new Date(s10cSender!.full).getTime() === T0.getTime() - DAY &&
      new Date(s10cSender!.last).getTime() === T0.getTime(),
    `the truncated post advances last_snapshot_at but not last_full_at (got ${JSON.stringify(s10cSender)})`,
  );
  const T0h12 = new Date(T0.getTime() + 12 * HOUR);
  await post(S10c, subset(3), T0h12, T0h12);
  const after10c = await counts(S10c);
  expect(
    after10c.available === 3 && after10c.delisted === 7,
    `a real full post after a truncated one still retires the 7 it omits (got ${after10c.available}/${after10c.delisted})`,
  );

  // ----------------------------------------------------------------- S11
  // Who is allowed to name a city. `zipApprox` places a ZIP it cannot resolve
  // at the nearest gazetteer city's coordinates and reports NO city, because
  // the nearest in-state entry is a guess about the ZIP rather than anything
  // the sender wrote -- live, that guess was being served as `delivery_city`
  // for "VA 24040" (Roanoke) and "ID 83664" (Boise) with needs_review false.
  // A real geocoder answer is the first thing entitled to name one, so the
  // name arrives with the geo/zips.ts sweep, and only where the poster did not
  // supply one themselves.
  console.log(`\n${DIM}S11: only a real geocoder names a city the sender did not${RESET}`);
  const { warmBoardZips } = await import("../src/lib/geo/zips");
  const S11 = "+17865559100";
  // 30303 is Atlanta and the message never says so; 24011 says "Roanoke".
  await post(S11, "FROM NEWARK NJ:\n350 - GA 30303 $3.00\n400 - Roanoke, VA 24011 $3.10", T0, T0);
  const dest11 = async (zip: string) =>
    (await queryOne<{ city: string | null; prec: string | null }>(
      `SELECT delivery_city AS city, delivery_precision AS prec
         FROM loads WHERE sender_key = $1 AND delivery_zip = $2`,
      [`phone:${S11}`, zip],
    ))!;
  const preUnsaid = await dest11("30303");
  const preStated = await dest11("24011");
  expect(
    preUnsaid.city === null && preUnsaid.prec === "state" && preStated.city === "Roanoke",
    `an unresolved ZIP carries no city and a stated one keeps it ` +
      `(got ${JSON.stringify(preUnsaid)}, ${JSON.stringify(preStated)})`,
  );

  // Stand in for a warmed cache: HERE is unconfigured in this run, so write the
  // precise answers straight into `places` and let the sweep move the rows.
  await query(
    `UPDATE places SET city = 'Atlanta', state = 'GA', lat = 33.749, lng = -84.388,
            precision = 'zip', source = 'here' WHERE query = 'zip:30303'`,
  );
  await query(
    `UPDATE places SET city = 'Roanoke', state = 'VA', lat = 37.271, lng = -79.941,
            precision = 'zip', source = 'here' WHERE query = 'zip:24011'`,
  );
  await warmBoardZips({ onlyCoarse: true });
  const postUnsaid = await dest11("30303");
  const postStated = await dest11("24011");
  expect(
    postUnsaid.city === "Atlanta" && postUnsaid.prec === "zip",
    `the sweep names the ZIP-only endpoint once a real geocoder places it (got ${JSON.stringify(postUnsaid)})`,
  );
  expect(
    postStated.city === "Roanoke" && postStated.prec === "zip",
    `the poster's own city is never overwritten by the sweep (got ${JSON.stringify(postStated)})`,
  );

  // --------------------------------------------------------------- R1-R3
  await readinessAndRequirements(post, T0);

  // ------------------------------------------------------------------ R4
  await zipStateAgreement();

  // ------------------------------------------------------------- T4-T6, T8
  await truckLifecycle();

  console.log("");
  if (failures.length) {
    console.log(`${RED}${failures.length} of ${checks} lifecycle checks failed${RESET}\n`);
    process.exit(1);
  }
  console.log(`${GREEN}✓${RESET} ${checks} lifecycle checks passed\n`);
  process.exit(0);
}

/**
 * Readiness and requirements: R1, R2, R3 -- the truth layer, end to end.
 *
 * Every assertion here is about a fact the product does NOT have. The board's
 * central claim is that it never invents one, and the reviewed build broke it
 * in three places at once: a post with no readiness marker was stored as ready
 * and shown with a green chip, a compact badge added an MC authority no sender
 * had asked for, and the posting form defaulted to "Ready now" with no way to
 * say "I do not know yet".
 *
 * It runs over the real fixture message F, which is the reviewer's own evidence
 * (job 111 on the live board), rather than over a body written to pass.
 */
async function readinessAndRequirements(
  post: (phone: string, body: string, at: Date, now?: Date) => Promise<number>,
  T0: Date,
) {
  console.log(`\n${DIM}R1-R3: readiness is what the post said; requirements are the sender's words${RESET}`);

  const { query, queryOne } = await import("../src/lib/db");
  const { searchLoads } = await import("../src/lib/loads/query");
  const { boardDay, readyLabel, requirementChips, READY_AFTER_DEADLINE, READY_NOT_STATED } =
    await import("../src/lib/loads/present");
  const { insertWebJob, WebJobValidationError } = await import("../src/lib/pipeline/web");

  const today = boardDay(T0);

  // --- R1: the four states, from the post to the headline -------------------
  // Two senders, because supersession is per sender and a second post from the
  // same one would retire the first. The MARKED post goes first, so that the
  // unmarked one is the NEWER row: under the behaviour this replaces both were
  // ready_now = true and the newer would have sorted above the stated one.
  const MARKED = "+17865559201";
  const SILENT = "+17865559202";
  await post(MARKED, "FROM SAVANNAH GA\nFL 33180 400 RFD\nFL 33181 300 9/12", T0, T0);
  await post(SILENT, bodyOf("F"), new Date(T0.getTime() + 60_000), new Date(T0.getTime() + 60_000));

  const silent = await searchLoads({ senderKey: `phone:${SILENT}`, limit: 100 });
  const job111 = silent.rows.find((r) => r.delivery_zip === "91977");
  expect(
    !!job111 && job111.ready_state === "unknown" && !job111.ready_now && job111.ready_date === null,
    `R1: the post that never mentions readiness stores unknown (got ${JSON.stringify(
      job111 && { state: job111.ready_state, now: job111.ready_now, date: job111.ready_date, source: job111.ready_source },
    )})`,
  );

  const label = readyLabel(job111!, today);
  expect(
    label.text === READY_NOT_STATED && label.tone !== "ready",
    `R1: the card and the detail read "${READY_NOT_STATED}" in a quiet tone (got "${label.text}" / ${label.tone})`,
  );

  expect(
    silent.summary.count === 9 && silent.summary.readyNow === 0,
    `R1: the headline counts the jobs and none of them as ready now (got ${silent.summary.count} jobs, ${silent.summary.readyNow} ready now)`,
  );

  const strict = await searchLoads({ senderKey: `phone:${SILENT}`, readyOnly: true, limit: 100 });
  expect(
    strict.total === 0 && strict.summary.readyNow === 0,
    `R1: ?readyOnly=1 returns none of them -- an undated job is not a job that is ready today (got ${strict.total})`,
  );

  const wide = await searchLoads({
    senderKey: `phone:${SILENT}`,
    readyOnly: true,
    includeUnknownReady: true,
    limit: 100,
  });
  expect(
    wide.rows.some((r) => r.id === job111!.id),
    `R1: "Include unknown dates" brings them back, because the driver asked (got ${wide.total})`,
  );

  const marked = await searchLoads({ senderKey: `phone:${MARKED}`, limit: 100 });
  const rfd = marked.rows.find((r) => r.delivery_zip === "33180");
  const dated = marked.rows.find((r) => r.delivery_zip === "33181");
  expect(
    !!rfd && rfd.ready_state === "now" && rfd.ready_now && rfd.ready_source === "line",
    `R1: an RFD line is ready now, and the row says where that was read (got ${JSON.stringify(
      rfd && { state: rfd.ready_state, now: rfd.ready_now, source: rfd.ready_source },
    )})`,
  );
  expect(
    !!dated && dated.ready_state === "date" && !dated.ready_now && dated.ready_date != null,
    `R1: a stated date is a date, and keeps the sender's own day (got ${JSON.stringify(
      dated && { state: dated.ready_state, now: dated.ready_now, date: dated.ready_date },
    )})`,
  );
  expect(
    !!dated && readyLabel(dated, today).text.includes(dated.ready_date!.slice(8).replace(/^0/, "")),
    `R1: and the label prints that day rather than today (got "${dated && readyLabel(dated, today).text}")`,
  );
  expect(
    marked.summary.readyNow === 1,
    `R1: a future date is not counted in "N ready now" either (got ${marked.summary.readyNow} of 2)`,
  );

  // Sorting: "Ready soonest" is about stated readiness, so the unknown row --
  // posted a minute LATER, and therefore first on any freshness tiebreak --
  // must sit below the job whose sender actually said "RFD".
  const sorted = await searchLoads({ sort: "ready", limit: 500 });
  const at = (id: number) => sorted.rows.findIndex((r) => r.id === id);
  expect(
    at(rfd!.id) >= 0 && at(job111!.id) >= 0 && at(rfd!.id) < at(job111!.id),
    `R1: sorted by "Ready soonest", a stated ready-now job is above one whose date nobody stated (got ${at(rfd!.id)} vs ${at(job111!.id)})`,
  );

  // --- R2: requirement chips are the sender's own words ---------------------
  // F's own line: "MUST HAVE HHG, ACTIVE DOT AND INSURANCE." The badge that
  // used to sit on job 111 read "DOT & MC" -- one requirement invented, two
  // hidden.
  const chips111 = requirementChips(job111!.requirements).map((c) => c.label);
  expect(
    chips111.join(" | ") === "HHG required | DOT required | Insurance required",
    `R2: HHG + DOT + insurance produces exactly those three chips (got ${JSON.stringify(chips111)})`,
  );
  expect(
    !chips111.some((c) => /\bMC\b/.test(c)),
    "R2: and no MC chip, because the post never says MC",
  );
  expect(
    (job111!.requirements ?? "").toUpperCase().includes("HHG"),
    "R2: the sender's full requirement text is still on the row for the detail to print",
  );

  const MC_ONLY = "+17865559203";
  const MIXED = "+17865559204";
  await post(MC_ONLY, "FROM SAVANNAH GA\nFL 33183 400\nMC AUTHORITY REQUIRED.", T0, T0);
  await post(MIXED, "FROM SAVANNAH GA\nFL 33184 400\nDOT AND MC REQUIRED.", T0, T0);
  const oneRow = async (phone: string) =>
    (await queryOne<{ requirements: string | null }>(
      `SELECT requirements FROM loads WHERE sender_key = $1`,
      [`phone:${phone}`],
    ))!;
  const mcChips = requirementChips((await oneRow(MC_ONLY)).requirements).map((c) => c.label);
  const mixedChips = requirementChips((await oneRow(MIXED)).requirements).map((c) => c.label);
  expect(
    mcChips.join(" | ") === "MC required",
    `R2: an MC-only post says MC and nothing else (got ${JSON.stringify(mcChips)})`,
  );
  expect(
    mixedChips.join(" | ") === "DOT required | MC required",
    `R2: a post naming both stays two distinct requirements (got ${JSON.stringify(mixedChips)})`,
  );

  // --- R3: the form cannot publish an assumption ---------------------------
  await query(
    `INSERT INTO users (email, password_hash, name, role, phone, company, is_demo, can_post)
     VALUES ('ready@lifecycle.test','x','Ready Poster','poster','+12015550123','Lifecycle Movers',false,true)
     ON CONFLICT (email) DO NOTHING`,
  );
  const poster = (await queryOne<{ id: number }>(
    `SELECT id FROM users WHERE email = 'ready@lifecycle.test'`,
  ))!;
  const actor = { id: poster.id, name: "Ready Poster", phone: "+12015550123", isDemo: false };
  const jobBody = (extra: Record<string, string>) => ({
    pickup: "Kearny, NJ 07032",
    pickupLat: "40.7684",
    pickupLng: "-74.1454",
    pickupState: "NJ",
    pickupZip: "07032",
    pickupPrecision: "zip",
    deliveryState: "FL",
    deliveryZip: "33435",
    cubicFeet: "800",
    contactPhone: "+12015550123",
    ...extra,
  });
  const stateOf = async (id: number) =>
    (await queryOne<{ ready_state: string; ready_now: boolean; ready_date: string | null }>(
      `SELECT ready_state, ready_now, ready_date::text AS ready_date FROM loads WHERE id = $1`,
      [id],
    ))!;

  const unknownPost = await insertWebJob(actor, jobBody({ readyState: "unknown" }));
  const unknownRow = await stateOf(unknownPost.id);
  expect(
    unknownRow.ready_state === "unknown" && !unknownRow.ready_now && unknownRow.ready_date === null,
    `R3: "Not stated yet" publishes as unknown (got ${JSON.stringify(unknownRow)})`,
  );

  const nowPost = await insertWebJob(actor, jobBody({ readyState: "now" }));
  expect((await stateOf(nowPost.id)).ready_state === "now", "R3: \u201cReady now\u201d publishes as a stated now");

  // The legacy shape: a client that says nothing about readiness at all. It
  // used to publish ready_now = true, which is the same invention through the
  // front door.
  const silentPost = await insertWebJob(actor, jobBody({}));
  const silentRow = await stateOf(silentPost.id);
  expect(
    silentRow.ready_state === "unknown" && !silentRow.ready_now,
    `R3: a body that says nothing about readiness is unknown, never now (got ${JSON.stringify(silentRow)})`,
  );

  const refusalOf = async (extra: Record<string, string>) => {
    const before = (await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM loads`))!.n;
    try {
      await insertWebJob(actor, jobBody(extra));
      return { err: null as unknown, wrote: 1 };
    } catch (e) {
      const after = (await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM loads`))!.n;
      return { err: e, wrote: after - before };
    }
  };

  const dateless = await refusalOf({ readyState: "date" });
  expect(
    dateless.err instanceof WebJobValidationError &&
      dateless.err.field === "readyDate" &&
      dateless.wrote === 0,
    `R3: "ready on" with no date is refused rather than quietly stored (got ${
      dateless.err instanceof Error ? dateless.err.message : "a 201"
    })`,
  );

  // Ready three days AFTER it must be delivered: two dates the same poster
  // typed, contradicting each other.
  const day = (n: number) => boardDay(new Date(T0.getTime() + n * DAY));
  const backwards = await refusalOf({
    readyState: "date",
    readyDate: day(6),
    deliverBy: day(3),
  });
  expect(
    backwards.err instanceof WebJobValidationError &&
      backwards.err.message === READY_AFTER_DEADLINE &&
      backwards.wrote === 0,
    `R3: a ready date after the delivery deadline is refused in the board's calendar (got ${
      backwards.err instanceof Error ? backwards.err.message : "a 201"
    })`,
  );

  const ordered = await insertWebJob(
    actor,
    jobBody({ readyState: "date", readyDate: day(3), deliverBy: day(6) }),
  );
  const orderedRow = await stateOf(ordered.id);
  expect(
    orderedRow.ready_state === "date" && orderedRow.ready_date === day(3) && !orderedRow.ready_now,
    `R3: and the same two dates the right way round publish as a stated date (got ${JSON.stringify(orderedRow)})`,
  );
}

/**
 * R4: a ZIP that contradicts the state posted beside it.
 *
 * The last of the review's honesty gaps, and the quietest: posting
 * `deliveryState:"FL"` with `deliveryZip:"07102"` -- a Newark ZIP -- returned
 * 201. Nothing was invented, which is why it survived a review: the geocoder
 * saw the disagreement, refused the ZIP's point and stored Florida's centroid
 * at `delivery_precision:'state'` with no city, and the card said "Approximate
 * delivery". But the row held a Florida job carrying a New Jersey ZIP, a driver
 * filtering by state and a driver filtering by ZIP got different answers about
 * the same load, and the one person who knew which half was true was never
 * asked.
 *
 * The refusal is a QUESTION -- "07102 is a New Jersey ZIP, but the delivery
 * state says Florida. Which is right?" -- and the section asserts the shape of
 * it as much as the fact of it, because a blanket "invalid ZIP" would have
 * closed the gap while telling the poster nothing they could act on.
 *
 * Four things that are NOT conflicts are asserted just as hard, because a
 * validator that over-refuses is its own kind of dishonesty -- it would be
 * claiming to know a ZIP is wrong when all it knows is that a prefix table has
 * never heard of it:
 *
 *   * a ZIP outside the published allocations (09001 is military mail);
 *   * a leading zero, which must survive as five characters everywhere -- in
 *     the column, in the question, and in the button that offers to keep it;
 *   * a blank ZIP beside a state;
 *   * a ZIP with no state chosen at all.
 *
 * Driven through `insertWebJob` and `insertWebTruck` rather than through the
 * routes, for the reason T6 gives: they are where the form's round trip and the
 * public POST both end, so a refusal proved here cannot be true of one caller
 * and false of the other. The last case closes the loop the other way -- over
 * every row this section wrote, no `loads` or `trucks` row holds a state and a
 * placeable ZIP that disagree.
 */
async function zipStateAgreement() {
  console.log(`\n${DIM}R4: a ZIP that contradicts its state is asked about, not accepted${RESET}`);

  const { query, queryOne } = await import("../src/lib/db");
  const { insertWebJob, insertWebTruck, WebJobValidationError, WebTruckValidationError } =
    await import("../src/lib/pipeline/web");
  // The SAME function the two forms call in the browser. Importing it here is
  // the point of the case at the end: the sentence a poster reads before they
  // submit and the sentence the API answers with are one string, not two that
  // happen to match today.
  const { zipStateConflict } = await import("../src/lib/geo/states");

  await query(
    `INSERT INTO users (email, password_hash, name, role, phone, company, is_demo, can_post)
     VALUES ('zip@lifecycle.test','x','Zip Poster','poster','+12015550188','Lifecycle Movers',false,true)
     ON CONFLICT (email) DO NOTHING`,
  );
  const row = (await queryOne<{ id: number }>(
    `SELECT id FROM users WHERE email = 'zip@lifecycle.test'`,
  ))!;
  const actor = { id: row.id, name: "Zip Poster", phone: "+12015550188", isDemo: false };

  // Coordinates supplied throughout, so nothing here reaches a geocoder: HERE
  // is unconfigured in this run and the subject is the pair of fields, not the
  // placing of them.
  const jobBody = (extra: Record<string, string>) => ({
    pickup: "Kearny, NJ 07032",
    pickupLat: "40.7684",
    pickupLng: "-74.1454",
    pickupState: "NJ",
    pickupZip: "07032",
    pickupPrecision: "zip",
    deliveryState: "FL",
    deliveryZip: "33435",
    cubicFeet: "800",
    readyState: "unknown" as const,
    contactPhone: "+12015550188",
    ...extra,
  });
  const truckBody = (extra: Record<string, string>) => ({
    origin: "Kearny, NJ 07032",
    originLat: "40.7684",
    originLng: "-74.1454",
    originState: "NJ",
    originZip: "07032",
    originPrecision: "zip",
    destUndecided: "on",
    freeCf: "700",
    availMode: "unknown",
    contactPhone: "+12015550188",
    ...extra,
  });

  const jobs = async () =>
    (await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM loads WHERE posted_by = $1`, [
      row.id,
    ]))!.n;
  const trucks = async () =>
    (await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM trucks WHERE posted_by = $1`, [
      row.id,
    ]))!.n;

  const jobRefusal = async (extra: Record<string, string>) => {
    const before = await jobs();
    try {
      await insertWebJob(actor, jobBody(extra));
      return { err: null as unknown, wrote: (await jobs()) - before };
    } catch (e) {
      return { err: e, wrote: (await jobs()) - before };
    }
  };
  const truckRefusal = async (extra: Record<string, string>) => {
    const before = await trucks();
    try {
      await insertWebTruck(actor, truckBody(extra) as Parameters<typeof insertWebTruck>[1]);
      return { err: null as unknown, wrote: (await trucks()) - before };
    } catch (e) {
      return { err: e, wrote: (await trucks()) - before };
    }
  };

  // --- the review's own case ------------------------------------------------
  const delivery = await jobRefusal({ deliveryZip: "07102" });
  const deliveryMsg = delivery.err instanceof Error ? delivery.err.message : "a 201";
  expect(
    delivery.err instanceof WebJobValidationError &&
      delivery.err.field === "deliveryZip" &&
      delivery.wrote === 0,
    `R4: FL + 07102 is refused and writes no row, naming the ZIP field (got "${deliveryMsg}", ${delivery.wrote} rows)`,
  );
  expect(
    deliveryMsg ===
      "07102 is a New Jersey ZIP, but the delivery state says Florida. Which is right?",
    `R4: and it ASKS rather than rejects, naming both states in full (got "${deliveryMsg}")`,
  );
  expect(
    deliveryMsg.includes("07102") && !/\b7102\b/.test(deliveryMsg),
    `R4: the leading zero survives into the question -- "07102", never 7102 (got "${deliveryMsg}")`,
  );
  expect(
    zipStateConflict("FL", "07102", "delivery")?.message === deliveryMsg,
    "R4: the browser refuses in the API's exact words, out of the same function",
  );

  // --- the same disagreement at the other end -------------------------------
  const pickup = await jobRefusal({ pickupState: "FL" });
  expect(
    pickup.err instanceof WebJobValidationError &&
      pickup.err.field === "pickupZip" &&
      pickup.wrote === 0 &&
      pickup.err.message.startsWith("07032 is a New Jersey ZIP, but the pickup state"),
    `R4: the pickup end is checked too, and says which end it means (got "${
      pickup.err instanceof Error ? pickup.err.message : "a 201"
    }")`,
  );

  // --- what is NOT a conflict ----------------------------------------------
  // 09001 is military mail: outside every published allocation, so the table
  // cannot place it. Refusing it would be claiming knowledge we do not have.
  const unknownZip = await jobRefusal({ deliveryZip: "09001" });
  expect(
    unknownZip.err === null && unknownZip.wrote === 1,
    `R4: a ZIP the table cannot place is accepted -- we refuse only what we can judge (got "${
      unknownZip.err instanceof Error ? unknownZip.err.message : "accepted"
    }")`,
  );

  const noZip = await jobRefusal({ deliveryZip: "", deliveryCity: "Boca Raton" });
  expect(
    noZip.err === null && noZip.wrote === 1,
    `R4: a state with no ZIP has nothing to disagree with (got "${
      noZip.err instanceof Error ? noZip.err.message : "accepted"
    }")`,
  );

  const noState = await jobRefusal({ pickupState: "", pickupZip: "07102" });
  expect(
    noState.err === null && noState.wrote === 1,
    `R4: a ZIP with no state chosen is not a disagreement either (got "${
      noState.err instanceof Error ? noState.err.message : "accepted"
    }")`,
  );
  const zeroKept = (await queryOne<{ zip: string | null; state: string | null }>(
    `SELECT pickup_zip AS zip, pickup_state AS state FROM loads
      WHERE posted_by = $1 ORDER BY id DESC LIMIT 1`,
    [row.id],
  ))!;
  expect(
    zeroKept.zip === "07102" && zeroKept.state === null,
    `R4: and it is stored as five characters with no state invented for it (got ${JSON.stringify(zeroKept)})`,
  );

  const agreeing = await jobRefusal({ deliveryState: "NJ", deliveryZip: "07102" });
  const happy = (await queryOne<{ pz: string | null; dz: string | null; ds: string | null }>(
    `SELECT pickup_zip AS pz, delivery_zip AS dz, delivery_state AS ds FROM loads
      WHERE posted_by = $1 ORDER BY id DESC LIMIT 1`,
    [row.id],
  ))!;
  expect(
    agreeing.err === null && agreeing.wrote === 1 && happy.dz === "07102" && happy.ds === "NJ",
    `R4: the happy path -- NJ + 07102 posts, and both zeros are still there (got ${JSON.stringify(happy)})`,
  );
  expect(
    happy.pz === "07032",
    `R4: the pickup's own leading zero is intact on the same row (got ${JSON.stringify(happy.pz)})`,
  );

  // --- the truck's two ends -------------------------------------------------
  const originClash = await truckRefusal({ originState: "FL" });
  expect(
    originClash.err instanceof WebTruckValidationError &&
      originClash.err.field === "originZip" &&
      originClash.wrote === 0 &&
      originClash.err.message.includes("the origin state says Florida"),
    `R4: a truck's origin is checked the same way (got "${
      originClash.err instanceof Error ? originClash.err.message : "a 201"
    }")`,
  );

  const destClash = await truckRefusal({
    destUndecided: "",
    dest: "Miami, FL 33101",
    destLat: "25.7743",
    destLng: "-80.1937",
    destState: "FL",
    destZip: "07102",
    destPrecision: "zip",
  });
  expect(
    destClash.err instanceof WebTruckValidationError &&
      destClash.err.field === "destZip" &&
      destClash.wrote === 0 &&
      destClash.err.message.includes("the destination state says Florida"),
    `R4: and so is its destination (got "${
      destClash.err instanceof Error ? destClash.err.message : "a 201"
    }")`,
  );

  const goodTruck = await truckRefusal({});
  expect(
    goodTruck.err === null && goodTruck.wrote === 1,
    `R4: an agreeing truck still posts (got "${
      goodTruck.err instanceof Error ? goodTruck.err.message : "accepted"
    }")`,
  );

  // --- the invariant, read back off the tables ------------------------------
  // The refusals above are about one call each; this is about the columns. Of
  // everything the web writers put in the two tables, no row holds a state and
  // a ZIP the table CAN place that disagree -- which is the property the whole
  // section exists to buy, stated once over the data rather than case by case.
  const { stateForZip } = await import("../src/lib/geo/states");
  const ends = [
    ...(await query<{ st: string | null; zip: string | null }>(
      `SELECT pickup_state AS st, pickup_zip AS zip FROM loads WHERE posted_by IS NOT NULL
        UNION ALL
       SELECT delivery_state, delivery_zip FROM loads WHERE posted_by IS NOT NULL`,
    )),
    ...(await query<{ st: string | null; zip: string | null }>(
      `SELECT origin_state AS st, origin_zip AS zip FROM trucks WHERE posted_by IS NOT NULL
        UNION ALL
       SELECT dest_state, dest_zip FROM trucks WHERE posted_by IS NOT NULL`,
    )),
  ];
  const disagreeing = ends.filter(
    (e) => e.st && e.zip && stateForZip(e.zip) && stateForZip(e.zip)!.abbr !== e.st,
  );
  expect(
    disagreeing.length === 0 && ends.length > 0,
    `R4: across ${ends.length} posted endpoints, none stores a state and a placeable ZIP that disagree (got ${JSON.stringify(
      disagreeing.slice(0, 3),
    )})`,
  );
}

/**
 * The truck's own clock: T4, T5, T6 and T8.
 *
 * A truck expires on its DEPARTURE, not on its sender's silence, so none of the
 * machinery above applies to it -- no snapshot, no rebuildSender, no
 * supersession. That is the point of the section: every assertion here would be
 * wrong if a truck were swept the way a job is.
 *
 * The clock is anchored at a fixed hour rather than at `new Date()`, and the
 * anchor is asserted: "+12 h is still the same day and +25 h is the next one"
 * has to be TRUE of the instants this test uses, or T4 would pass or fail by
 * what time of day the suite happened to run.
 */
async function truckLifecycle() {
  console.log(`\n${DIM}T4-T6, T8: a truck expires on its departure, not on its sender's silence${RESET}`);

  const { query, queryOne } = await import("../src/lib/db");
  const { expireTrucks, truckExpiresAt, CAPACITY_TTL_HOURS } = await import(
    "../src/lib/pipeline/trucks"
  );
  const { expireStaleLoads } = await import("../src/lib/pipeline/expire");
  const { DEFAULT_TZ, isoOf, toLocalDate } = await import("../src/lib/extract/dates");
  const { insertTruck } = await import("./fixtures/trucks");

  // Midday UTC on today's date: early enough in the board's day that +12 h does
  // not cross midnight, and late enough that +25 h certainly does.
  const today = new Date();
  const T0 = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12));
  const day = (h: number) => new Date(T0.getTime() + h * HOUR);
  const localDay = (d: Date) => isoOf(toLocalDate(d, DEFAULT_TZ));
  expect(
    localDay(T0) === localDay(day(12)) && localDay(day(25)) !== localDay(T0),
    `the test clock is anchored inside one board day (${localDay(T0)} / ${localDay(day(12))} / ${localDay(day(25))})`,
  );

  const YARD = {
    origin_label: "Kearny, NJ 07032",
    origin_city: "Kearny",
    origin_state: "NJ",
    origin_zip: "07032",
    origin_lat: 40.7684,
    origin_lng: -74.1454,
    origin_precision: "zip",
    free_cf: 700,
    free_source: "form",
    shape: "form",
  };
  const statusOf = async (id: number) =>
    (await queryOne<{ status: string; status_source: string }>(
      `SELECT status, status_source FROM trucks WHERE id = $1`,
      [id],
    ))!;
  const reasonOf = async (id: number) =>
    (await queryOne<{ detail: { to: string; by: string; reason: string } }>(
      `SELECT detail FROM truck_events WHERE truck_id = $1 AND kind = 'status_changed'
        ORDER BY id DESC LIMIT 1`,
      [id],
    ))?.detail ?? null;

  // --- T4: a stated departure day, and the day after ------------------------
  const dated = await insertTruck({
    ...YARD,
    truck_key: "t4-dated",
    avail_from: localDay(T0),
    avail_to: localDay(T0),
    avail_source: "form",
    first_seen_at: T0.toISOString(),
    last_seen_at: T0.toISOString(),
    seen_count: 1,
    expires_at: truckExpiresAt({ availTo: localDay(T0), lastSeenAt: T0 }).toISOString(),
  });

  await expireTrucks(day(12));
  expect((await statusOf(dated)).status === "available", "T4: a truck departing today is still available 12 h in");

  const sweep = await expireTrucks(day(25));
  expect(
    (await statusOf(dated)).status === "departed",
    `T4: the day after its stated departure it is departed (got ${(await statusOf(dated)).status})`,
  );
  expect(
    sweep.trucksDeparted === 1 && sweep.trucksExpired === 0,
    `T4: the sweep counts a departure and an expiry separately (got ${JSON.stringify(sweep)})`,
  );
  const why = await reasonOf(dated);
  expect(
    why?.to === "departed" && why?.reason === "departure_passed" && why?.by === "expiry_sweep",
    `T4: the event says departure_passed, never sender_silent (got ${JSON.stringify(why)})`,
  );

  // --- T5: no date at all, and a repost that renews the clock ---------------
  const dateless = await insertTruck({
    ...YARD,
    truck_key: "t5-dateless",
    first_seen_at: T0.toISOString(),
    last_seen_at: T0.toISOString(),
    seen_count: 1,
    expires_at: truckExpiresAt({ lastSeenAt: T0 }).toISOString(),
  });
  expect(CAPACITY_TTL_HOURS === 48, `T5: the dateless TTL is 48 h (it is ${CAPACITY_TTL_HOURS})`);

  await expireTrucks(day(47));
  expect((await statusOf(dateless)).status === "available", "T5: a dateless truck is still available at +47 h");

  // Reposted at +40 h: exactly what the stage-6 upsert will write -- a new
  // sighting and an expiry recomputed FROM IT, not from the first sighting.
  const reposted = await insertTruck({
    ...YARD,
    truck_key: "t5-reposted",
    first_seen_at: T0.toISOString(),
    last_seen_at: day(40).toISOString(),
    seen_count: 2,
    expires_at: truckExpiresAt({ lastSeenAt: day(40) }).toISOString(),
  });

  const ttl = await expireTrucks(day(49));
  expect(
    (await statusOf(dateless)).status === "expired",
    `T5: a dateless truck is expired at +49 h (got ${(await statusOf(dateless)).status})`,
  );
  expect(
    ttl.trucksExpired === 1 && ttl.trucksDeparted === 0,
    `T5: the TTL sweep is counted as an expiry, not a departure (got ${JSON.stringify(ttl)})`,
  );
  expect(
    (await reasonOf(dateless))?.reason === "capacity_ttl",
    "T5: a dateless truck expires for capacity_ttl",
  );
  await expireTrucks(day(80));
  expect(
    (await statusOf(reposted)).status === "available",
    `T5: a truck reposted at +40 h is still available at +80 h (got ${(await statusOf(reposted)).status})`,
  );

  // --- T6: booked is sticky, manual is not a shield -------------------------
  const booked = await insertTruck({
    ...YARD,
    truck_key: "t6-booked",
    status: "booked",
    status_source: "manual",
    avail_from: localDay(T0),
    avail_to: localDay(T0),
    avail_source: "form",
    first_seen_at: T0.toISOString(),
    last_seen_at: T0.toISOString(),
    seen_count: 1,
    expires_at: truckExpiresAt({ availTo: localDay(T0), lastSeenAt: T0 }).toISOString(),
  });
  // Set back to available by its owner, and left with a window that has passed.
  const reopened = await insertTruck({
    ...YARD,
    truck_key: "t6-reopened",
    status: "available",
    status_source: "manual",
    avail_from: localDay(T0),
    avail_to: localDay(T0),
    avail_source: "form",
    first_seen_at: T0.toISOString(),
    last_seen_at: T0.toISOString(),
    seen_count: 1,
    expires_at: truckExpiresAt({ availTo: localDay(T0), lastSeenAt: T0 }).toISOString(),
  });

  for (const horizon of [25, 80, 30 * 24]) {
    await expireTrucks(day(horizon));
    expect(
      (await statusOf(booked)).status === "booked",
      `T6: a booked truck is untouched by the sweep at +${horizon} h`,
    );
  }
  const swept = await statusOf(reopened);
  expect(
    swept.status === "departed" && swept.status_source === "manual",
    `T6: a truck set back to available IS swept once its window has passed -- status_source is not consulted (got ${JSON.stringify(swept)})`,
  );

  // --- T6, the other half: the API refuses to put it there in the first place
  //
  // The sweep above is the safety net; this is the door. SPEC 10.2: "Setting a
  // truck back to `available` through `PATCH` recomputes `expires_at` from
  // `now`, and is refused with 'That date has already passed -- post a new
  // departure' when the window is in the past."
  //
  // Driven through `updateWebTruck`, which is what BOTH truck write routes call,
  // so the refusal cannot be true of one route and false of the other.
  const { insertWebTruck, updateWebTruck, WebTruckValidationError } = await import(
    "../src/lib/pipeline/web"
  );
  // `updateWebTruck` writes an `edited` event carrying `actor_id`, and that is a
  // real foreign key, so this section needs an account to act as. Nothing above
  // it does, which is why there is none yet.
  const owner = await queryOne<{ id: number }>(
    `INSERT INTO users (email, password_hash, name, role, is_demo, can_post)
     VALUES ('t6@lifecycle.invalid','x','T6 Owner','driver',false,true)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
  );
  const yesterday = isoOf(toLocalDate(new Date(Date.now() - DAY), DEFAULT_TZ));
  const tomorrow = isoOf(toLocalDate(new Date(Date.now() + DAY), DEFAULT_TZ));

  const stale = await insertTruck({
    ...YARD,
    truck_key: "t6-api-stale",
    status: "booked",
    status_source: "manual",
    avail_from: yesterday,
    avail_to: yesterday,
    avail_source: "form",
    first_seen_at: T0.toISOString(),
    last_seen_at: T0.toISOString(),
    seen_count: 1,
    expires_at: truckExpiresAt({ availTo: yesterday, lastSeenAt: T0 }).toISOString(),
  });
  let refusal: unknown = null;
  try {
    await updateWebTruck(stale, owner!.id, { status: "available" });
  } catch (err) {
    refusal = err;
  }
  expect(
    refusal instanceof WebTruckValidationError &&
      refusal.message === "That date has already passed — post a new departure",
    `T6: handing a truck back to available with a past window is refused by the API (got ${
      refusal instanceof Error ? JSON.stringify(refusal.message) : "no refusal at all"
    })`,
  );
  expect(
    (await statusOf(stale)).status === "booked",
    "T6: and the refusal left the row alone, rather than half-writing it",
  );

  // The same end state reached from the other side: an AVAILABLE truck whose
  // dates are edited backwards is the identical lie on the board.
  const backdated = await insertTruck({
    ...YARD,
    truck_key: "t6-api-backdated",
    status: "available",
    status_source: "derived",
    avail_from: tomorrow,
    avail_to: tomorrow,
    avail_source: "form",
    first_seen_at: T0.toISOString(),
    last_seen_at: T0.toISOString(),
    seen_count: 1,
    expires_at: truckExpiresAt({ availTo: tomorrow, lastSeenAt: T0 }).toISOString(),
  });
  let editRefusal: unknown = null;
  try {
    await updateWebTruck(backdated, owner!.id, {
      availMode: "between",
      availFrom: yesterday,
      availTo: yesterday,
    });
  } catch (err) {
    editRefusal = err;
  }
  expect(
    editRefusal instanceof WebTruckValidationError,
    `T6: editing an available truck's dates into the past is refused too (got ${
      editRefusal instanceof Error ? JSON.stringify(editRefusal.message) : "no refusal at all"
    })`,
  );

  // A move FORWARD is the edit this feature exists for, and must still work.
  const moved = await updateWebTruck(backdated, owner!.id, {
    availMode: "between",
    availFrom: tomorrow,
    availTo: isoOf(toLocalDate(new Date(Date.now() + 3 * DAY), DEFAULT_TZ)),
  });
  expect(
    moved != null && moved.changed.includes("avail_to"),
    `T6: a departure moved FORWARD is still an ordinary edit (got ${JSON.stringify(moved)})`,
  );

  // SPEC 10.2's other half: a relist re-anchors the TTL at `now`, so a DATELESS
  // truck unbooked two days later does not come back already dead.
  const relistable = await insertTruck({
    ...YARD,
    truck_key: "t6-api-dateless",
    status: "booked",
    status_source: "manual",
    avail_from: null,
    avail_to: null,
    avail_source: null,
    first_seen_at: new Date(Date.now() - 3 * DAY).toISOString(),
    last_seen_at: new Date(Date.now() - 3 * DAY).toISOString(),
    seen_count: 1,
    expires_at: truckExpiresAt({ lastSeenAt: new Date(Date.now() - 3 * DAY) }).toISOString(),
  });
  await updateWebTruck(relistable, owner!.id, { status: "available" });
  const relisted = await queryOne<{ status: string; expires_at: string }>(
    `SELECT status, expires_at::text AS expires_at FROM trucks WHERE id = $1`,
    [relistable],
  );
  expect(
    relisted!.status === "available" && new Date(relisted!.expires_at).getTime() > Date.now(),
    `T6: a dateless truck handed back to available gets its 48 h from now, not from last_seen_at (expires ${relisted!.expires_at})`,
  );
  await expireTrucks(new Date());
  expect(
    (await statusOf(relistable)).status === "available",
    "T6: ...so the very next sweep does not delete the listing its owner just restored",
  );

  // --- T6, the THIRD door: POST /api/trucks --------------------------------
  //
  // `updateWebTruck` refused a past window from the day it shipped and
  // `insertWebTruck` did not, so the board accepted through the front door
  // exactly what it refused through the side one: `availMode: "between"` over
  // two days last week returned 201 and the truck went onto the public board
  // as `available`. Both writers now call the same predicate, and these cases
  // are what stops them drifting apart again.
  //
  // Driven through `insertWebTruck` for the same reason the cases above are
  // driven through `updateWebTruck`: it is the function BOTH the route and the
  // form's round trip end in, so a refusal proved here cannot be true of one
  // caller and false of the other.
  const postBody = (avail: { availMode: string; availFrom?: string; availTo?: string }) => ({
    // Coordinates supplied, so `placeFor` never reaches the geocoder: HERE is
    // unconfigured in this run and the subject here is the calendar, not
    // geocoding.
    origin: "Kearny, NJ 07032",
    originLat: "40.7684",
    originLng: "-74.1454",
    originState: "NJ",
    originZip: "07032",
    originPrecision: "zip",
    destUndecided: "on" as const,
    freeCf: "700",
    availMode: avail.availMode,
    availFrom: avail.availFrom ?? "",
    availTo: avail.availTo ?? "",
    contactName: "T6 Owner",
    contactPhone: "+17865550128",
  });
  const poster = { id: owner!.id, name: "T6 Owner", phone: "+17865550128", isDemo: false };
  const postedCount = async () =>
    (await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM trucks WHERE posted_by = $1`, [
      owner!.id,
    ]))!.n;
  const refusalFrom = async (body: ReturnType<typeof postBody>) => {
    const before = await postedCount();
    let err: unknown = null;
    try {
      await insertWebTruck(poster, body);
    } catch (e) {
      err = e;
    }
    return { err, wrote: (await postedCount()) - before };
  };

  const threeDaysAgo = localDay(day(-72));
  const twoDaysAgo = localDay(day(-48));
  const dayBefore = localDay(day(-24));

  const wholly = await refusalFrom(
    postBody({ availMode: "between", availFrom: threeDaysAgo, availTo: twoDaysAgo }),
  );
  expect(
    wholly.err instanceof WebTruckValidationError &&
      wholly.err.message === "That date has already passed — post a new departure",
    `T6: POSTing a window entirely in the past is refused (${threeDaysAgo}..${twoDaysAgo}; got ${
      wholly.err instanceof Error ? JSON.stringify(wholly.err.message) : "a 201"
    })`,
  );
  expect(
    wholly.err instanceof WebTruckValidationError && wholly.err.field === "availTo",
    "T6: ...naming availTo, so the form can put the sentence under the date that has to change",
  );
  expect(wholly.wrote === 0, "T6: ...and nothing reached the trucks table on the way out");

  // THE BOUNDARY, and it is the assertion this whole section is about. A window
  // ending TODAY has not passed: the truck leaves this evening, a dispatcher can
  // still ring it, and `expireTrucks` agrees -- it sweeps on `avail_to < today`,
  // not `<=`. Refusing this would make the board unpostable for same-day
  // capacity, which is the most valuable kind there is.
  const endsToday = await insertWebTruck(
    poster,
    postBody({ availMode: "between", availFrom: dayBefore, availTo: localDay(T0) }),
  );
  const todayRow = await queryOne<{ status: string; avail_to: string }>(
    `SELECT status, avail_to::text AS avail_to FROM trucks WHERE id = $1`,
    [endsToday.id],
  );
  expect(
    todayRow!.status === "available" && todayRow!.avail_to === localDay(T0),
    `T6: a window ending TODAY is posted and goes on the board available (got ${JSON.stringify(todayRow)})`,
  );

  // One day the other side of the same line.
  const endsYesterday = await refusalFrom(
    postBody({ availMode: "between", availFrom: dayBefore, availTo: dayBefore }),
  );
  expect(
    endsYesterday.err instanceof WebTruckValidationError && endsYesterday.wrote === 0,
    `T6: a window ending YESTERDAY is refused (${dayBefore}; got ${
      endsYesterday.err instanceof Error ? JSON.stringify(endsYesterday.err.message) : "a 201"
    })`,
  );

  // A single open date is the same rule read off `availFrom`, and the message
  // has to hang on the field the form is actually showing.
  const openPast = await refusalFrom(postBody({ availMode: "from", availFrom: dayBefore }));
  expect(
    openPast.err instanceof WebTruckValidationError && openPast.err.field === "availFrom",
    `T6: "empty from" a day that has gone is refused on availFrom (got ${
      openPast.err instanceof WebTruckValidationError
        ? `${openPast.err.field}: ${openPast.err.message}`
        : "a 201"
    })`,
  );

  // AND THE CHECK DOES NOT OVER-REACH. A truck that stated no date has nothing
  // to be past; it runs on the 48-hour TTL. If the refusal ever caught this,
  // "Not decided" would stop being postable at all.
  const undated = await insertWebTruck(poster, postBody({ availMode: "unknown" }));
  expect(
    (await statusOf(undated.id)).status === "available",
    "T6: a truck with no stated date is still postable -- an undated truck has nothing to be past",
  );

  // --- T8: the two sweeps cannot see each other's table ---------------------
  const sigOf = (table: string) =>
    queryOne<{ sig: string }>(
      `SELECT string_agg(id || ':' || status, ',' ORDER BY id) AS sig FROM ${table}`,
    );

  const loadsBefore = await sigOf("loads");
  await expireTrucks(new Date(T0.getTime() + 5 * DAY));
  expect((await sigOf("loads"))!.sig === loadsBefore!.sig, "T8: expireTrucks touched no loads row");

  // Snapshotted HERE, not before the truck sweep above: that sweep is entitled
  // to move truck rows, and taking the reading before it would charge its work
  // to `expireStaleLoads` and fail this assertion for the wrong reason. (It did:
  // the T6 cases above leave two trucks available at this horizon, which is what
  // made the earlier ordering visible.)
  const trucksBefore = await sigOf("trucks");
  await expireStaleLoads(new Date(T0.getTime() + 5 * DAY));
  expect(
    (await sigOf("trucks"))!.sig === trucksBefore!.sig,
    "T8: expireStaleLoads touched no trucks row",
  );

  // The supersession guard's other half, cheap to state here: a truck carries
  // no sender snapshot, so `rebuildSender` has nothing to match it against even
  // if somebody wired it up. T3 is the full version, in stage 6.
  const snapshots = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM sender_snapshots s
      WHERE EXISTS (SELECT 1 FROM trucks t WHERE t.source_message_id = s.message_id)`,
  );
  expect(snapshots[0].n === 0, "T3 (partial): no truck's source message has a sender snapshot");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
