/**
 * Notifications eval. npm run eval:notify
 *
 * The producer is the one piece of this feature that runs unattended, writes
 * rows nobody asked for, and is read by a person who was not at their desk when
 * it decided. Every failure mode it has is a failure mode of TIME, so this suite
 * moves the clock rather than the data: `runMatchSweep(now)` takes the instant
 * as an argument, so five days of reposts take five milliseconds.
 *
 * SPEC 18 N1..N9, by number, plus the four things a gate can hold that the
 * acceptance list assumes:
 *
 *   N1  THE FIVE-REPOST TEST. The same inventory posted five days running gives
 *       a matching truck ONE notification, on day one -- and each of the five
 *       cron runs reports success. This is the failure the whole design of
 *       `truck_matches` exists to prevent: a naive diff over `last_seen_at`
 *       alerts daily, for ever, about a pairing the driver already read once.
 *   N2  a truck posted through the form and a job posted through the form
 *       notify BOTH owners, exactly once each -- the sweep is a function of
 *       listing rows, not of a WhatsApp processing run.
 *   N3  delisted then back inside 48 h is not news; back after 48 h is.
 *   N4  a `possible -> strong` upgrade is news; the downgrade back is not.
 *   N5  one edit that flips nine pairings is ONE digest, after the ten-minute
 *       quiet window, not nine alerts.
 *   N6  two qualifying batches inside twelve hours is one notification, and the
 *       second WAITS rather than being swallowed.
 *   N7  a WhatsApp-derived listing notifies nobody and errors about nothing.
 *   N8  own rows only, at the route and at the data layer.
 *   N9  no e-mail delivery row exists, and nothing under src/ imports a mail
 *       client -- scanned, not asserted in prose.
 *
 *   C1  the digest sentences, byte for byte, including the singular forms;
 *   C2  the bell's own rule: absent for an account that owns nothing;
 *   C3  the payload carries no phone and no sender key;
 *   C4  notify_inapp = false writes nothing, and turning it back on delivers
 *       the news that was waiting rather than losing it.
 *
 * Runs against an in-memory database (PGLITE_DIR=memory://) so it never touches
 * a real .pgdata, and with no HERE key so it can never spend money. Each numbered
 * scenario truncates the listing tables first: the watermark is global state by
 * design, and scenarios that leaked into each other would be testing the leak.
 */
process.env.PGLITE_DIR = "memory://";
delete process.env.HERE_API_KEY;

import type { NotificationPayload } from "../src/lib/notify/types";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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

const section = (title: string) => console.log(`\n${BOLD}${title}${RESET}`);

/** A truck at the Kearny yard, heading for Boynton Beach. Ordinary on purpose. */
const YARD = {
  origin_label: "Kearny, NJ 07032",
  origin_city: "Kearny",
  origin_state: "NJ",
  origin_zip: "07032",
  origin_lat: 40.7684,
  origin_lng: -74.1454,
  origin_precision: "zip",
  dest_label: "Boynton Beach, FL 33435",
  dest_city: "Boynton Beach",
  dest_state: "FL",
  dest_zip: "33435",
  dest_lat: 26.5254,
  dest_lng: -80.0664,
  dest_precision: "zip",
  free_cf: 2000,
  free_source: "form",
  corridor_miles: 60,
  contact_name: "Dee Driver",
  contact_phone: "+19085557788",
  contact_phone_source: "post",
  shape: "form",
  status: "available",
  visibility: "public",
};

/** A job on the same lane, placed without a geocoder. */
const JOB_FORM = {
  pickup: "Kearny, NJ 07032",
  pickupLat: "40.7684",
  pickupLng: "-74.1454",
  pickupState: "NJ",
  pickupZip: "07032",
  pickupPrecision: "zip",
  deliveryState: "FL",
  deliveryZip: "33435",
  cubicFeet: "800",
  priceMode: "percf" as const,
  pricePerCf: "5.50",
  readyNow: "on" as const,
  contactName: "Pat Poster",
  contactPhone: "+12015550199",
};

