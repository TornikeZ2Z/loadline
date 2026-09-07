/**
 * The producer: one pass over the listings, both directions.
 *
 * IT IS A FUNCTION OF LISTING ROWS, NOT OF A WHATSAPP PROCESSING RUN, and that
 * is the single most important sentence in this file. `POST /api/cron/process`
 * drains `raw_messages` only, so hanging matching off it would mean a truck or a
 * job created through the FORM never notifies anybody and never receives a
 * notification -- the most likely shipping configuration on a board with no
 * WhatsApp supply, and the one where the bell renders a permanent zero as if it
 * worked. The state is a watermark in `match_runs`, and nothing else.
 *
 * WHAT MAKES A MATCH NEW is `(truck_id, load_id)` having no `truck_matches`
 * row. That is the whole of it, and it works because a reposted job maps back to
 * the same `loads.id`: a repost bumps `last_seen_at` and `seen_count` and
 * changes nothing the pairing depends on. Reposting is structurally not news.
 * Four second-order rules sit on top, each answering a failure that would
 * otherwise be found in production -- see `notifyIfNew` and the upsert's CASE.
 *
 * NOTHING IS EVER WRITTEN BACK INTO WHATSAPP. `posted_by IS NOT NULL` is
 * load-bearing: a WhatsApp-derived listing has no account, so nobody is notified
 * about it and no message is ever sent anywhere. The product has never posted to
 * a group and this does not change that.
 *
 * NO NETWORK, exactly as the match panels: `evaluateMatch` is pure and
 * `road_miles` is read when the column already holds it, never fetched to find
 * out. A sweep must not make a billable HERE call.
 *
 * SPEC 12.1, 12.2.
 */
import { DEFAULT_TZ, toLocalDate } from "@/lib/extract/dates";
import { query, queryOne, params } from "@/lib/db";
import { loadDemoVisibilitySql } from "@/lib/loads/query";
import { truckDemoVisibilitySql, truckVisibilityClause } from "@/lib/loads/truckQuery";
import { laneLabel } from "@/lib/loads/present";
import { truckLaneLabel } from "@/lib/loads/truckPresent";
import { candidateJobsForTruck, candidateTrucksForJob } from "@/lib/match/candidates";
import { evaluateMatch } from "@/lib/match/evaluate";
import { compareMatches } from "@/lib/match/order";
import type { MatchJob, MatchOk, MatchTruck } from "@/lib/match/types";
import { deliver } from "./dispatch";
import type {
  MatchRunSummary,
  NotificationKind,
  NotificationPayload,
  NotificationTopItem,
  NotifyTier,
  SubjectKind,
} from "./types";

/**
 * How long a pairing must have been gone before its return is news again.
 *
 * A sender's partial post on Tuesday can drop a job out of its own inventory and
 * put it back on Wednesday. Two days is longer than that flap and shorter than
 * "I forgot I ever saw this". SPEC 12.1.1.
 */
export const REVIVAL_HOURS = 48;

/**
 * The hard cap: one notification per user per subject per twelve hours, always
 * a digest. This alone defeats the daily-repost failure mode even if every rule
 * above it has a hole in it, which is exactly why it exists. SPEC 12.1.4.
 */
export const DIGEST_COOLDOWN_HOURS = 12;

/** How many matches a digest spells out. The rest are a count. SPEC 12.2. */
export const DIGEST_TOP = 3;

/** Rows per upsert statement. A cron is not a hot path; a 40k-parameter statement is. */
const UPSERT_CHUNK = 200;

const HOUR = 3_600_000;

/** The truck side of a subject, plus the three things the sweep needs beyond a match. */
type SubjectTruck = MatchTruck & {
  origin_state: string | null;
  dest_state: string | null;
  quiet_until: string | null;
  updated_at: string;
};

/** The job side of a subject, plus the two columns its lane label is made of. */
type SubjectJob = MatchJob & {
  pickup_state: string | null;
  delivery_state: string | null;
};

/** What one upserted pairing came back as, which is the whole of the decision. */
interface PairState {
  load_id: number;
  truck_id: number;
  tier: NotifyTier;
  notified_at: string | null;
  notified_tier: NotifyTier | null;
  notified_job_at: string | null;
  notified_job_tier: NotifyTier | null;
  dismissed_at: string | null;
}

