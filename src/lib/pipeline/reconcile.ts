/**
 * Sender inventories and supersession (A §7, §9.2).
 *
 * A batch post is not a stream of new jobs -- it is the sender's *current
 * inventory*, republished. So the pipeline treats one post as a snapshot: jobs
 * present in the sender's newest full post are available, jobs the newest full
 * post omits are delisted, and a sender who has gone quiet for four days has
 * their jobs expired. Reposts bump "last seen" instead of creating duplicates.
 *
 * Every function that reasons about time takes `now` as an argument and binds
 * it as a parameter -- never SQL now() -- so the lifecycle eval can replay two
 * days of posts against a real clock without mocking the database.
 */
import { query, queryOne } from "@/lib/db";
import type { ExtractedJob, ExtractionOutcome } from "@/lib/extract/schema";
import { normalizePhone } from "@/lib/extract/phone";
import type { ContactMode, LoadStatus, StatusSource } from "@/lib/loads/types";

/** A sender silent for this many days has their derived jobs expired. */
export const SENDER_SILENCE_DAYS = 4;

/**
 * Two posts by the same sender inside this window are read as one list, not as
 * a list and a correction -- movers routinely finish a post in a second message.
 */
export const UNION_WINDOW_HOURS = 6;

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** The message shape the pipeline passes around. */
export interface RawMessageRow {
  id: number;
  group_id: number | null;
  author_name: string | null;
  author_phone: string | null;
  body: string;
  sent_at: string;
  group_name: string | null;
}

/** Thrown when a job id does not exist; B's routes map it to 404. */
export class LoadNotFoundError extends Error {
  constructor(public loadId: number) {
    super("Job not found");
    this.name = "LoadNotFoundError";
  }
}

/**
 * Who a post belongs to.
 *
 * SERVER-ONLY VALUE. For phone-keyed senders the key literally *is* the
 * author's E.164 number, which is the thing the contact gate exists to
 * protect -- `redactJob` nulls it and no public payload ever carries it.
 */
export function senderKeyFor(msg: {
  author_phone: string | null;
  author_name: string | null;
  group_id: number | null;
  id: number;
}): string {
  const phone = normalizePhone(msg.author_phone).e164;
  if (phone) return `phone:${phone}`;
  const slug = slugify(msg.author_name);
  if (slug) return `name:${msg.group_id ?? 0}:${slug}`;
  // No phone and no name: the message stands alone rather than being merged
  // with every other anonymous post in the group.
  return `msg:${msg.id}`;
}

