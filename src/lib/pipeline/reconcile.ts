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
 * One snapshot per message with jobs. `partial` only when the post is
 * quantitatively small (< 50 % of the sender's previous full list) AND looks
 * partial (a "still available" phrase, an inherited origin, a lane-only post);
 * `truncated` when WhatsApp cut it. Everything else is `full` -- including a
 * daily post titled "UPDATED LIST", because the latest post wins.
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
  } else {
    const prevFull = await queryOne<{ job_count: number }>(
      `SELECT job_count FROM sender_snapshots
        WHERE sender_key = $1 AND kind = 'full' AND message_id <> $2
          AND (sent_at < $3::timestamptz OR (sent_at = $3::timestamptz AND message_id < $2))
        ORDER BY sent_at DESC, id DESC LIMIT 1`,
      [key, msg.id, sentAt],
    );
    const small = !!prevFull && jobKeys.length < 0.5 * prevFull.job_count;
    if (small) {
      const laneOnly =
        outcome.lines.every((l) => l.class !== "HEADER") && outcome.lines.some((l) => l.class === "LANE");
      if (outcome.partial_marker) { kind = "partial"; reason = "partial:phrase"; }
      else if (outcome.flags.includes("origin_inherited") || outcome.flags.includes("origin_default")) { kind = "partial"; reason = "partial:inherited"; }
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
 * greedily by |Δcf| with the sender's available rows on the same origin and
 * destination that this snapshot omits. The old row takes the new key and
 * size and keeps its history; the new row is folded into it.
 *
 * Only rows this snapshot is not older than are eligible: a revision can only
 * come from newer information. Without that guard a reprocessed or
 * late-arriving OLD post would be treated as the revision and would write its
 * stale cubic feet and price back over a row a newer post already corrected.
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

  const pairs: Array<{ fresh: (typeof fresh)[number]; old: (typeof absent)[number]; delta: number }> = [];
  for (const f of fresh) {
    for (const o of absent) {
      if (o.origin_key !== f.origin_key || o.dest_key !== f.dest_key) continue;
      pairs.push({ fresh: f, old: o, delta: Math.abs((f.cubic_feet ?? 0) - (o.cubic_feet ?? 0)) });
    }
  }
  pairs.sort((a, b) => a.delta - b.delta);

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
         ready_now = n.ready_now, ready_date = n.ready_date, ready_source = n.ready_source, deliver_by = n.deliver_by,
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

/**
 * The one place a phone number leaves the server.
 *
 * Returns the unredacted contact triple and records the reveal -- at most one
 * event per actor per job per rolling hour, because clicking Call twice is not
 * twice the interest, and an inflated count would make the only signal the
 * board has about demand useless.
 */
export async function revealContact(
  loadId: number,
  userId: number,
): Promise<{ contact_name: string | null; contact_phone: string | null; contact_mode: ContactMode } | null> {
  const load = await queryOne<{
    contact_name: string | null;
    contact_phone: string | null;
    contact_mode: ContactMode;
  }>(`SELECT contact_name, contact_phone, contact_mode FROM loads WHERE id = $1`, [loadId]);
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
      [loadId, userId, JSON.stringify({ has_phone: load.contact_phone != null })],
    );
  }

  return load;
}