const SUBJECT_TRUCK_COLUMNS = `
  t.id, t.status, t.visibility, t.sender_key, t.posted_by,
  t.origin_lat, t.origin_lng, t.dest_lat, t.dest_lng,
  t.corridor_miles, t.free_cf, t.avail_now,
  t.avail_from::text AS avail_from,
  t.avail_to::text   AS avail_to,
  t.origin_state, t.dest_state,
  t.quiet_until::text AS quiet_until,
  t.updated_at::text  AS updated_at`;

const SUBJECT_JOB_COLUMNS = `
  l.id, l.status, l.sender_key, l.posted_by,
  l.pickup_lat, l.pickup_lng, l.delivery_lat, l.delivery_lng,
  l.cubic_feet, l.ready_now,
  l.ready_date::text AS ready_date,
  l.deliver_by::text AS deliver_by,
  l.requirements, l.road_miles,
  l.pickup_state, l.delivery_state`;

/**
 * The watermark the last run left behind, or the epoch on a cold database.
 *
 * The epoch and not `now()`: a first run on a board that already holds listings
 * has to see all of them, or the feature launches deaf to everything posted
 * before it shipped and stays that way until somebody edits something.
 */
async function readWatermark(): Promise<Date> {
  const row = await queryOne<{ w: string | null }>(
    `SELECT max(watermark)::text AS w FROM match_runs`,
  );
  return row?.w ? new Date(row.w) : new Date(0);
}

/**
 * Trucks worth re-evaluating.
 *
 * Three ways in, and the third is the one SPEC 12.2 spells out longhand as
 * "trucks whose candidate job set contains a load with created_at > watermark".
 * Computing that set exactly would mean running the candidate query to decide
 * whether to run the candidate query, so it is approximated by its own
 * superset: if ANY job moved, every owned truck is looked at. On a board of 98
 * jobs and a handful of trucks that is microseconds, and the approximation can
 * only ever notify about a real match -- it widens what is CHECKED, never what
 * is SENT.
 *
 * `updated_at` and not only `created_at`, on the job side: `pairCfRevisions`
 * writes a new `cubic_feet` onto an existing row, and acceptance N4 requires the
 * `possible -> strong` upgrade that follows. With `created_at` alone an edited
 * job is invisible to the sweep for ever.
 *
 * `posted_by IS NOT NULL` is the notification's own precondition, applied here
 * rather than at the end: a WhatsApp-derived truck has no account to tell, so
 * evaluating it would be work with no consumer.
 */
async function subjectTrucks(watermark: Date, listingMoved: boolean): Promise<SubjectTruck[]> {
  const changed = listingMoved ? `TRUE` : `(t.created_at > $1 OR t.updated_at > $1)`;
  return query<SubjectTruck>(
    `SELECT ${SUBJECT_TRUCK_COLUMNS}
       FROM trucks t
      WHERE t.status = 'available'
        AND t.visibility = 'public'
        AND t.posted_by IS NOT NULL
        AND ${changed}
      ORDER BY t.id`,
    // No placeholder in the statement means no bind value with it: PGlite
    // refuses a parameter the prepared statement does not name.
    listingMoved ? [] : [watermark.toISOString()],
  );
}

/**
 * The mirror. SPEC 12.2 writes this side as "loads with posted_by not null and
 * created_at > watermark" -- which, read literally, means a job posted last week
 * never hears about a truck posted today, and the product's claim is two-way
 * matching. The truck clause one line above it is "…whose candidate set gained a
 * row", so this is that same clause said from the other side rather than a new
 * rule: a job is a subject when it moved, OR when the other population did.
 */
async function subjectJobs(watermark: Date, listingMoved: boolean): Promise<SubjectJob[]> {
  const changed = listingMoved ? `TRUE` : `(l.created_at > $1 OR l.updated_at > $1)`;
  return query<SubjectJob>(
    `SELECT ${SUBJECT_JOB_COLUMNS}
       FROM loads l
      WHERE l.status = 'available'
        AND l.posted_by IS NOT NULL
        AND ${changed}
      ORDER BY l.id`,
    listingMoved ? [] : [watermark.toISOString()],
  );
}

