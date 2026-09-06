/**
 * Sender inventories and supersession.
 *
 * A batch post is not a stream of new jobs -- it is the sender's *current
 * inventory*, republished. So the pipeline treats one post as a snapshot: jobs
 * present in the sender's newest full post are available, jobs the newest full
 * post omits are delisted, and a sender who has gone quiet for four days has
 * their jobs expired. Reposts bump "last seen" instead of creating duplicates.
 *
 * PHASE 0a: this file exists so every consumer can code against the final
 * signatures. `revealContact`, `setManualStatus` and `deleteMessage` are real;
 * the snapshot machinery (`upsertSender`, `recordSnapshot`, `upsertSighting`,
 * `pairCfRevisions`) throws, and `rebuildSender` is a no-op returning zeros so
 * that callers can already be wired to it. Phase 1 fills them in.
 */
import { query, queryOne } from "@/lib/db";
import type { ExtractionOutcome } from "@/lib/extract/schema";
import { normalizePhone } from "@/lib/extract/phone";
import type { ContactMode, LoadStatus, StatusSource } from "@/lib/loads/types";

/** A sender silent for this many days has their derived jobs expired. */
export const SENDER_SILENCE_DAYS = 4;

/**
 * Two posts by the same sender inside this window are read as one list, not as
 * a list and a correction -- movers routinely finish a post in a second message.
 */
export const UNION_WINDOW_HOURS = 6;

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

export async function upsertSender(
  _key: string,
  _msg: RawMessageRow,
  _outcome: ExtractionOutcome,
): Promise<void> {
  throw new Error("upsertSender: not implemented until the lifecycle lands (Phase 1)");
}

export async function recordSnapshot(
  _key: string,
  _msg: RawMessageRow,
  _outcome: ExtractionOutcome,
  _jobKeys: string[],
  _originKeys: string[],
): Promise<{ id: number; kind: "full" | "partial" | "truncated" }> {
  throw new Error("recordSnapshot: not implemented until the lifecycle lands (Phase 1)");
}

export async function upsertSighting(
  _loadId: number,
  _snapshotId: number,
  _job: unknown,
  _sentAt: Date,
  _resolved: { ready_date: string | null; deliver_by: string | null },
): Promise<void> {
  throw new Error("upsertSighting: not implemented until the lifecycle lands (Phase 1)");
}

/** Greedy |Δcf| pairing of revised jobs; rewrites job_key and logs an 'edited' event. */
export async function pairCfRevisions(_key: string, _snapshotId: number): Promise<number> {
  return 0;
}

/**
 * Recompute one sender's derived statuses from their snapshots and sightings.
 *
 * Pure function of (snapshots, sightings, now) -- `now` is a parameter and is
 * bound as $now::timestamptz rather than being SQL `now()`, so the lifecycle
 * eval can replay two days of posts without mocking the database clock.
 *
 * PHASE 0a: no snapshots are written yet, so there is nothing to derive.
 */
export async function rebuildSender(
  _key: string,
  _now: Date = new Date(),
): Promise<{ available: number; delisted: number; expired: number }> {
  return { available: 0, delisted: 0, expired: 0 };
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

/**
 * Remove a message and the jobs that exist only because of it.
 *
 * `loads.source_message_id` is ON DELETE SET NULL, not CASCADE: a job that a
 * later post still sights must survive the deletion of the post that first
 * introduced it. So the jobs are collected first, and only those left with no
 * sighting at all are removed.
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
