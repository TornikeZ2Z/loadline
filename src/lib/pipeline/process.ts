/**
 * The processing layer: raw WhatsApp message -> structured job rows.
 *
 *   raw_messages.pending
 *        -> extract        (deterministic rules, inventory-v1, with the sender's
 *                           learned rules and hints)
 *        -> format         (a never-seen layout lands in the admin queue once)
 *        -> geocode        (cache -> gazetteer -> HERE -> honest fallback)
 *        -> snapshot       (one per message with jobs: full / partial / truncated)
 *        -> loads          (insert-or-fetch per (sender_key, job_key); sightings)
 *        -> rebuildSender  (supersession: the sender's latest full post is the truth)
 *
 * Messages are claimed with a conditional UPDATE, so several workers (or a
 * webhook and a cron drain running at once) never process the same row twice.
 */
import { query, queryOne } from "@/lib/db";
import { extractInventory, scopedRules, type ExtractedJob, type ExtractionOutcome, type OriginRef } from "@/lib/extract";
import { resolveDatePhrase } from "@/lib/extract/dates";
import { destKeyOf, originKeyOf } from "@/lib/extract/inventory";
import { normalizePhone } from "@/lib/extract/phone";
import { geocode, geocodeDestinations, geocodeOrigin, type GeocodeResult } from "@/lib/geo/geocode";
import { haversineMiles } from "@/lib/geo/math";
import { closeIssuesFor, recordFormatSignature, recordIssues } from "./issues";
import {
  deleteOrphanLoads,
  pairCfRevisions,
  rebuildSender,
  recordSnapshot,
  senderKeyFor,
  upsertSender,
  upsertSighting,
  type ProcessResult,
  type RawMessageRow,
} from "./reconcile";
import { loadRuleSet } from "./rules";

export type { ProcessResult, RawMessageRow } from "./reconcile";

const HOUR = 3_600_000;

/** Claim and process up to `limit` pending messages. */
export async function processPending(
  limit = 25,
  opts?: { now?: Date },
): Promise<ProcessResult[]> {
  const results: ProcessResult[] = [];
  for (let i = 0; i < limit; i++) {
    const claimed = await claimNext();
    if (!claimed) break;
    results.push(await processMessage(claimed, opts));
  }
  return results;
}

/** A claim older than this with no outcome is assumed dead and re-offered. */
const CLAIM_TIMEOUT = "10 minutes";

/**
 * Claim the next message. `processed_at` doubles as the claim heartbeat: it is
 * stamped here and by reprocessMessage, so a run interrupted between the claim
 * and finish() (Ctrl-C on a drain, a restart) is re-offered instead of being
 * stranded in 'processing' forever, which is what the `attempts < 3` budget
 * was always for.
 */
export async function claimNext(): Promise<RawMessageRow | null> {
  const row = await queryOne<{ id: number }>(
    `UPDATE raw_messages
        SET status = 'processing', attempts = attempts + 1, processed_at = now()
      WHERE id = (
        SELECT id FROM raw_messages
         WHERE (status = 'pending'
                OR (status = 'processing'
                    AND (processed_at IS NULL
                         OR processed_at < now() - interval '${CLAIM_TIMEOUT}')))
           AND attempts < 3
         ORDER BY sent_at, id
         LIMIT 1
      )
      RETURNING id`,
  );
  if (!row) return null;
  return loadMessage(row.id);
}

async function loadMessage(id: number): Promise<RawMessageRow | null> {
  return queryOne<RawMessageRow>(
    `SELECT m.id, m.group_id, m.author_name, m.author_phone, m.body,
            m.sent_at::text AS sent_at, g.name AS group_name
       FROM raw_messages m
       LEFT JOIN whatsapp_groups g ON g.id = m.group_id
      WHERE m.id = $1`,
    [id],
  );
}

/**
 * Re-run one message (A §7.5): drop its snapshot and sightings, reset the row,
 * process it again at its own `sent_at`, rebuild the old and new senders, and
 * remove derived jobs nothing sights any more. Order-independent, idempotent.
 */