/** Did anything in this table move since the watermark? One indexed count. */
async function anyMoved(table: "loads" | "trucks", watermark: Date): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table}
      WHERE created_at > $1 OR updated_at > $1`,
    [watermark.toISOString()],
  );
  return (row?.n ?? 0) > 0;
}

/**
 * Write the pairings this evaluation found, and hand back what each one MEANS.
 *
 * One statement does the remembering and the deciding at once: the RETURNING
 * row is post-update, so `notified_at IS NULL` on the way out is exactly "this
 * is news", whether the row was inserted a moment ago or has been sitting
 * un-notified since a run the 12-hour cap turned away.
 *
 * The CASE is SPEC 12.1.1, and it is here rather than in TypeScript because it
 * has to be atomic with the write it qualifies: a pairing that was gone for two
 * days or more comes back as news, and one that flapped off and on inside that
 * window does not. Both stamps are cleared together -- the pairing's return is
 * news to each owner or to neither.
 */
async function upsertPairs(
  pairs: Array<{ truckId: number; loadId: number; verdict: MatchOk }>,
  now: Date,
): Promise<Map<string, PairState>> {
  const out = new Map<string, PairState>();
  const iso = now.toISOString();
  const revived = new Date(now.getTime() - REVIVAL_HOURS * HOUR).toISOString();

  for (let i = 0; i < pairs.length; i += UPSERT_CHUNK) {
    const chunk = pairs.slice(i, i + UPSERT_CHUNK);
    const values: string[] = [];
    const args: unknown[] = [iso, revived];
    for (const p of chunk) {
      const base = args.length;
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $1, $1)`,
      );
      args.push(
        p.truckId,
        p.loadId,
        p.verdict.tier,
        p.verdict.score,
        p.verdict.facts.detour_miles == null ? null : Math.round(p.verdict.facts.detour_miles),
        p.verdict.facts.off_route_miles == null ? null : Math.round(p.verdict.facts.off_route_miles),
      );
    }

    const rows = await query<PairState>(
      `INSERT INTO truck_matches
         (truck_id, load_id, tier, score, detour_miles, off_route_miles,
          first_matched_at, last_matched_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (truck_id, load_id) DO UPDATE SET
         tier            = EXCLUDED.tier,
         score           = EXCLUDED.score,
         detour_miles    = EXCLUDED.detour_miles,
         off_route_miles = EXCLUDED.off_route_miles,
         last_matched_at = EXCLUDED.last_matched_at,
         unmatched_at    = NULL,
         notified_at       = CASE WHEN truck_matches.unmatched_at IS NOT NULL
                                   AND truck_matches.unmatched_at <= $2
                                  THEN NULL ELSE truck_matches.notified_at END,
         notified_tier     = CASE WHEN truck_matches.unmatched_at IS NOT NULL
                                   AND truck_matches.unmatched_at <= $2
                                  THEN NULL ELSE truck_matches.notified_tier END,
         notified_job_at   = CASE WHEN truck_matches.unmatched_at IS NOT NULL
                                   AND truck_matches.unmatched_at <= $2
                                  THEN NULL ELSE truck_matches.notified_job_at END,
         notified_job_tier = CASE WHEN truck_matches.unmatched_at IS NOT NULL
                                   AND truck_matches.unmatched_at <= $2
                                  THEN NULL ELSE truck_matches.notified_job_tier END
       RETURNING truck_id, load_id, tier,
                 notified_at::text       AS notified_at,
                 notified_tier,
                 notified_job_at::text   AS notified_job_at,
                 notified_job_tier,
                 dismissed_at::text      AS dismissed_at`,
      args,
    );
    for (const r of rows) out.set(`${r.truck_id}:${r.load_id}`, r);
  }
  return out;
}

/**
 * Everything this truck used to match and no longer does.
 *
 * ONLY THE TRUCK LOOP STAMPS THIS, and the asymmetry is deliberate. The
 * truck-anchored candidate set is the authoritative answer to "does this pairing
 * still hold", because the corridor that defines it is the truck's. Letting the
 * job loop stamp too would mark a pairing unmatched merely because the JOB's
 * owner cannot see that truck -- a demo listing, most obviously -- and the next
 * truck-side run would clear it again: a flap written into the table as if it
 * were a fact about the world.
 */