function slugify(name: string | null): string {
  return (name ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isPhoneShaped(s: string | null | undefined): boolean {
  if (!s) return false;
  const digits = s.replace(/\D/g, "");
  return digits.length >= 7 && /^[\s+()\d.\-]+$/.test(s.trim());
}

/** The sender row: contacts (footer first, author fallback), groups, last origin, timestamps. */
export async function upsertSender(key: string, msg: RawMessageRow, outcome: ExtractionOutcome): Promise<void> {
  const names = outcome.contacts.map((c) => c.name).filter((n): n is string => !!n);
  const phones = outcome.contacts.map((c) => c.phone).filter((p): p is string => !!p);
  const authorPhone = normalizePhone(msg.author_phone).e164 ?? msg.author_phone ?? null;
  const displayName = isPhoneShaped(msg.author_name) ? null : msg.author_name;
  await query(
    `INSERT INTO senders (key, author_phone, display_name, contact_names, contact_phones, contact_mode, group_ids,
                          last_origin, first_snapshot_at, last_snapshot_at, snapshot_count)
     VALUES ($1, $2, $3, $4::text[], $5::text[], $6, $7::bigint[], $8::jsonb, $9::timestamptz, $9::timestamptz, 1)
     ON CONFLICT (key) DO UPDATE SET
       author_phone   = COALESCE(EXCLUDED.author_phone, senders.author_phone),
       display_name   = COALESCE(EXCLUDED.display_name, senders.display_name),
       contact_names  = ARRAY(SELECT DISTINCT x FROM unnest(senders.contact_names || EXCLUDED.contact_names) AS x),
       contact_phones = ARRAY(SELECT DISTINCT x FROM unnest(senders.contact_phones || EXCLUDED.contact_phones) AS x),
       contact_mode   = CASE WHEN EXCLUDED.last_snapshot_at >= COALESCE(senders.last_snapshot_at, EXCLUDED.last_snapshot_at)
                             THEN EXCLUDED.contact_mode ELSE senders.contact_mode END,
       group_ids      = ARRAY(SELECT DISTINCT x FROM unnest(senders.group_ids || EXCLUDED.group_ids) AS x),
       last_origin    = CASE WHEN EXCLUDED.last_snapshot_at >= COALESCE(senders.last_snapshot_at, EXCLUDED.last_snapshot_at)
                             THEN COALESCE(EXCLUDED.last_origin, senders.last_origin) ELSE senders.last_origin END,
       first_snapshot_at = LEAST(senders.first_snapshot_at, EXCLUDED.first_snapshot_at),
       last_snapshot_at  = GREATEST(senders.last_snapshot_at, EXCLUDED.last_snapshot_at),
       updated_at     = now()`,
    [
      key,
      authorPhone,
      displayName,
      names,
      phones,
      outcome.contact.mode,
      msg.group_id != null ? [msg.group_id] : [],
      outcome.last_origin ? JSON.stringify(outcome.last_origin) : null,
      new Date(msg.sent_at).toISOString(),
    ],
  );
}

/**
 * One snapshot per message with jobs.
 *
 * `truncated` when WhatsApp cut it; `partial` when the post says it is one, or
 * when it is quantitatively small (< 50 % of the sender's previous full list)
 * AND looks partial in shape (an inherited origin, a lane-only post).
 * Everything else is `full` -- including a daily post titled "UPDATED LIST",
 * because the latest post wins.
 *
 * Only a `full` snapshot delists (see `rebuildSender`), so this classification
 * is the only thing standing between a sender's wording and a live job
 * disappearing from the board.
 */
export async function recordSnapshot(
  key: string,
  msg: RawMessageRow,
  outcome: ExtractionOutcome,
  jobKeys: string[],
  originKeys: string[],
): Promise<{ id: number; kind: "full" | "partial" | "truncated" }> {
  const sentAt = new Date(msg.sent_at).toISOString();
  let kind: "full" | "partial" | "truncated" = "full";
  let reason = "full";

  if (outcome.truncated) {
    kind = "truncated";
    reason = outcome.flags.includes("read_more") ? "truncated:read_more" : "truncated:tail";
  } else if (outcome.partial_marker) {
    // An EXPLICIT partial phrase is decisive, at any size.
    //
    // The sender told us this post is a subset, so believe them and delist
    // nothing. This used to be consulted only inside the `small` gate below,
    // which meant a 10-job sender posting "STILL AVAILABLE:" over 6 of those
    // jobs produced a `full` snapshot and silently delisted the other 4 --
    // while the byte-identical post naming 4 delisted none. Size cannot decide
    // this, because the sender's own words already did.
    //
    // Safe to make decisive because the vocabulary behind `partial_marker` is
    // narrow, explicit and positional: only the PARTIAL list in
    // `extract/lexicon.ts` ("still available", "still have", "also have",
    // "added", "new job(s)", "new load(s)", "just got", "just added",
    // "one more", "1 more"), matched only in the first three non-blank lines.
    // It contains NO title words. "UPDATED LIST" therefore sets no marker and
    // still lands below as `full` that retires what it omits -- the D §0.10 /
    // D25 decision this must not reverse.
    //
    // The two boundaries the size gate used to hide:
    //
    //   * naming MORE jobs than the previous full list ("ALSO HAVE:" over 10
    //     after a 4-job list) -- still `partial`. "Also have" means "in
    //     addition to", not "instead of"; a growing list is the least likely
    //     post to be a complete replacement, and classifying it `full` would
    //     delist any of the old 4 it happens not to repeat.
    //   * naming EXACTLY the previous set -- still `partial`. Both readings
    //     produce identical statuses (nothing is omitted, so nothing is
    //     delisted), so `partial` costs nothing and avoids advancing
    //     `last_full_at`, which is the reference point every delisting is
    //     measured against.
    //
    // Chosen because the two failure modes are not symmetric. Trusting the
    // phrase can leave a job listed after it is gone: a driver calls and is
    // told it is taken, and the 4-day expiry sweep clears it anyway. Ignoring
    // the phrase removes a live job from the board: nobody calls, the mover
    // loses the booking, and no one ever learns it happened. Only the second
    // one is silent, so ambiguity resolves toward keeping the job listed.
    kind = "partial";
    reason = "partial:phrase";
  } else {
    const prevFull = await queryOne<{ job_count: number }>(
      `SELECT job_count FROM sender_snapshots
        WHERE sender_key = $1 AND kind = 'full' AND message_id <> $2
          AND (sent_at < $3::timestamptz OR (sent_at = $3::timestamptz AND message_id < $2))
        ORDER BY sent_at DESC, id DESC LIMIT 1`,
      [key, msg.id, sentAt],
    );
    // Unchanged: with no marker to go on, shape is all we have, and it is only
    // trustworthy on a post far smaller than the sender's usual list.
    const small = !!prevFull && jobKeys.length < 0.5 * prevFull.job_count;
    if (small) {
      const laneOnly =
        outcome.lines.every((l) => l.class !== "HEADER") && outcome.lines.some((l) => l.class === "LANE");
      if (outcome.flags.includes("origin_inherited") || outcome.flags.includes("origin_default")) { kind = "partial"; reason = "partial:inherited"; }
      else if (laneOnly && jobKeys.length <= 2) { kind = "partial"; reason = "partial:lane"; }
      else reason = "full:small";
    }
  }

  const row = await queryOne<{ id: number }>(
    `INSERT INTO sender_snapshots (sender_key, message_id, group_id, sent_at, kind, kind_reason, job_count, job_keys, origin_keys)
     VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8::text[], $9::text[])
     ON CONFLICT (message_id) DO UPDATE SET
       sender_key = EXCLUDED.sender_key, group_id = EXCLUDED.group_id, sent_at = EXCLUDED.sent_at,
       kind = EXCLUDED.kind, kind_reason = EXCLUDED.kind_reason, job_count = EXCLUDED.job_count,
       job_keys = EXCLUDED.job_keys, origin_keys = EXCLUDED.origin_keys
     RETURNING id`,
    [key, msg.id, msg.group_id, sentAt, kind, reason, jobKeys.length, jobKeys, [...new Set(originKeys)]],
  );
  return { id: row!.id, kind };
}

export async function upsertSighting(
  loadId: number,
  snapshotId: number,
  job: ExtractedJob,
  sentAt: Date,
  resolved: { ready_date: string | null; deliver_by: string | null },
): Promise<void> {
  await query(
    `INSERT INTO load_sightings (load_id, snapshot_id, sent_at, line_no, line_text, cubic_feet, price_per_cf, price_flat,
                                 ready_now, ready_date, ready_source, deliver_by, tags, job_notes, confidence)
     VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10::date, $11, $12::date, $13::text[], $14, $15)
     ON CONFLICT (load_id, snapshot_id) DO UPDATE SET
       sent_at = EXCLUDED.sent_at, line_no = EXCLUDED.line_no, line_text = EXCLUDED.line_text,
       cubic_feet = EXCLUDED.cubic_feet, price_per_cf = EXCLUDED.price_per_cf, price_flat = EXCLUDED.price_flat,
       ready_now = EXCLUDED.ready_now, ready_date = EXCLUDED.ready_date, ready_source = EXCLUDED.ready_source,
       deliver_by = EXCLUDED.deliver_by, tags = EXCLUDED.tags, job_notes = EXCLUDED.job_notes, confidence = EXCLUDED.confidence`,
    [
      loadId, snapshotId, sentAt.toISOString(), job.line_no, job.line_text || null,
      job.cubic_feet, job.price_per_cf, job.price_flat,
      job.ready_now, resolved.ready_date, job.ready_source, resolved.deliver_by,
      job.tags, job.notes, job.confidence,
    ],
  );
}

/**
 * CF revisions: a lane the sender listed at 350 cf yesterday and 400 cf today
 * is one job that was corrected, not one job delisted and another created.
 *
 * New keys in this snapshot (rows whose only sighting is this one) are paired
 * with the sender's available rows on the same origin and destination that
 * this snapshot omits. The old row takes the new key and size and keeps its
 * history; the new row is folded into it.
 *
 * Only rows this snapshot is not older than are eligible: a revision can only
 * come from newer information. Without that guard a reprocessed or
 * late-arriving OLD post would be treated as the revision and would write its
 * stale cubic feet and price back over a row a newer post already corrected.
 *
 * A LANE MUST CARRY EXACTLY ONE CANDIDATE ON EACH SIDE (§6.5).
 *
 * The pairing key used to be the lane alone, with cubic feet only sorting the
 * candidates and a greedy walk taking the smallest |Δcf| first. A sender with
 * two genuinely distinct Miami->Atlanta jobs, at 350 cf and 900 cf, who then
 * posted one at 400 cf had the 350 row silently rewritten as the 400 job: it
 * kept the older first_seen_at and seen_count, gained an `edited` event
 * asserting 350 -> 400, and the 900 row was delisted. Two jobs became one,
 * and the survivor carried an edit history that never happened -- on a board
 * whose whole claim is that it does not invent.
 *
 * No stricter key fixes that, because the only fields separating two same-lane
 * jobs are size and price, and those are precisely the fields a revision
 * changes: any key that could tell the two rows apart would also stop
 * recognising the correction the pairing exists for. So the ambiguity is
 * detected instead of resolved. Where a lane offers more than one new row or
 * more than one absent row, there is no evidence saying which pairs with
 * which, |Δcf| is a guess dressed as a measurement, and the lane is skipped:
 * the new row stays a new row, the absent rows are delisted by `rebuildSender`
 * exactly as an unmatched job always is, and nothing claims an edit. The
 * snapshot is flagged so a human can look.
 *
 * One new row against one absent row on a lane is left alone. It can still be
 * a coincidence -- a job taken and a different one posted the same day -- but
 * that is the trade this feature was built to make (S4), the evidence is as
 * good as a WhatsApp list ever gets, and reversing it would retire the
 * correction handling the brief lists as a strength.
 */
export async function pairCfRevisions(key: string, snapshotId: number): Promise<number> {
  const snap = await queryOne<{ job_keys: string[]; sent_at: string }>(
    `SELECT job_keys, sent_at::text AS sent_at FROM sender_snapshots WHERE id = $1`,
    [snapshotId],
  );
  if (!snap) return 0;
  const inSnapshot = new Set(snap.job_keys);
  const sentAt = new Date(snap.sent_at).toISOString();

  const fresh = await query<{ id: number; job_key: string; origin_key: string; dest_key: string; cubic_feet: number | null; ordinal: number }>(
    `SELECT l.id, l.job_key, l.origin_key, l.dest_key, l.cubic_feet, l.ordinal
       FROM loads l
      WHERE l.sender_key = $1 AND l.status_source = 'derived' AND l.cubic_feet IS NOT NULL AND l.ordinal = 1
        AND NOT EXISTS (SELECT 1 FROM load_sightings s WHERE s.load_id = l.id AND s.snapshot_id <> $2)
        AND EXISTS (SELECT 1 FROM load_sightings s WHERE s.load_id = l.id AND s.snapshot_id = $2)`,
    [key, snapshotId],
  );
  if (!fresh.length) return 0;

  const absent = await query<{ id: number; job_key: string; origin_key: string; dest_key: string; cubic_feet: number | null }>(
    `SELECT l.id, l.job_key, l.origin_key, l.dest_key, l.cubic_feet
       FROM loads l
      WHERE l.sender_key = $1 AND l.status = 'available' AND l.status_source = 'derived'
        AND l.cubic_feet IS NOT NULL AND l.ordinal = 1
        AND NOT (l.job_key = ANY($2::text[]))
        AND (l.last_seen_at IS NULL OR l.last_seen_at <= $3::timestamptz)`,
    [key, [...inSnapshot], sentAt],
  );
  if (!absent.length) return 0;

  const laneOf = (r: { origin_key: string; dest_key: string }) => `${r.origin_key}>${r.dest_key}`;
  const tally = (rows: Array<{ origin_key: string; dest_key: string }>) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(laneOf(r), (m.get(laneOf(r)) ?? 0) + 1);
    return m;
  };
  const freshPerLane = tally(fresh);
  const absentPerLane = tally(absent);

  // Lanes where the evidence does not name a single pair. Only lanes with a
  // new row can produce one, so those are the only ones worth judging.
  const ambiguous = new Set<string>();
  for (const [lane, n] of freshPerLane) {
    if (n > 1 || (absentPerLane.get(lane) ?? 0) > 1) ambiguous.add(lane);
  }

  const pairs: Array<{ fresh: (typeof fresh)[number]; old: (typeof absent)[number]; delta: number }> = [];
  for (const f of fresh) {
    if (ambiguous.has(laneOf(f))) continue;
    for (const o of absent) {
      if (o.origin_key !== f.origin_key || o.dest_key !== f.dest_key) continue;
      pairs.push({ fresh: f, old: o, delta: Math.abs((f.cubic_feet ?? 0) - (o.cubic_feet ?? 0)) });
    }
  }
  pairs.sort((a, b) => a.delta - b.delta);

  if (ambiguous.size) {
    await query(`UPDATE sender_snapshots SET needs_review = true WHERE id = $1`, [snapshotId]);
  }

  const usedFresh = new Set<number>();
  const usedOld = new Set<number>();
  let n = 0;
  for (const p of pairs) {
    if (usedFresh.has(p.fresh.id) || usedOld.has(p.old.id)) continue;
    usedFresh.add(p.fresh.id);
    usedOld.add(p.old.id);
    // Move the sighting onto the old row, fold the new row's descriptive
    // columns in, drop the new row, then take over its key.
    await query(`UPDATE load_sightings SET load_id = $1 WHERE load_id = $2 AND snapshot_id = $3`, [p.old.id, p.fresh.id, snapshotId]);
    await query(
      `UPDATE loads o SET
         cubic_feet = n.cubic_feet, price_per_cf = n.price_per_cf, price_flat = n.price_flat, rate_usd = n.rate_usd,
         ready_now = n.ready_now, ready_date = n.ready_date, ready_source = n.ready_source,
         ready_state = n.ready_state, deliver_by = n.deliver_by,
         pickup_date = n.pickup_date, tags = n.tags, flags = n.flags, job_notes = n.job_notes, line_text = n.line_text,
         requirements = n.requirements, contact_name = n.contact_name, contact_phone = n.contact_phone,
         contact_phone_raw = n.contact_phone_raw, contact_mode = n.contact_mode, confidence = n.confidence,
         needs_review = n.needs_review, updated_at = now()
       FROM loads n WHERE o.id = $1 AND n.id = $2`,
      [p.old.id, p.fresh.id],
    );
    await query(`DELETE FROM loads WHERE id = $1`, [p.fresh.id]);
    await query(`UPDATE loads SET job_key = $1 WHERE id = $2`, [p.fresh.job_key, p.old.id]);
    await query(`INSERT INTO load_events (load_id, kind, detail) VALUES ($1, 'edited', $2)`, [
      p.old.id,
      JSON.stringify({ from_cf: p.old.cubic_feet, to_cf: p.fresh.cubic_feet, from_key: p.old.job_key, to_key: p.fresh.job_key, snapshot_id: snapshotId }),
    ]);
    n++;
  }
  return n;
}

/**
 * The sender's own number, from ANY of their posts.
 *
 * `author_phone` is the WhatsApp author id -- in production the Cloud API
 * webhook always carries it, so this is normally just the number -- and
 * `contact_phones` is the union of the footer numbers their posts signed off
 * with. Both are that sender's own row, so nothing here can borrow a different
 * sender's line, and nothing is invented: a sender with neither returns null
 * and their phone-less jobs stay phone-less until an admin attaches one.
 */
async function knownSenderPhone(key: string): Promise<string | null> {
  const s = await queryOne<{ author_phone: string | null; contact_phones: string[] | null }>(
    `SELECT author_phone, contact_phones FROM senders WHERE key = $1`,
    [key],
  );
  if (!s) return null;
  for (const candidate of [s.author_phone, ...(s.contact_phones ?? [])]) {
    const e164 = normalizePhone(candidate).e164;
    if (e164) return e164;
  }
  return null;
}

/**
 * Reuse the sender's number across their posts (§1.3).
 *
 * A dispatcher who signed one post and not the next is the same dispatcher, so
 * a job from the unsigned post is reachable on the number the signed one gave.
 * The rows keep saying where the number came from, because a driver calling the
 * wrong line wastes a call: `contact_phone_source` is 'post' when the message
 * itself carried the number and 'sender' when this function copied it in.
 *
 * Written to be recomputed from scratch on every pass rather than patched:
 * step 1 undoes the previous backfill, step 2 re-derives the marker from what
 * the posts actually say now, step 3 fills the gaps. That is what keeps the
 * marker honest after `upsertJob` rewrites `contact_phone` from a newer post
 * that omitted the number -- there is no state to go stale.
 */
export async function backfillSenderPhone(key: string): Promise<{ phone: string | null; filled: number }> {
  const phone = await knownSenderPhone(key);

  // 1. Undo this function's own previous work, so step 2 sees only what the
  //    messages put there.
  await query(
    `UPDATE loads SET contact_phone = NULL, contact_phone_source = NULL
      WHERE sender_key = $1 AND contact_phone_source = 'sender'`,
    [key],
  );
  // 2. The marker is now a pure function of the row: a number here came from
  //    the post, and a row with none is unmarked.
  await query(
    `UPDATE loads SET contact_phone_source = CASE WHEN contact_phone IS NULL THEN NULL ELSE 'post' END
      WHERE sender_key = $1
        AND contact_phone_source IS DISTINCT FROM (CASE WHEN contact_phone IS NULL THEN NULL ELSE 'post' END)`,
    [key],
  );
  if (!phone) return { phone: null, filled: 0 };

  // 3. Every remaining gap gets the sender's known line, labelled as theirs.
  const filled = await query<{ id: number }>(
    `UPDATE loads SET contact_phone = $2, contact_phone_source = 'sender'
      WHERE sender_key = $1 AND contact_phone IS NULL
      RETURNING id`,
    [key, phone],
  );
  return { phone, filled: filled.length };
}

interface SenderLoad {
  id: number;
  status: LoadStatus;
  status_source: StatusSource;
  first_seen: string | null;
  last_seen: string | null;
  n: number;
  last_msg: number | null;
  delisted_at: string | null;
}

/**
 * Recompute one sender's derived statuses from their snapshots and sightings.
 *
 * Pure function of (snapshots, sightings, now):
 *   manual                                    -> untouched
 *   last seen before the latest full post - 6h -> delisted
 *   this job's last sighting + 4 days < now    -> expired
 *   else                                      -> available
 *
 * Expiry is per job, not per sender: a one-line "still available" post must
 * not revive -- or push the expiry clock of -- the ten jobs it says nothing
 * about. Only a job the newest post actually sights gets its clock refreshed.
 */
export async function rebuildSender(
  key: string,
  now: Date = new Date(),
): Promise<{ available: number; delisted: number; expired: number }> {
  const snapshots = await query<{ id: number; message_id: number; sent_at: string; kind: string }>(
    `SELECT id, message_id, sent_at::text AS sent_at, kind FROM sender_snapshots WHERE sender_key = $1 ORDER BY sent_at, id`,
    [key],
  );

  const loads = await query<SenderLoad>(
    `SELECT l.id, l.status, l.status_source, l.delisted_at::text AS delisted_at,
            agg.first_seen::text AS first_seen, agg.last_seen::text AS last_seen,
            coalesce(agg.n, 0)::int AS n, agg.last_msg
       FROM loads l
       LEFT JOIN (
         SELECT s.load_id, min(s.sent_at) AS first_seen, max(s.sent_at) AS last_seen, count(*)::int AS n,
                (array_agg(sn.message_id ORDER BY s.sent_at DESC, sn.id DESC))[1] AS last_msg
           FROM load_sightings s JOIN sender_snapshots sn ON sn.id = s.snapshot_id
          GROUP BY s.load_id
       ) agg ON agg.load_id = l.id
      WHERE l.sender_key = $1`,
    [key],
  );

  const fulls = snapshots.filter((s) => s.kind === "full");
  const latestFull = fulls.length ? new Date(fulls[fulls.length - 1].sent_at) : null;
  const latestFullSnap = fulls.length ? fulls[fulls.length - 1] : null;
  const lastPost = snapshots.length ? new Date(snapshots[snapshots.length - 1].sent_at) : null;
  const nowIso = now.toISOString();

  const counts = { available: 0, delisted: 0, expired: 0 };
  let previouslyAvailable = 0;
  let retired = 0;

  for (const l of loads) {
    if (l.status === "available") previouslyAvailable++;
    let status: LoadStatus = l.status;
    const lastSeen = l.last_seen ? new Date(l.last_seen) : null;
    // A job's clock runs from its own last sighting, so a post that omits it
    // neither expires it early nor keeps it alive.
    const expiresAt = lastSeen ? new Date(lastSeen.getTime() + SENDER_SILENCE_DAYS * DAY) : null;
    if (l.status_source === "derived") {
      if (!lastSeen) {
        // No sighting at all (a deleted message): nothing to say; leave it.
        status = l.status;
      } else if (latestFull && lastSeen.getTime() < latestFull.getTime() - UNION_WINDOW_HOURS * HOUR) {
        status = "delisted";
      } else if (expiresAt && expiresAt.getTime() < now.getTime()) {
        status = "expired";
      } else {
        status = "available";
      }
    }
    if (status === "available") counts.available++;
    else if (status === "delisted") counts.delisted++;
    else if (status === "expired") counts.expired++;

    const changed = status !== l.status;
    const revived = changed && status === "available" && (l.status === "delisted" || l.status === "expired");
    if (changed && status === "delisted" && l.status === "available") retired++;

    await query(
      `UPDATE loads SET
         status = $2,
         first_seen_at = COALESCE($3::timestamptz, first_seen_at),
         last_seen_at = COALESCE($4::timestamptz, last_seen_at),
         seen_count = GREATEST($5, seen_count),
         snapshot_message_id = COALESCE($6, snapshot_message_id),
         relist_count = relist_count + $7,
         delisted_at = CASE WHEN $2 = 'delisted' THEN COALESCE(delisted_at, $8::timestamptz) ELSE NULL END,
         expires_at = COALESCE($9::timestamptz, expires_at),
         updated_at = CASE WHEN $10 THEN $8::timestamptz ELSE updated_at END
       WHERE id = $1`,
      [l.id, status, l.first_seen, l.last_seen, l.n, l.last_msg, revived ? 1 : 0, nowIso, expiresAt?.toISOString() ?? null, changed],
    );
    if (changed) {
      await query(`INSERT INTO load_events (load_id, kind, detail) VALUES ($1, 'status_changed', $2)`, [
        l.id,
        JSON.stringify({ from: l.status, to: status, by: "snapshot", message_id: latestFullSnap?.message_id ?? snapshots[snapshots.length - 1]?.message_id ?? null }),
      ]);
    }
  }

  // A number this sender gave in one post reaches every job of theirs. Runs on
  // every rebuild -- so a post that arrives without a number, an admin who
  // attaches one, and a reprocess all converge on the same answer.
  await backfillSenderPhone(key);

  // A full post that retires most of a sizeable inventory deserves a look.
  if (latestFullSnap && retired > 0) {
    const review = previouslyAvailable >= 5 && retired > 0.8 * previouslyAvailable;
    await query(
      `UPDATE sender_snapshots SET retired_count = retired_count + $2, needs_review = needs_review OR $3 WHERE id = $1`,
      [latestFullSnap.id, retired, review],
    );
  }

  await query(
    `UPDATE senders SET
       first_snapshot_at = $2::timestamptz, last_snapshot_at = $3::timestamptz, last_full_at = $4::timestamptz,
       snapshot_count = $5, updated_at = now()
     WHERE key = $1`,
    [
      key,
      snapshots.length ? new Date(snapshots[0].sent_at).toISOString() : null,
      lastPost?.toISOString() ?? null,
      latestFull?.toISOString() ?? null,
      snapshots.length,
    ],
  );

  return counts;
}

/**
 * Result of processing one raw message -- defined HERE and only here; consumed
 * by process.ts, the cron route, scripts/process.ts, scripts/seed.ts,
 * demo/reset.ts, the admin routes and C's TestConsole.
 */
export interface ProcessResult {
  messageId: number;
  status: "done" | "skipped" | "error";
  loadsCreated: number;
  /**
   * Always 0 in v2: supersession replaced repost-dedup. Kept because
   * src/app/api/cron/process/route.ts and scripts/process.ts read it and are
   * not otherwise changing.
   */
  duplicates: number;
  reason?: string;
  parse_status?: "clean" | "partial" | "unknown";
  attention?: string | null;
  rebuilt?: { available: number; delisted: number; expired: number };
}

/** expired/delisted are derived only; B's route rejects them with 400. */
export type ManualStatus = "available" | "pending" | "taken" | "cancelled";

/**
 * A human overriding the derived status.
 *
 * "Taken" is sticky: a job marked taken stays taken even when the sender keeps
 * reposting it, because the person who marked it knows something the post does
 * not. Setting it back to "available" hands the row back to the lifecycle.
 */
export async function setManualStatus(
  loadId: number,
  status: ManualStatus,
  actorId: number | null,
): Promise<{ id: number; status: LoadStatus; status_source: StatusSource }> {
  const load = await queryOne<{ id: number; status: LoadStatus; sender_key: string | null }>(
    `SELECT id, status, sender_key FROM loads WHERE id = $1`,
    [loadId],
  );
  if (!load) throw new LoadNotFoundError(loadId);

  const source: StatusSource = status === "available" ? "derived" : "manual";

  await query(
    `UPDATE loads SET status = $1, status_source = $2, updated_at = now() WHERE id = $3`,
    [status, source, loadId],
  );
  await query(
    `INSERT INTO load_events (load_id, actor_id, kind, detail) VALUES ($1,$2,'status_changed',$3)`,
    [loadId, actorId, JSON.stringify({ from: load.status, to: status, by: "manual" })],
  );

  // Handing a batch job back to the lifecycle: what it actually becomes is the
  // sender's business (it may be delisted by a newer snapshot). Website posts
  // have no sender and are set directly.
  if (status === "available" && load.sender_key) {
    await rebuildSender(load.sender_key);
    const after = await queryOne<{ status: LoadStatus; status_source: StatusSource }>(
      `SELECT status, status_source FROM loads WHERE id = $1`,
      [loadId],
    );
    if (after) return { id: loadId, status: after.status, status_source: after.status_source };
  }

  return { id: loadId, status, status_source: source };
}

/** Derived batch rows that no message sights any more are not jobs. */
export async function deleteOrphanLoads(senderKeys: Array<string | null>): Promise<number> {
  const keys = senderKeys.filter((k): k is string => !!k);
  if (!keys.length) return 0;
  const rows = await query<{ id: number }>(
    `DELETE FROM loads l
      WHERE l.sender_key = ANY($1::text[])
        AND l.status_source = 'derived'
        AND l.posted_by IS NULL
        AND NOT EXISTS (SELECT 1 FROM load_sightings s WHERE s.load_id = l.id)
      RETURNING id`,
    [keys],
  );
  return rows.length;
}

/**
 * Remove a message and the jobs that exist only because of it.
 *
 * `loads.source_message_id` is ON DELETE SET NULL, not CASCADE: a job that a
 * later post still sights must survive the deletion of the post that first
 * introduced it. The snapshot and its sightings cascade; whatever is left
 * with no sighting at all is removed, and the sender is rebuilt.
 */
export async function deleteMessage(id: number): Promise<{ senderKey: string | null }> {
  const msg = await queryOne<{ sender_key: string | null }>(
    `SELECT sender_key FROM raw_messages WHERE id = $1`,
    [id],
  );
  if (!msg) return { senderKey: null };

  const own = await query<{ id: number }>(`SELECT id FROM loads WHERE source_message_id = $1`, [id]);
  const ids = own.map((r) => r.id);

  await query(`DELETE FROM raw_messages WHERE id = $1`, [id]);

  if (ids.length) {
    await query(
      `DELETE FROM loads l
        WHERE l.id = ANY($1::bigint[])
          AND l.status_source = 'derived'
          AND l.posted_by IS NULL
          AND NOT EXISTS (SELECT 1 FROM load_sightings s WHERE s.load_id = l.id)`,
      [ids],
    );
  }
  await deleteOrphanLoads([msg.sender_key]);

  if (msg.sender_key) await rebuildSender(msg.sender_key);
  return { senderKey: msg.sender_key };
}

/** Everything the reveal endpoint is allowed to know. SERVER-ONLY. */
export interface RevealedContact {
  contact_name: string | null;
  contact_phone: string | null;
  contact_mode: ContactMode;
  /** 'post' -- the message carried it; 'sender' -- their usual line, reused. */
  contact_phone_source: "post" | "sender" | null;
  group_name: string | null;
  /** The group's stored invite (or wa.me) link. Gated: never on a public row. */
  group_link: string | null;
}

/**
 * The one place a phone number leaves the server -- for either kind of listing.
 *
 * Returns the unredacted contact, where the number came from, and how to reach
 * the group the post was made in -- then records the reveal, at most one event
 * per actor per listing per rolling hour, because clicking Call twice is not
 * twice the interest and an inflated count would make the only signal the board
 * has about demand useless.
 *
 * The group link rides along here rather than on the public row on purpose: a
 * `wa.me` link is a phone number written as a URL, and the gate exists so that
 * reaching the sender at all takes an account.
 *
 * ONE FUNCTION FOR BOTH KINDS, AND `kind` IS THE FIRST ARGUMENT (SPEC §6). A
 * second implementation of the phone gate is not acceptable: the dedupe window,
 * the event, the `detail` payload and the shape of the answer are the whole of
 * the accountability story, and two copies of them would drift within a month
 * of the first bug fix. What the branch changes is only which table is read and
 * which event table the reveal is written into -- `truck_events` exists because
 * `load_events.load_id` is `REFERENCES loads(id)` and a truck's reveal cannot be
 * written there without pointing a foreign key at a row that is not the listing.
 *
 * THE TRUCK BRANCH CARRIES `AND t.visibility = 'public'` AND THE JOB BRANCH HAS
 * NO EQUIVALENT, and that asymmetry is the specification's, not an oversight.
 * Every job row on this table is on the board; a truck can be sitting in the
 * review queue, and an unreviewed, machine-invented listing must not hand out a
 * phone number by id. The caller checks visibility too (`getTruck(id,"public")`
 * in the handler); this clause is the one that survives a caller forgetting.
 *
 * Neither branch has a status predicate, deliberately: a taken job and a booked
 * truck are still worth a call, and refusing the number would tell the driver
 * less than the board already shows them.
 */
export type ContactKind = "job" | "truck";

export async function revealContact(
  kind: ContactKind,
  id: number,
  userId: number,
): Promise<RevealedContact | null> {
  return kind === "truck" ? revealTruckContact(id, userId) : revealJobContact(id, userId);
}

async function revealJobContact(loadId: number, userId: number): Promise<RevealedContact | null> {
  const load = await queryOne<RevealedContact>(
    `SELECT l.contact_name, l.contact_phone, l.contact_mode, l.contact_phone_source,
            g.name AS group_name, g.invite_url AS group_link
       FROM loads l LEFT JOIN whatsapp_groups g ON g.id = l.group_id
      WHERE l.id = $1`,
    [loadId],
  );
  if (!load) return null;

  const recent = await queryOne<{ id: number }>(
    `SELECT id FROM load_events
      WHERE load_id = $1 AND actor_id = $2 AND kind = 'viewed_contact'
        AND created_at > now() - interval '1 hour'
      LIMIT 1`,
    [loadId, userId],
  );

  if (!recent) {
    await query(
      `INSERT INTO load_events (load_id, actor_id, kind, detail)
       VALUES ($1, $2, 'viewed_contact', $3)`,
      [
        loadId,
        userId,
        JSON.stringify({ has_phone: load.contact_phone != null, phone_source: load.contact_phone_source }),
      ],
    );
  }

  return load;
}

/**
 * Exported so `scripts/check-redact.ts` can name it in `RAW_SOURCES`.
 *
 * That list recognises a phone-carrying call BY NAME, so a handler calling
 * something absent from it passes the route assertion vacuously -- green, and
 * proving nothing. Acceptance R4 requires the name to arrive in the same commit
 * as the function, and the suite's own self-test fails if a name there stops
 * resolving to an exported symbol.
 */
export async function revealTruckContact(
  truckId: number,
  userId: number,
): Promise<RevealedContact | null> {
  const truck = await queryOne<RevealedContact>(
    `SELECT t.contact_name, t.contact_phone, t.contact_mode, t.contact_phone_source,
            g.name AS group_name, g.invite_url AS group_link
       FROM trucks t LEFT JOIN whatsapp_groups g ON g.id = t.group_id
      WHERE t.id = $1 AND t.visibility = 'public'`,
    [truckId],
  );
  if (!truck) return null;

  const recent = await queryOne<{ id: number }>(
    `SELECT id FROM truck_events
      WHERE truck_id = $1 AND actor_id = $2 AND kind = 'viewed_contact'
        AND created_at > now() - interval '1 hour'
      LIMIT 1`,
    [truckId, userId],
  );

  if (!recent) {
    await query(
      `INSERT INTO truck_events (truck_id, actor_id, kind, detail)
       VALUES ($1, $2, 'viewed_contact', $3)`,
      [
        truckId,
        userId,
        JSON.stringify({
          has_phone: truck.contact_phone != null,
          phone_source: truck.contact_phone_source,
        }),
      ],
    );
  }

  return truck;
}