export async function reprocessMessage(id: number, opts?: { now?: Date }): Promise<ProcessResult> {
  const before = await queryOne<{ sender_key: string | null }>(`SELECT sender_key FROM raw_messages WHERE id = $1`, [id]);
  if (!before) {
    return { messageId: id, status: "error", loadsCreated: 0, duplicates: 0, reason: "not found" };
  }
  await query(`DELETE FROM sender_snapshots WHERE message_id = $1`, [id]);
  await query(
    // processed_at is re-stamped so this in-flight reprocess is not mistaken
    // for a dead claim by a concurrent drain (see claimNext).
    `UPDATE raw_messages
        SET status = 'processing', attempts = 0, error = NULL, skip_reason = NULL,
            flags = '{}', attention = NULL, processed_at = now()
      WHERE id = $1`,
    [id],
  );
  const msg = await loadMessage(id);
  if (!msg) {
    return { messageId: id, status: "error", loadsCreated: 0, duplicates: 0, reason: "not found" };
  }
  const result = await processMessage(msg, opts);
  const after = await queryOne<{ sender_key: string | null }>(`SELECT sender_key FROM raw_messages WHERE id = $1`, [id]);
  await deleteOrphanLoads([before.sender_key, after?.sender_key ?? null]);
  // Unconditionally, not only when the key changed: the snapshot was dropped at
  // the top, and every path that skips (not_a_load, no_geocode) or throws
  // returns before processMessage's own rebuild, which would otherwise leave
  // the sender's statuses computed against a snapshot that no longer exists.
  // rebuildSender is idempotent, so the extra call on the success path is free.
  if (before.sender_key) await rebuildSender(before.sender_key, opts?.now);
  if (after?.sender_key && after.sender_key !== before.sender_key) await rebuildSender(after.sender_key, opts?.now);
  return result;
}

/** Re-run several messages, oldest first. */
export async function reprocessMessages(ids: number[], opts?: { now?: Date }): Promise<ProcessResult[]> {
  const out: ProcessResult[] = [];
  for (const id of ids) out.push(await reprocessMessage(id, opts));
  return out;
}

interface SenderHintsRow {
  last_origin: OriginRef | null;
  default_origin: OriginRef | null;
  last_snapshot_at: string | null;
}