async function stampUnmatched(truckId: number, matched: number[], now: Date): Promise<number> {
  const rows = await query<{ load_id: number }>(
    `UPDATE truck_matches SET unmatched_at = $2
      WHERE truck_id = $1
        AND unmatched_at IS NULL
        AND NOT (load_id = ANY($3::bigint[]))
      RETURNING load_id`,
    [truckId, now.toISOString(), matched],
  );
  return rows.length;
}

/** The two-letter lane of each counterpart listing, for the payload. */
async function jobLanes(
  ids: number[],
  audience: { userId: number | null; includeDemo?: boolean },
): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const p = params();
  const where = [`l.id = ANY(${p.add(ids)}::bigint[])`];
  const demo = loadDemoVisibilitySql(audience, p);
  if (demo) where.push(demo);
  const rows = await query<{ id: number; pickup_state: string | null; delivery_state: string | null }>(
    `SELECT l.id, l.pickup_state, l.delivery_state FROM loads l WHERE ${where.join(" AND ")}`,
    p.values,
  );
  return new Map(rows.map((r) => [r.id, laneLabel(r)]));
}

async function truckLanes(
  ids: number[],
  audience: { userId: number | null; includeDemo?: boolean },
): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const p = params();
  const where = [`t.id = ANY(${p.add(ids)}::bigint[])`];
  const vis = truckVisibilityClause("public");
  if (vis) where.push(vis);
  const demo = truckDemoVisibilitySql(audience, p);
  if (demo) where.push(demo);
  const rows = await query<{
    id: number;
    origin_state: string | null;
    dest_state: string | null;
    dest_lat: number | null;
  }>(
    `SELECT t.id, t.origin_state, t.dest_state, t.dest_lat FROM trucks t WHERE ${where.join(" AND ")}`,
    p.values,
  );
  return new Map(rows.map((r) => [r.id, truckLaneLabel(r)]));
}

/**
 * One digest, or a reason there is not one.
 *
 * The order of the three refusals matters. `off` is checked first because a
 * person who turned notifications off is not owed a row they will never see;
 * `capped` is checked before the INSERT so the run does not depend on the
 * unique index to be correct, only to be safe; and neither refusal stamps
 * anything, so the news stays pending and goes out on a later run rather than
 * being silently consumed. Acceptance N6 is exactly that property.
 */