async function main() {
  const { exec, query, queryOne } = await import("../src/lib/db");
  const { ingestMessage } = await import("../src/lib/pipeline/ingest");
  const { processPending } = await import("../src/lib/pipeline/process");
  const { insertWebJob, updateWebTruck } = await import("../src/lib/pipeline/web");
  const { insertTruck } = await import("./fixtures/trucks");
  const { runMatchSweep, DIGEST_COOLDOWN_HOURS, REVIVAL_HOURS } = await import(
    "../src/lib/notify/sweep"
  );
  const { listNotifications, markRead, ownsListingOrNotification, unreadCount, getPrefs, setInAppPref } =
    await import("../src/lib/notify/query");
  const { digestHeadline, digestDetail } = await import("../src/lib/notify/copy");
  const { hashPassword } = await import("../src/lib/password");
  const { DEFAULT_TZ, isoOf, toLocalDate } = await import("../src/lib/extract/dates");

  // Midday UTC, so "+12 h is the same board day" holds for every clock below.
  const base = new Date();
  const T0 = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 12));
  const at = (ms: number) => new Date(T0.getTime() + ms);
  const day = (n: number) => at(n * DAY);
  const localDay = (d: Date) => isoOf(toLocalDate(d, DEFAULT_TZ));

  // --- the cast --------------------------------------------------------------
  const user = async (email: string, name: string): Promise<number> => {
    await query(
      `INSERT INTO users (email, password_hash, name, role, phone, company, is_demo, can_post)
       VALUES ($1,$2,$3,'poster','+12015550111','Test Movers',false,true)
       ON CONFLICT (email) DO NOTHING`,
      [email, hashPassword("not-a-real-password"), name],
    );
    return (await queryOne<{ id: number }>(`SELECT id FROM users WHERE email = $1`, [email]))!.id;
  };
  const driver = await user("dee@drivers.test", "Dee Driver");
  const poster = await user("pat@posters.test", "Pat Poster");
  const stranger = await user("sam@strangers.test", "Sam Stranger");

  /**
   * A clean world. The watermark in `match_runs` is deliberately global -- it is
   * the sweep's only state -- so a scenario inheriting the previous one's would
   * be a test of the inheritance rather than of the rule.
   */
  const reset = async () => {
    await exec(
      `TRUNCATE loads, trucks, raw_messages, senders, notifications, match_runs
       RESTART IDENTITY CASCADE`,
    );
  };

  const notificationsFor = (userId: number) =>
    query<{
      id: number;
      kind: string;
      subject_kind: string;
      subject_id: number;
      payload: NotificationPayload;
      created_at: string;
    }>(
      `SELECT id, kind, subject_kind, subject_id, payload, created_at::text AS created_at
         FROM notifications WHERE user_id = $1 ORDER BY id`,
      [userId],
    );

  const pairs = () =>
    query<{
      truck_id: number;
      load_id: number;
      tier: string;
      notified_at: string | null;
      notified_tier: string | null;
      notified_job_at: string | null;
      notified_job_tier: string | null;
      unmatched_at: string | null;
    }>(
      `SELECT truck_id, load_id, tier,
              notified_at::text AS notified_at, notified_tier,
              notified_job_at::text AS notified_job_at, notified_job_tier,
              unmatched_at::text AS unmatched_at
         FROM truck_matches ORDER BY truck_id, load_id`,
    );

  /** One WhatsApp post, ingested and processed at a chosen instant. */
  let seq = 0;
  const post = async (phone: string, body: string, sentAt: Date) => {
    seq += 1;
    const { messageId } = await ingestMessage({
      waMessageId: `notify-${seq}`,
      groupWaId: "notify-group",
      groupName: "Notify test group",
      authorPhone: phone,
      authorName: "Corpus Sender",
      body,
      sentAt,
    });
    await processPending(10, { now: sentAt });
    return messageId;
  };

  const INVENTORY = "FROM KEARNY NJ 07032:\n800 - FL 33435 $5.50\n600 - FL 33101 $4.75";

  /**
   * A job row placed by hand, on the truck's own lane.
   *
   * Used where the FORM cannot express the case: `insertWebJob` requires a size,
   * and the tier rule (N4) is precisely about a job that has none. This is the
   * shape the WhatsApp pipeline writes for a line with no cubic feet on it.
   */
  const insertJobRow = async (
    key: string,
    fields: { cubicFeet?: number | null; deliverBy?: string | null; postedBy?: number | null },
    when: Date,
  ): Promise<number> => {
    const row = await queryOne<{ id: number }>(
      `INSERT INTO loads (job_key, status, posted_by,
                          pickup_label, pickup_state, pickup_zip, pickup_lat, pickup_lng,
                          delivery_label, delivery_state, delivery_zip, delivery_lat, delivery_lng,
                          cubic_feet, ready_now, deliver_by, last_seen_at, created_at, updated_at)
       VALUES ($1,'available',$2,
               'Kearny, NJ 07032','NJ','07032',40.7684,-74.1454,
               'Boynton Beach, FL 33435','FL','33435',26.5254,-80.0664,
               $3, true, $4, $5, $5, $5)
       RETURNING id`,
      [key, fields.postedBy ?? null, fields.cubicFeet ?? null, fields.deliverBy ?? null, when.toISOString()],
    );
    return row!.id;
  };

  // =========================================================================
  // N1 -- the five-repost test
  // =========================================================================
  section("N1  the same inventory, five days running, one notification");
  await reset();

  const n1Truck = await insertTruck({
    ...YARD,
    posted_by: driver,
    truck_key: "n1-truck",
    avail_now: true,
    avail_source: "form",
    first_seen_at: T0.toISOString(),
    last_seen_at: T0.toISOString(),
    seen_count: 1,
  });

  const runs: Array<{ notifications: number; errors: string[] }> = [];
  for (let d = 0; d < 5; d++) {
    await post("+17865550001", INVENTORY, day(d));
    const summary = await runMatchSweep(day(d).getTime() > T0.getTime() ? day(d) : at(HOUR));
    runs.push({ notifications: summary.notificationsWritten, errors: summary.errors });
  }

  const n1Jobs = await queryOne<{ n: number; seen: number }>(
    `SELECT count(*)::int AS n, max(seen_count)::int AS seen FROM loads`,
  );
  expect(
    n1Jobs?.n === 2 && n1Jobs?.seen === 5,
    `N1: five posts of the same two jobs are two rows seen five times (got ${n1Jobs?.n} rows, seen ${n1Jobs?.seen})`,
  );
  const n1Notes = await notificationsFor(driver);
  expect(n1Notes.length === 1, `N1: exactly one notification after five reposts (got ${n1Notes.length})`);
  expect(
    runs.every((r) => r.errors.length === 0),
    `N1: every one of the five cron runs succeeded (errors: ${JSON.stringify(runs.map((r) => r.errors))})`,
  );
  expect(
    runs.map((r) => r.notifications).join(",") === "1,0,0,0,0",
    `N1: the notification is written on day one and never again (got ${runs.map((r) => r.notifications).join(",")})`,
  );
  const n1Pairs = await pairs();
  expect(
    n1Pairs.length === 2 && n1Pairs.every((p) => p.notified_at != null),
    `N1: both pairings are remembered as told-about (got ${JSON.stringify(n1Pairs.map((p) => p.notified_at != null))})`,
  );
  expect(
    n1Notes[0]?.payload.count === 2 && n1Notes[0]?.payload.subjectLane === "NJ → FL",
    `N1: the one notification is a digest of both, about the NJ → FL truck (got ${JSON.stringify(n1Notes[0]?.payload.count)} / ${n1Notes[0]?.payload.subjectLane})`,
  );
  const n1Runs = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM match_runs`);
  expect(n1Runs?.n === 5, `N1: five runs are recorded, so the watermark advanced five times (got ${n1Runs?.n})`);

  // C1: the sentence a person reads, byte for byte.
  const n1Payload = n1Notes[0]!.payload;
  expect(
    digestHeadline("new_matches_for_truck", n1Payload) === "2 loads now match your NJ → FL truck",
    `C1: the digest headline reads as SPEC 12.3 writes it (got ${JSON.stringify(digestHeadline("new_matches_for_truck", n1Payload))})`,
  );
  // SPEC 12.3's worked example, byte for byte, from a payload written by hand so
  // the assertion pins the sentence rather than re-deriving it.
  const SAMPLE: NotificationPayload = {
    count: 8,
    tiers: { strong: 2, possible: 6 },
    top: [],
    subjectLane: "NJ → FL",
  };
  expect(
    digestHeadline("new_matches_for_truck", SAMPLE) === "8 loads now match your NJ → FL truck",
    `C1: SPEC 12.3's headline, byte for byte (got ${JSON.stringify(digestHeadline("new_matches_for_truck", SAMPLE))})`,
  );
  expect(
    digestDetail("new_matches_for_truck", SAMPLE) ===
      '2 strong · 6 possible. "Possible" means something about the job or your truck wasn\'t stated.',
    `C1: SPEC 12.3's second line, byte for byte (got ${JSON.stringify(digestDetail("new_matches_for_truck", SAMPLE))})`,
  );
  expect(
    digestDetail("new_matches_for_job", SAMPLE) ===
      '2 strong · 6 possible. "Possible" means something about the truck or your job wasn\'t stated.',
    "C1: on a job's notification the unstated thing is on the truck",
  );
  expect(
    digestHeadline("new_matches_for_truck", { ...n1Payload, count: 1 }) ===
      "1 load now matches your NJ → FL truck",
    "C1: one match is singular in both the noun and the verb",
  );
  expect(
    digestHeadline("new_matches_for_job", { ...n1Payload, count: 1, subjectLane: "NJ → FL" }) ===
      "1 truck could take your NJ → FL job",
    "C1: the mirror names the other kind of listing",
  );
  expect(
    digestDetail("new_matches_for_truck", { ...n1Payload, tiers: { strong: 2, possible: 0 } }) === "2 strong.",
    'C1: a digest with nothing possible in it does not define "Possible"',
  );

  // C3: nothing in a payload is a phone or a sender key.
  const PHONE_SHAPES: Array<[RegExp, string]> = [
    [/\d{3}[\s.\-]\d{3}[\s.\-]\d{4}/, "separator-formatted phone"],
    [/(?<![\d.])\+?1?\d{10}(?!\d)/, "bare 10-digit run"],
    [/\+\d{10,15}/, "E.164 run"],
    [/phone:/, "sender key"],
  ];
  const everyPayload = JSON.stringify(await query(`SELECT payload FROM notifications`));
  for (const [re, label] of PHONE_SHAPES) {
    expect(!re.test(everyPayload), `C3: no ${label} anywhere in a notification payload`);
  }

  // =========================================================================
  // N2 -- both directions, from the form alone
  // =========================================================================
  section("N2  a form-posted truck and a form-posted job notify both owners, once each");
  await reset();

  const n2Truck = await insertTruck({
    ...YARD,
    posted_by: driver,
    truck_key: "n2-truck",
    avail_now: true,
    avail_source: "form",
    first_seen_at: T0.toISOString(),
    last_seen_at: T0.toISOString(),
    seen_count: 1,
  });
  const first = await runMatchSweep(T0);
  expect(
    first.notificationsWritten === 0 && first.trucksScanned === 1,
    `N2: a truck alone on the board is scanned and notifies nobody (got ${first.trucksScanned}/${first.notificationsWritten})`,
  );

  const { id: n2Job } = await insertWebJob(
    { id: poster, name: "Pat Poster", phone: "+12015550111", isDemo: false },
    JOB_FORM,
  );
  const second = await runMatchSweep(day(1));

  const n2Driver = await notificationsFor(driver);
  const n2Poster = await notificationsFor(poster);
  expect(n2Driver.length === 1, `N2: the truck's owner is told once (got ${n2Driver.length})`);
  expect(n2Poster.length === 1, `N2: the job's owner is told once (got ${n2Poster.length})`);
  expect(
    n2Driver[0]?.kind === "new_matches_for_truck" && n2Driver[0]?.subject_id === n2Truck,
    "N2: the driver's notification is about their own truck",
  );
  expect(
    n2Poster[0]?.kind === "new_matches_for_job" && n2Poster[0]?.subject_id === n2Job,
    "N2: the poster's notification is about their own job",
  );
  const n2Pair = (await pairs())[0];
  expect(
    n2Pair?.notified_at != null && n2Pair?.notified_job_at != null,
    `N2: ONE pairing carries TWO stamps -- a single notified_at could not have told both owners (got ${JSON.stringify(n2Pair)})`,
  );
  expect(second.notificationsWritten === 2, `N2: the run wrote two notifications (got ${second.notificationsWritten})`);

  const third = await runMatchSweep(day(2));
  expect(
    third.notificationsWritten === 0 &&
      (await notificationsFor(driver)).length === 1 &&
      (await notificationsFor(poster)).length === 1,
    "N2: a later run with nothing new says nothing to either owner",
  );

  // C2: the bell's own rule.
  expect(await ownsListingOrNotification(driver), "C2: an account that owns a truck gets a bell");
  expect(await ownsListingOrNotification(poster), "C2: an account that owns a job gets a bell");
  expect(
    !(await ownsListingOrNotification(stranger)),
    "C2: an account that owns nothing and was never notified gets NO bell -- a permanent zero teaches people to ignore bells",
  );
  expect((await unreadCount(driver)) === 1, "C2: the unread count is the bell's number");

  // =========================================================================
  // N3 -- delisted, and back
  // =========================================================================
  section("N3  gone and back inside 48 h is not news; gone and back after it is");
  await reset();

  const n3Truck = await insertTruck({
    ...YARD,
    posted_by: driver,
    truck_key: "n3-truck",
    avail_now: true,
    avail_source: "form",
    first_seen_at: T0.toISOString(),
    last_seen_at: T0.toISOString(),
    seen_count: 1,
  });
  await post("+17865550003", "FROM KEARNY NJ 07032:\n800 - FL 33435 $5.50", T0);
  await runMatchSweep(T0);
  expect((await notificationsFor(driver)).length === 1, "N3: day 1, one notification");

  /** Delist / relist the way the sender reconciler does: status and updated_at. */
  const setJobStatus = async (status: string, when: Date) => {
    await query(`UPDATE loads SET status = $1, updated_at = $2`, [status, when.toISOString()]);
  };

  await setJobStatus("delisted", at(1 * DAY));
  await runMatchSweep(day(1));
  const gone = (await pairs())[0];
  expect(gone?.unmatched_at != null, "N3: the pairing that stopped matching is stamped unmatched");

  await setJobStatus("available", at(1 * DAY + 12 * HOUR));
  await runMatchSweep(at(1 * DAY + 12 * HOUR));
  expect(
    (await notificationsFor(driver)).length === 1,
    "N3: back after 36 h is the same job, not news -- a Tuesday-off / Wednesday-on flap must not alert twice",
  );
  expect((await pairs())[0]?.unmatched_at == null, "N3: the returning pairing is un-stamped again");

  await setJobStatus("delisted", at(2 * DAY));
  await runMatchSweep(day(2));
  await setJobStatus("available", at(2 * DAY + (REVIVAL_HOURS + 1) * HOUR));
  await runMatchSweep(at(2 * DAY + (REVIVAL_HOURS + 1) * HOUR));
  expect(
    (await notificationsFor(driver)).length === 2,
    `N3: back after ${REVIVAL_HOURS} h IS news again (got ${(await notificationsFor(driver)).length})`,
  );

  // =========================================================================
  // N4 -- the tier upgrade, and the downgrade that is not one
  // =========================================================================
  section("N4  possible -> strong is news; strong -> possible is not");
  await reset();

  const n4Truck = await insertTruck({
    ...YARD,
    posted_by: driver,
    truck_key: "n4-truck",
    avail_now: false,
    avail_from: localDay(day(1)),
    avail_to: localDay(day(2)),
    avail_source: "form",
    first_seen_at: T0.toISOString(),
    last_seen_at: T0.toISOString(),
    seen_count: 1,
  });
  // Everything stated except the freight's size: exactly one unknown, which caps
  // the pairing at Possible for ever (SPEC 11.7).
  const n4Job = await insertJobRow("n4-job", { cubicFeet: null }, T0);
  await runMatchSweep(T0);
  const n4First = await pairs();
  expect(
    n4First[0]?.tier === "possible" && n4First[0]?.notified_tier === "possible",
    `N4: a job with no stated size is Possible, and is remembered as such (got ${n4First[0]?.tier}/${n4First[0]?.notified_tier})`,
  );
  expect((await notificationsFor(driver)).length === 1, "N4: one notification for the Possible match");

  // The size arrives -- what `pairCfRevisions` does to a reposted job.
  await query(`UPDATE loads SET cubic_feet = 800, updated_at = $1 WHERE id = $2`, [
    at(13 * HOUR).toISOString(),
    n4Job,
  ]);
  await runMatchSweep(at(13 * HOUR));
  const n4Up = await pairs();
  expect(n4Up[0]?.tier === "strong", `N4: with the size stated the pairing is Strong (got ${n4Up[0]?.tier})`);
  expect(
    (await notificationsFor(driver)).length === 2,
    `N4: the upgrade is news (got ${(await notificationsFor(driver)).length})`,
  );

  await query(`UPDATE loads SET cubic_feet = NULL, updated_at = $1 WHERE id = $2`, [
    at(30 * HOUR).toISOString(),
    n4Job,
  ]);
  await runMatchSweep(at(30 * HOUR));
  expect(
    (await pairs())[0]?.tier === "possible" && (await notificationsFor(driver)).length === 2,
    "N4: the downgrade back to Possible is not news -- nobody is told their match got worse",
  );

  // =========================================================================
  // N5 -- one edit, nine pairings, one digest
  // =========================================================================
  section("N5  an edit that flips nine pairings is one digest, after the quiet window");
  await reset();

  // Nine jobs on the lane, each with a deadline the truck cannot make from a
  // departure forty days out.
  const deadline = localDay(day(10));
  for (let i = 0; i < 9; i++) {
    await insertJobRow(`n5-${i}`, { cubicFeet: 800, deliverBy: deadline }, T0);
  }
  const n5Truck = await insertTruck({
    ...YARD,
    posted_by: driver,
    truck_key: "n5-truck",
    avail_now: false,
    avail_from: localDay(day(40)),
    avail_to: localDay(day(41)),
    avail_source: "form",
    first_seen_at: T0.toISOString(),
    last_seen_at: T0.toISOString(),
    seen_count: 1,
  });
  const before = await runMatchSweep(T0);
  expect(
    before.notificationsWritten === 0 && (await pairs()).length === 0,
    `N5: a truck leaving forty days out matches none of the nine (got ${(await pairs()).length} pairings)`,
  );

  await updateWebTruck(n5Truck, driver, {
    availMode: "between",
    availFrom: localDay(day(1)),
    availTo: localDay(day(2)),
  });
  const quiet = await queryOne<{ q: string | null }>(
    `SELECT quiet_until::text AS q FROM trucks WHERE id = $1`,
    [n5Truck],
  );
  expect(quiet?.q != null, "N5: the edit stamped a quiet window on the truck");

  const during = await runMatchSweep(new Date());
  expect(
    during.quieted === 1 && during.notificationsWritten === 0,
    `N5: the sweep inside the quiet window skips the truck entirely (quieted ${during.quieted}, wrote ${during.notificationsWritten})`,
  );

  const after = await runMatchSweep(new Date(Date.now() + 11 * 60_000));
  const n5Notes = await notificationsFor(driver);
  expect(
    n5Notes.length === 1,
    `N5: nine flipped pairings are ONE digest, not nine alerts (got ${n5Notes.length})`,
  );
  expect(
    n5Notes[0]?.payload.count === 9,
    `N5: and the digest counts all nine (got ${n5Notes[0]?.payload.count})`,
  );
  expect(
    n5Notes[0]?.payload.top.length === 3,
    `N5: three of them are spelled out and the rest are a number (got ${n5Notes[0]?.payload.top.length})`,
  );
  expect(after.quieted === 0, "N5: after the window the truck is a subject again");

  // =========================================================================
  // N6 -- the twelve-hour cap, and what happens to the news it holds back
  // =========================================================================
  section("N6  two batches inside twelve hours is one notification, and the second waits");
  await reset();

  const n6Truck = await insertTruck({
    ...YARD,
    posted_by: driver,
    truck_key: "n6-truck",
    avail_now: true,
    avail_source: "form",
    first_seen_at: T0.toISOString(),
    last_seen_at: T0.toISOString(),
    seen_count: 1,
  });
  await post("+17865550006", "FROM KEARNY NJ 07032:\n800 - FL 33435 $5.50", T0);
  await runMatchSweep(T0);
  expect((await notificationsFor(driver)).length === 1, "N6: the first batch is told");

  await post("+17865550006", "FROM KEARNY NJ 07032:\n800 - FL 33435 $5.50\n700 - FL 33101 $4.00", at(HOUR));
  const capped = await runMatchSweep(at(HOUR));
  expect(
    capped.capped === 1 && (await notificationsFor(driver)).length === 1,
    `N6: a second batch an hour later is held back by the cap (capped ${capped.capped}, notifications ${(await notificationsFor(driver)).length})`,
  );
  const held = (await pairs()).find((p) => p.notified_at == null);
  expect(
    held != null,
    "N6: the held-back pairing is NOT stamped, so the news is pending rather than swallowed",
  );

  const later = await runMatchSweep(at((DIGEST_COOLDOWN_HOURS + 1) * HOUR));
  const n6Notes = await notificationsFor(driver);
  expect(
    later.notificationsWritten === 1 && n6Notes.length === 2,
    `N6: once the cap clears the waiting news goes out (got ${n6Notes.length} notifications)`,
  );
  expect(
    n6Notes[1]?.payload.count === 1,
    `N6: and it is a digest of the ONE new pairing, not of both (got ${n6Notes[1]?.payload.count})`,
  );

  // =========================================================================
  // N7 -- a listing nobody owns
  // =========================================================================
  section("N7  a WhatsApp-derived listing notifies nobody and errors about nothing");
  await reset();

  await insertTruck({
    ...YARD,
    posted_by: null,
    sender_key: "phone:+17865550007",
    truck_key: "n7-whatsapp-truck",
    avail_now: true,
    avail_source: "line",
    first_seen_at: T0.toISOString(),
    last_seen_at: T0.toISOString(),
    seen_count: 1,
  });
  await post("+17865550007", INVENTORY, T0);
  const n7 = await runMatchSweep(T0);
  const n7Total = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM notifications`);
  expect(n7Total?.n === 0, `N7: nothing was notified about a listing with no account (got ${n7Total?.n})`);
  expect(n7.errors.length === 0, `N7: and nothing errored (got ${JSON.stringify(n7.errors)})`);
  expect(
    n7.trucksScanned === 0 && n7.jobsScanned === 0,
    `N7: an ownerless listing is never even a subject -- evaluating it would be work with no consumer (got ${n7.trucksScanned}/${n7.jobsScanned})`,
  );

  // =========================================================================
  // N8 -- own rows only
  // =========================================================================
  section("N8  own rows only, at the route and one call below it");
  await reset();

  const n8Truck = await insertTruck({
    ...YARD,
    posted_by: driver,
    truck_key: "n8-truck",
    avail_now: true,
    avail_source: "form",
    first_seen_at: T0.toISOString(),
    last_seen_at: T0.toISOString(),
    seen_count: 1,
  });
  await post("+17865550008", INVENTORY, T0);
  await runMatchSweep(T0);
  const mine = await listNotifications(driver);
  const theirs = await listNotifications(stranger);
  expect(mine.length === 1 && theirs.length === 0, `N8: one account's rows are not another's (${mine.length}/${theirs.length})`);

  const dismissedByStranger = await markRead(stranger, [mine[0]!.id]);
  expect(
    dismissedByStranger === 0 && (await unreadCount(driver)) === 1,
    "N8: naming somebody else's notification id dismisses nothing and answers 0 -- the same answer an id that was never issued gets",
  );
  const dismissedByOwner = await markRead(driver, [mine[0]!.id]);
  expect(
    dismissedByOwner === 1 && (await unreadCount(driver)) === 0,
    "N8: the owner dismisses their own row and the bell empties",
  );
  expect((await markRead(driver, [mine[0]!.id])) === 0, "N8: dismissing an already-read row changes nothing");

  const notificationsRoute = (await import("../src/app/api/notifications/route")) as {
    GET: (req: Request) => Promise<Response>;
  };
  const forged = await notificationsRoute.GET(
    new Request(`http://localhost/api/notifications?user_id=${driver}`),
  );
  expect(
    forged.status === 401,
    `N8: an anonymous caller naming a real user_id is refused, not answered (got ${forged.status})`,
  );
  const routeSrc = fs.readFileSync(path.join(ROOT, "src/app/api/notifications/route.ts"), "utf8");
  expect(
    !/searchParams|req\.url|params/.test(routeSrc),
    "N8: the handler reads no parameter at all, so there is nothing in the request to forge",
  );

  // =========================================================================
  // N9 -- no mail, anywhere
  // =========================================================================
  section("N9  a notification exists; an e-mail delivery does not");
  const deliveries = await queryOne<{ total: number; inapp: number; email: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE channel = 'inapp')::int AS inapp,
            count(*) FILTER (WHERE channel = 'email')::int AS email
       FROM notification_deliveries`,
  );
  expect(deliveries!.email === 0, `N9: no notification has an e-mail delivery (got ${deliveries!.email})`);
  expect(
    deliveries!.inapp === deliveries!.total && deliveries!.total > 0,
    `N9: every delivery is in-app, and there are some (got ${deliveries!.inapp}/${deliveries!.total})`,
  );
  const orphan = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications n
      WHERE NOT EXISTS (SELECT 1 FROM notification_deliveries d
                         WHERE d.notification_id = n.id AND d.channel = 'inapp')`,
  );
  expect(orphan?.n === 0, `N9: every notification has its in-app delivery recorded (got ${orphan?.n} without)`);

  const MAIL_CLIENTS = [
    "nodemailer",
    "@aws-sdk/client-ses",
    "aws-sdk/clients/ses",
    "@sendgrid/mail",
    "postmark",
    "resend",
    "mailgun",
    "smtp",
  ];
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const offenders: string[] = [];
  for (const file of walk(path.join(ROOT, "src"))) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of MAIL_CLIENTS) {
      const re = new RegExp(String.raw`(?:from|require\()\s*["']${m.replace(/[/@]/g, "\\$&")}`, "i");
      if (re.test(src)) offenders.push(`${path.relative(ROOT, file)} imports ${m}`);
    }
  }
  expect(offenders.length === 0, `N9: no module under src/ imports a mail client (${offenders.join("; ")})`);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  expect(
    !deps.some((d) => MAIL_CLIENTS.some((m) => d === m || d.startsWith(`${m}/`))),
    `N9: and none is installed (${deps.join(", ")})`,
  );

  // =========================================================================
  // C4 -- the preference is a real switch, and it loses nothing
  // =========================================================================
  section("C4  notifications off writes nothing, and back on delivers what waited");
  await reset();

  await insertTruck({
    ...YARD,
    posted_by: driver,
    truck_key: "c4-truck",
    avail_now: true,
    avail_source: "form",
    first_seen_at: T0.toISOString(),
    last_seen_at: T0.toISOString(),
    seen_count: 1,
  });
  await setInAppPref(driver, false);
  await post("+17865550009", INVENTORY, T0);
  const off = await runMatchSweep(T0);
  expect(
    off.notificationsWritten === 0 && (await notificationsFor(driver)).length === 0,
    "C4: with in-app off, a matching board writes no notification",
  );
  expect(
    (await pairs()).every((p) => p.notified_at == null),
    "C4: and stamps nothing, so the news is not consumed by a switch that was off",
  );

  await setInAppPref(driver, true);
  const on = await runMatchSweep(at(HOUR));
  expect(
    on.notificationsWritten === 1 && (await notificationsFor(driver))[0]?.payload.count === 2,
    `N6/C4: turning it back on delivers the news that was waiting, whole (got ${(await notificationsFor(driver))[0]?.payload.count})`,
  );
  const prefs = await getPrefs(driver);
  expect(
    prefs.inapp === true && prefs.email === false && prefs.emailAvailable === false,
    `C4: the settings the page renders (${JSON.stringify(prefs)})`,
  );

  void n1Truck;
  void n3Truck;
  void n4Truck;
  void n6Truck;
  void n8Truck;
}

main()
  .then(() => {
    if (failures.length) {
      console.log(`\n${RED}${failures.length} of ${checks} notification checks failed${RESET}`);
      for (const f of failures) console.log(`  ${RED}✗${RESET} ${f}`);
      process.exit(1);
    }
    console.log(`\n${GREEN}✓${RESET} ${checks} notification checks passed\n`);
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