export async function processMessage(
  msg: RawMessageRow,
  opts?: { now?: Date },
): Promise<ProcessResult> {
  const sentAt = new Date(msg.sent_at);
  const now = opts?.now ?? new Date();
  const senderKey = senderKeyFor(msg);

  try {
    const allRules = await loadRuleSet();
    const rules = scopedRules(allRules, senderKey);
    const hints = await queryOne<SenderHintsRow>(
      `SELECT last_origin, default_origin, last_snapshot_at::text AS last_snapshot_at FROM senders WHERE key = $1`,
      [senderKey],
    );
    const recentOrigin =
      hints?.last_origin && hints.last_snapshot_at &&
      Math.abs(sentAt.getTime() - new Date(hints.last_snapshot_at).getTime()) < 24 * HOUR
        ? hints.last_origin
        : null;

    const outcome = extractInventory(
      {
        body: msg.body,
        authorName: msg.author_name,
        authorPhone: msg.author_phone,
        groupName: msg.group_name,
        sentAt,
        senderHints: {
          lastOrigin: recentOrigin,
          defaultOrigin: hints?.default_origin ?? allRules.senderFormats[senderKey]?.default_origin ?? null,
          format: allRules.senderFormats[senderKey] ?? null,
        },
      },
      rules,
    );

    // A parseable message in a layout never seen before enters the queue once.
    // A layout an admin taught with a line template is confirmed by that act.
    let attention = outcome.attention;
    let parseStatus = outcome.parse_status;
    if (outcome.loads.length) {
      const sig = await recordFormatSignature(outcome.format_signature, msg.id);
      const taught = outcome.lines.some((l) => l.flags.some((f) => f.startsWith("template:")));
      if (sig.status === "new" && taught) {
        await query(`UPDATE format_signatures SET status = 'known' WHERE signature = $1`, [outcome.format_signature]);
      } else if (sig.status === "new") {
        const higher = ["unknown_format", "no_origin", "origin_unresolved", "unknown_lines"];
        if (!attention || !higher.includes(attention)) attention = "new_format";
        if (parseStatus === "clean") parseStatus = "partial";
        if (!outcome.flags.includes("new_format")) outcome.flags.push("new_format");
      }
    }

    await query(
      `UPDATE raw_messages
          SET extractor = $1, extracted = $2, flags = $3::text[], attention = $4,
              parse_status = $5, format_signature = $6, sender_key = $7
        WHERE id = $8`,
      [
        outcome.extractor,
        JSON.stringify({ ...outcome, attention, parse_status: parseStatus }),
        outcome.flags,
        attention,
        parseStatus,
        outcome.format_signature,
        senderKey,
        msg.id,
      ],
    );

    if (!outcome.is_load_post || outcome.loads.length === 0) {
      const reason = outcome.reason ?? "not_a_load";
      await recordIssues(msg.id, senderKey, outcome);
      await finish(msg.id, "skipped", reason);
      return { messageId: msg.id, status: "skipped", loadsCreated: 0, duplicates: 0, reason, parse_status: parseStatus, attention };
    }

    // --- geocode: origins once per distinct header, destinations batched ---
    const originCache = new Map<string, { result: GeocodeResult | null; flags: string[] }>();
    const originFor = async (o: OriginRef) => {
      const k = `${o.line_no}|${o.raw_text}|${o.label}`;
      let g = originCache.get(k);
      if (!g) {
        g = await geocodeOrigin(o, o.state, rules);
        originCache.set(k, g);
      }
      return g;
    };
    const destinations = await geocodeDestinations(
      outcome.loads.map((j) => ({ state: j.dest_state, zip: j.dest_zip, city: j.dest_city })),
      rules,
    );

    const requirements = outcome.requirements.length ? outcome.requirements.join(" | ") : null;
    const contactName = outcome.contact.name;
    const phone = normalizePhone(outcome.contact.phone);
    const contactPhone = phone.e164 ?? phone.display;

    // --- keys, then the snapshot (needs every key) ---
    const prepared = await Promise.all(
      outcome.loads.map(async (job, i) => {
        const og = await originFor(job.origin);
        const pickupState = job.origin.state ?? og.result?.state ?? null;
        const pickupCity = job.origin.city ?? og.result?.city ?? null;
        const destState = job.dest_state ?? destinations[i]?.state ?? null;
        const originKey = originKeyOf(pickupState, pickupCity);
        const destKey = destKeyOf(destState, job.dest_zip, job.dest_city);
        const jobKey = `${originKey}>${destKey}@${job.cubic_feet ?? "null"}#${job.ordinal}`;
        return { job, og, dest: destinations[i], pickupState, pickupCity, destState, originKey, destKey, jobKey };
      }),
    );

    const placeable = prepared.filter((p) => p.pickupState || p.og.result);
    if (!placeable.length) {
      await recordIssues(msg.id, senderKey, outcome);
      await finish(msg.id, "skipped", "no_geocode");
      return { messageId: msg.id, status: "skipped", loadsCreated: 0, duplicates: 0, reason: "no_geocode", parse_status: parseStatus, attention };
    }

    await upsertSender(senderKey, msg, outcome);
    const snapshot = await recordSnapshot(
      senderKey,
      msg,
      outcome,
      prepared.map((p) => p.jobKey),
      prepared.map((p) => p.originKey),
    );

    let created = 0;
    let kept = 0;
    let revived = 0;
    for (const p of prepared) {
      const r = await upsertJob(msg, sentAt, senderKey, snapshot.id, p, { contactName, contactPhone, contactMode: outcome.contact.mode, requirements, rawPhone: outcome.contact.phone });
      if (r === "created") created++;
      else if (r === "revived") revived++;
      else kept++;
    }
    await query(
      `UPDATE sender_snapshots SET new_count = $2, kept_count = $3, revived_count = $4 WHERE id = $1`,
      [snapshot.id, created, kept, revived],
    );

    await pairCfRevisions(senderKey, snapshot.id);

    if (parseStatus === "clean") await closeIssuesFor(msg.id);
    else await recordIssues(msg.id, senderKey, outcome);

    const rebuilt = await rebuildSender(senderKey, now);

    await finish(msg.id, "done", null);
    return { messageId: msg.id, status: "done", loadsCreated: created, duplicates: 0, parse_status: parseStatus, attention, rebuilt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await query(
      `UPDATE raw_messages SET status = 'error', error = $1, processed_at = now() WHERE id = $2`,
      [message, msg.id],
    );
    return { messageId: msg.id, status: "error", loadsCreated: 0, duplicates: 0, reason: message };
  }
}

async function finish(id: number, status: "done" | "skipped", reason: string | null) {
  await query(
    `UPDATE raw_messages SET status = $1, skip_reason = $2, processed_at = now(), error = NULL
      WHERE id = $3`,
    [status, reason, id],
  );
}

interface JobContact {
  contactName: string | null;
  contactPhone: string | null;
  contactMode: "public" | "dm";
  requirements: string | null;
  rawPhone: string | null;
}

interface Prepared {
  job: ExtractedJob;
  og: { result: GeocodeResult | null; flags: string[] };
  dest: GeocodeResult | null;
  pickupState: string | null;
  pickupCity: string | null;
  destState: string | null;
  originKey: string;
  destKey: string;
  jobKey: string;
}

/**
 * Insert-or-fetch one job row per (sender_key, job_key), refresh its
 * descriptive columns from this sighting (the latest post is the truth), and
 * record the sighting.
 */
async function upsertJob(
  msg: RawMessageRow,
  sentAt: Date,
  senderKey: string,
  snapshotId: number,
  p: Prepared,
  contact: JobContact,
): Promise<"created" | "kept" | "revived"> {
  const { job: e, og, dest } = p;
  const pickup = og.result;
  const readyDate = resolveDatePhrase(e.ready_date_text, sentAt);
  const deliverBy = resolveDatePhrase(e.deliver_by_text, sentAt);

  const tripMiles = pickup && dest
    ? haversineMiles({ lat: pickup.lat, lng: pickup.lng }, { lat: dest.lat, lng: dest.lng })
    : null;

  const flags = [...new Set([...e.flags, ...og.flags])];
  const needsReview =
    flags.includes("needs_review") ||
    e.confidence < 0.5 ||
    !pickup ||
    !dest ||
    pickup.precision === "state" ||
    pickup.precision === "region" ||
    og.flags.includes("origin_unresolved");

  const rateUsd =
    e.price_flat ?? (e.price_per_cf != null && e.cubic_feet != null ? Math.round(e.price_per_cf * e.cubic_feet * 100) / 100 : null);

  const seenAt = sentAt.toISOString();
  const params = [
    /* $1 */ msg.id, /* $2 */ msg.group_id, /* $3 */ senderKey, /* $4 */ p.jobKey, /* $5 */ p.originKey, /* $6 */ p.destKey,
    /* $7 */ e.pickup_location, /* $8 */ e.origin.address, /* $9 */ p.pickupCity, /* $10 */ p.pickupState, /* $11 */ e.origin.zip ?? pickup?.zip ?? null,
    /* $12 */ pickup?.lat ?? null, /* $13 */ pickup?.lng ?? null, /* $14 */ pickup?.precision ?? null,
    /* $15 */ e.delivery_location, /* $16 */ dest?.city ?? e.dest_city, /* $17 */ p.destState, /* $18 */ e.dest_zip ?? dest?.zip ?? null,
    /* $19 */ dest?.lat ?? null, /* $20 */ dest?.lng ?? null, /* $21 */ dest?.precision ?? null,
    /* $22 */ tripMiles,
    /* $23 */ e.cubic_feet, /* $24 */ e.price_per_cf, /* $25 */ e.price_flat, /* $26 */ rateUsd,
    /* $27 */ e.ready_now, /* $28 */ readyDate, /* $29 */ e.ready_source, /* $30 */ deliverBy,
    /* $31 */ e.tags, /* $32 */ flags, /* $33 */ e.notes, /* $34 */ e.line_text || null, /* $35 */ contact.requirements,
    /* $36 */ contact.contactName, /* $37 */ contact.contactPhone, /* $38 */ contact.rawPhone, /* $39 */ contact.contactMode,
    /* $40 */ e.ordinal, /* $41 */ e.confidence, /* $42 */ needsReview,
    /* $43 */ seenAt,
  ];

  const inserted = await queryOne<{ id: number }>(
    `INSERT INTO loads (
       source_message_id, group_id, sender_key, job_key, origin_key, dest_key,
       status, status_source,
       pickup_label, pickup_address, pickup_city, pickup_state, pickup_zip,
       pickup_lat, pickup_lng, pickup_precision,
       delivery_label, delivery_city, delivery_state, delivery_zip,
       delivery_lat, delivery_lng, delivery_precision,
       trip_miles,
       cubic_feet, price_per_cf, price_flat, rate_usd,
       ready_now, ready_date, ready_source, deliver_by, pickup_date,
       tags, flags, job_notes, line_text, requirements,
       contact_name, contact_phone, contact_phone_raw, contact_mode,
       ordinal, is_canonical, confidence, needs_review,
       first_seen_at, last_seen_at, seen_count, snapshot_message_id
     ) VALUES (
       $1,$2,$3,$4,$5,$6,
       'available','derived',
       $7,$8,$9,$10,$11,$12,$13,$14,
       $15,$16,$17,$18,$19,$20,$21,
       $22,
       $23,$24,$25,$26,
       $27,$28::date,$29,$30::date,$28::date,
       $31::text[],$32::text[],$33,$34,$35,
       $36,$37,$38,$39,
       $40,true,$41,$42,
       $43::timestamptz,$43::timestamptz,1,$1
     )
     ON CONFLICT (sender_key, job_key) DO NOTHING
     RETURNING id`,
    params,
  );

  let loadId: number;
  let outcome: "created" | "kept" | "revived";
  if (inserted) {
    loadId = inserted.id;
    outcome = "created";
    await query(`INSERT INTO load_events (load_id, kind, detail) VALUES ($1, 'created', $2)`, [
      loadId,
      JSON.stringify({ source: "whatsapp", message_id: msg.id, confidence: e.confidence }),
    ]);
  } else {
    const existing = await queryOne<{ id: number; status: string; last_seen_at: string | null }>(
      `SELECT id, status, last_seen_at::text AS last_seen_at FROM loads WHERE sender_key = $1 AND job_key = $2`,
      [senderKey, p.jobKey],
    );
    if (!existing) throw new Error(`job ${p.jobKey} vanished between insert and fetch`);
    loadId = existing.id;
    outcome = existing.status === "delisted" || existing.status === "expired" ? "revived" : "kept";
    // The latest sighting is the truth for everything descriptive; when this
    // message is older than what the row already knows, keep the row.
    const newer = !existing.last_seen_at || new Date(existing.last_seen_at).getTime() <= sentAt.getTime();
    if (newer) {
      await query(
        `UPDATE loads SET
           pickup_label = $2, pickup_address = $3, pickup_city = $4, pickup_state = $5, pickup_zip = $6,
           pickup_lat = COALESCE($7::float8, pickup_lat), pickup_lng = COALESCE($8::float8, pickup_lng),
           pickup_precision = COALESCE($9, pickup_precision),
           delivery_label = $10, delivery_city = $11, delivery_state = $12, delivery_zip = $13,
           delivery_lat = COALESCE($14::float8, delivery_lat), delivery_lng = COALESCE($15::float8, delivery_lng),
           delivery_precision = COALESCE($16, delivery_precision),
           trip_miles = COALESCE($17::float8, trip_miles),
           price_per_cf = $18, price_flat = $19, rate_usd = $20,
           ready_now = $21, ready_date = $22::date, ready_source = $23, deliver_by = $24::date, pickup_date = $22::date,
           tags = $25::text[], flags = $26::text[], job_notes = $27, line_text = $28, requirements = $29,
           contact_name = $30, contact_phone = $31, contact_phone_raw = $32, contact_mode = $33,
           confidence = $34, needs_review = $35, group_id = COALESCE(group_id, $36::bigint), updated_at = now()
         WHERE id = $1`,
        [
          loadId,
          e.pickup_location, e.origin.address, p.pickupCity, p.pickupState, e.origin.zip ?? pickup?.zip ?? null,
          pickup?.lat ?? null, pickup?.lng ?? null, pickup?.precision ?? null,
          e.delivery_location, dest?.city ?? e.dest_city, p.destState, e.dest_zip ?? dest?.zip ?? null,
          dest?.lat ?? null, dest?.lng ?? null, dest?.precision ?? null,
          tripMiles,
          e.price_per_cf, e.price_flat, rateUsd,
          e.ready_now, readyDate, e.ready_source, deliverBy,
          e.tags, flags, e.notes, e.line_text || null, contact.requirements,
          contact.contactName, contact.contactPhone, contact.rawPhone, contact.contactMode,
          e.confidence, needsReview, msg.group_id,
        ],
      );
    }
    await query(`INSERT INTO load_events (load_id, kind, detail) VALUES ($1, 'sighted', $2)`, [
      loadId,
      JSON.stringify({ message_id: msg.id, snapshot_id: snapshotId }),
    ]);
  }

  await upsertSighting(loadId, snapshotId, e, sentAt, { ready_date: readyDate, deliver_by: deliverBy });
  return outcome;
}

/** Geocode a place string without touching the loads table. Used by search. */
export async function resolvePlace(text: string): Promise<GeocodeResult | null> {
  return geocode(text);
}

/** Read what the pipeline recorded for a message, for the admin routes. */
export async function recordedOutcome(messageId: number): Promise<ExtractionOutcome | null> {
  const row = await queryOne<{ extracted: ExtractionOutcome | null }>(`SELECT extracted FROM raw_messages WHERE id = $1`, [messageId]);
  return row?.extracted ?? null;
}