async function notifyIfNew(input: {
  userId: number;
  kind: NotificationKind;
  subjectKind: SubjectKind;
  subjectId: number;
  subjectLane: string;
  fresh: Array<{ id: number; verdict: MatchOk; lane: string }>;
  now: Date;
}): Promise<"sent" | "capped" | "off"> {
  const { userId, kind, subjectKind, subjectId, subjectLane, fresh, now } = input;

  const prefs = await queryOne<{ notify_inapp: boolean }>(
    `SELECT notify_inapp FROM users WHERE id = $1`,
    [userId],
  );
  if (!prefs?.notify_inapp) return "off";

  const last = await queryOne<{ at: string | null }>(
    `SELECT max(created_at)::text AS at FROM notifications
      WHERE user_id = $1 AND subject_kind = $2 AND subject_id = $3`,
    [userId, subjectKind, subjectId],
  );
  if (last?.at && now.getTime() - new Date(last.at).getTime() < DIGEST_COOLDOWN_HOURS * HOUR) {
    return "capped";
  }

  const tiers = { strong: 0, possible: 0 };
  for (const f of fresh) tiers[f.verdict.tier] += 1;

  const top: NotificationTopItem[] = fresh.slice(0, DIGEST_TOP).map((f) => ({
    id: f.id,
    tier: f.verdict.tier,
    lane: f.lane,
    reasons: f.verdict.reasons,
  }));

  const payload: NotificationPayload = { count: fresh.length, tiers, top, subjectLane };

  // ON CONFLICT DO NOTHING against notifications_subject_hour_idx: two cron runs
  // that overlap both read "nothing in the last 12 h" and both arrive here, and
  // exactly one of them writes. The loser returns no row and is treated as
  // capped, which is what it is.
  const row = await queryOne<{ id: number }>(
    `INSERT INTO notifications (user_id, kind, subject_kind, subject_id, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [userId, kind, subjectKind, subjectId, JSON.stringify(payload), now.toISOString()],
  );
  if (!row) return "capped";

  await deliver(row.id, ["inapp"], now);
  return "sent";
}

/** The board's own order, so a digest spells out the matches the panel puts first. */
function orderMatches<T extends { id: number; verdict: MatchOk; deadline: string | null; lastSeen: string | null }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) =>
    compareMatches(
      { item: a, verdict: a.verdict },
      { item: b, verdict: b.verdict },
      (x) => ({ deadline: x.deadline, lastSeen: x.lastSeen }),
    ),
  );
}

/**
 * One sweep.
 *
 * `now` is a parameter, never SQL `now()`, so `npm run eval:notify` can move the
 * clock through five days of reposts without waiting five days.
 *
 * EVERY SUBJECT IS EVALUATED UNDER ITS OWN OWNER'S AUDIENCE. That single line is
 * what keeps a demo account's listing out of a stranger's notification: the
 * candidate queries take the audience the board takes, so the match set a sweep
 * sees for a truck is exactly the match set its owner would see on the page the
 * notification links to. A digest that named a row its reader cannot open would
 * be both a leak and a lie.
 *
 * SPEC 12.2.
 */
export async function runMatchSweep(now: Date = new Date()): Promise<MatchRunSummary> {
  const watermark = await readWatermark();
  const today = toLocalDate(now, DEFAULT_TZ);

  const jobsMoved = await anyMoved("loads", watermark);
  const trucksMoved = await anyMoved("trucks", watermark);

  const summary: MatchRunSummary = {
    watermark: now.toISOString(),
    trucksScanned: 0,
    jobsScanned: 0,
    pairsWritten: 0,
    pairsUnmatched: 0,
    notificationsWritten: 0,
    quieted: 0,
    capped: 0,
    errors: [],
  };

  /**
   * How far the watermark may advance.
   *
   * A truck skipped for its quiet window holds it back to just before that
   * truck's own edit, so the run after the window sees the edit as a change
   * again. Without this the edit is inside a completed run's range and the
   * digest it was supposed to produce is lost silently -- which is the failure
   * SPEC 12.1.3 exists to prevent, arriving by the back door.
   */
  let advanceTo = now.getTime();

  // --- the truck direction --------------------------------------------------
  for (const truck of await subjectTrucks(watermark, jobsMoved)) {
    if (truck.quiet_until && new Date(truck.quiet_until).getTime() > now.getTime()) {
      summary.quieted += 1;
      advanceTo = Math.min(advanceTo, new Date(truck.updated_at).getTime() - 1);
      continue;
    }
    try {
      summary.trucksScanned += 1;
      const owner = truck.posted_by!;
      const audience = { userId: owner, includeDemo: false };

      const candidates = await candidateJobsForTruck(truck, audience);
      const ok: Array<{ id: number; verdict: MatchOk; deadline: string | null; lastSeen: string | null }> = [];
      for (const job of candidates) {
        const verdict = evaluateMatch({ truck, job, today });
        if (verdict.ok) ok.push({ id: job.id, verdict, deadline: job.deliver_by, lastSeen: null });
      }

      const matchedIds = ok.map((m) => m.id);
      summary.pairsUnmatched += await stampUnmatched(truck.id, matchedIds, now);

      if (!ok.length) continue;
      const state = await upsertPairs(
        ok.map((m) => ({ truckId: truck.id, loadId: m.id, verdict: m.verdict })),
        now,
      );
      summary.pairsWritten += state.size;

      // §12.1.2: a tier UPGRADE is news; a downgrade and a same-tier change are
      // not. `notified_tier` is the memory, and it is the truck owner's copy.
      const fresh = orderMatches(ok).filter((m) => {
        const s = state.get(`${truck.id}:${m.id}`);
        if (!s || s.dismissed_at) return false;
        if (s.notified_at == null) return true;
        return s.notified_tier === "possible" && m.verdict.tier === "strong";
      });
      if (!fresh.length) continue;

      const lanes = await jobLanes(fresh.slice(0, DIGEST_TOP).map((m) => m.id), audience);
      const outcome = await notifyIfNew({
        userId: owner,
        kind: "new_matches_for_truck",
        subjectKind: "truck",
        subjectId: truck.id,
        subjectLane: truckLaneLabel(truck),
        fresh: fresh.map((m) => ({ id: m.id, verdict: m.verdict, lane: lanes.get(m.id) ?? "? → ?" })),
        now,
      });

      if (outcome === "sent") {
        summary.notificationsWritten += 1;
        await stamp("truck", truck.id, fresh.map((m) => ({ id: m.id, tier: m.verdict.tier })), now);
      } else if (outcome === "capped") {
        summary.capped += 1;
      }
    } catch (err) {
      // One subject cannot take the run down with it. The error is counted and
      // named; the watermark still advances, because a truck that threw will be
      // a subject again the moment anything moves.
      summary.errors.push(`truck ${truck.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- the mirror -----------------------------------------------------------
  for (const job of await subjectJobs(watermark, trucksMoved)) {
    try {
      summary.jobsScanned += 1;
      const owner = job.posted_by!;
      const audience = { userId: owner, includeDemo: false };

      const candidates = await candidateTrucksForJob(job, "public", audience);
      const ok: Array<{ id: number; verdict: MatchOk; deadline: string | null; lastSeen: string | null }> = [];
      for (const truck of candidates) {
        const verdict = evaluateMatch({ truck, job, today });
        if (verdict.ok) ok.push({ id: truck.id, verdict, deadline: truck.avail_to, lastSeen: null });
      }
      if (!ok.length) continue;

      const state = await upsertPairs(
        ok.map((m) => ({ truckId: m.id, loadId: job.id, verdict: m.verdict })),
        now,
      );
      summary.pairsWritten += state.size;

      const fresh = orderMatches(ok).filter((m) => {
        const s = state.get(`${m.id}:${job.id}`);
        if (!s || s.dismissed_at) return false;
        if (s.notified_job_at == null) return true;
        return s.notified_job_tier === "possible" && m.verdict.tier === "strong";
      });
      if (!fresh.length) continue;

      const lanes = await truckLanes(fresh.slice(0, DIGEST_TOP).map((m) => m.id), audience);
      const outcome = await notifyIfNew({
        userId: owner,
        kind: "new_matches_for_job",
        subjectKind: "load",
        subjectId: job.id,
        subjectLane: laneLabel(job),
        fresh: fresh.map((m) => ({ id: m.id, verdict: m.verdict, lane: lanes.get(m.id) ?? "? → ?" })),
        now,
      });

      if (outcome === "sent") {
        summary.notificationsWritten += 1;
        await stamp("load", job.id, fresh.map((m) => ({ id: m.id, tier: m.verdict.tier })), now);
      } else if (outcome === "capped") {
        summary.capped += 1;
      }
    } catch (err) {
      summary.errors.push(`load ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  summary.watermark = new Date(Math.min(advanceTo, now.getTime())).toISOString();

  await query(
    `INSERT INTO match_runs (ran_at, watermark, trucks_scanned, pairs_written, notifications_written)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      now.toISOString(),
      summary.watermark,
      summary.trucksScanned,
      summary.pairsWritten,
      summary.notificationsWritten,
    ],
  );

  return summary;
}

/**
 * Remember that this owner has been told, and at what tier.
 *
 * Written AFTER the notification row exists, never before: a crash between the
 * two leaves a notification with no stamp, and the next run is turned away by
 * the 12-hour cap reading that very row. A stamp written first would leave the
 * opposite -- a pairing marked told about a notification that does not exist,
 * which nothing can recover.
 */
async function stamp(
  side: SubjectKind,
  subjectId: number,
  pairs: Array<{ id: number; tier: NotifyTier }>,
  now: Date,
): Promise<void> {
  const iso = now.toISOString();
  for (const tier of ["strong", "possible"] as const) {
    const ids = pairs.filter((p) => p.tier === tier).map((p) => p.id);
    if (!ids.length) continue;
    if (side === "truck") {
      await query(
        `UPDATE truck_matches SET notified_at = $3, notified_tier = $4
          WHERE truck_id = $1 AND load_id = ANY($2::bigint[])`,
        [subjectId, ids, iso, tier],
      );
    } else {
      await query(
        `UPDATE truck_matches SET notified_job_at = $3, notified_job_tier = $4
          WHERE load_id = $1 AND truck_id = ANY($2::bigint[])`,
        [subjectId, ids, iso, tier],
      );
    }
  }
}
