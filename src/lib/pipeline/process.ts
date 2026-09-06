/**
 * The processing layer: raw WhatsApp message -> structured job rows.
 *
 *   raw_messages.pending
 *        -> extract        (deterministic rules, inventory-v1)
 *        -> geocode        (cache -> alias -> gazetteer -> optional provider)
 *        -> loads          (with freshness columns and expiry)
 *        -> rebuildSender  (supersession: the sender's latest post is the truth)
 *
 * Messages are claimed with a conditional UPDATE, so several workers (or a
 * webhook and a cron drain running at once) never process the same row twice.
 *
 * PHASE 0a: extraction runs through the adapter in src/lib/extract, the
 * snapshot tables are not written yet, and `rebuildSender` is a no-op -- so
 * every job is inserted with `seen_count = 1` and
 * `first_seen_at = last_seen_at = sent_at`. Phase 1 adds snapshots, sightings
 * and reconciliation on top of exactly these columns.
 */
import { query, queryOne } from "@/lib/db";
import { extractInventory, type ExtractedJob } from "@/lib/extract";
import { resolveDatePhrase } from "@/lib/extract/dates";
import { normalizePhone } from "@/lib/extract/phone";
import { geocode, type GeocodeResult } from "@/lib/geo/geocode";
import { haversineMiles } from "@/lib/geo/math";
import {
  rebuildSender,
  senderKeyFor,
  SENDER_SILENCE_DAYS,
  type ProcessResult,
  type RawMessageRow,
} from "./reconcile";

export type { ProcessResult, RawMessageRow } from "./reconcile";

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

export async function claimNext(): Promise<RawMessageRow | null> {
  const row = await queryOne<{ id: number }>(
    `UPDATE raw_messages
        SET status = 'processing', attempts = attempts + 1
      WHERE id = (
        SELECT id FROM raw_messages
         WHERE status = 'pending' AND attempts < 3
         ORDER BY id
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
 * Re-run one message, discarding the jobs the previous run created.
 *
 * The message keeps its own `sent_at`: reprocessing must not make a two-day-old
 * post look like it arrived just now.
 */
export async function reprocessMessage(id: number, opts?: { now?: Date }): Promise<ProcessResult> {
  await query(`DELETE FROM loads WHERE source_message_id = $1`, [id]);
  await query(
    `UPDATE raw_messages
        SET status = 'processing', attempts = 0, error = NULL, skip_reason = NULL,
            flags = '{}', attention = NULL
      WHERE id = $1`,
    [id],
  );
  const msg = await loadMessage(id);
  if (!msg) {
    return { messageId: id, status: "error", loadsCreated: 0, duplicates: 0, reason: "not found" };
  }
  return processMessage(msg, opts);
}

export async function processMessage(
  msg: RawMessageRow,
  opts?: { now?: Date },
): Promise<ProcessResult> {
  const sentAt = new Date(msg.sent_at);
  const now = opts?.now ?? new Date();
  const senderKey = senderKeyFor(msg);

  try {
    const outcome = extractInventory({
      body: msg.body,
      authorName: msg.author_name,
      authorPhone: msg.author_phone,
      groupName: msg.group_name,
      sentAt,
    });

    await query(
      `UPDATE raw_messages
          SET extractor = $1, extracted = $2, flags = $3::text[], attention = $4,
              parse_status = $5, format_signature = $6, sender_key = $7
        WHERE id = $8`,
      [
        outcome.extractor,
        JSON.stringify(outcome),
        outcome.flags,
        outcome.attention,
        outcome.parse_status,
        outcome.format_signature,
        senderKey,
        msg.id,
      ],
    );

    if (!outcome.is_load_post || outcome.loads.length === 0) {
      const reason = outcome.reason ?? "not_a_load";
      await finish(msg.id, "skipped", reason);
      return {
        messageId: msg.id,
        status: "skipped",
        loadsCreated: 0,
        duplicates: 0,
        reason,
        parse_status: outcome.parse_status,
        attention: outcome.attention,
      };
    }

    const requirements = outcome.requirements.length ? outcome.requirements.join("; ") : null;
    let created = 0;
    let lastSkip: string | null = null;

    for (const job of outcome.loads) {
      const inserted = await insertJob(msg, sentAt, job, {
        contactName: job.contact_name ?? outcome.contact.name,
        contactPhone: job.contact_phone ?? outcome.contact.phone,
        contactMode: outcome.contact.mode,
        requirements,
      });
      if (inserted === "no_geocode") {
        lastSkip = "no_geocode";
        continue;
      }
      created++;
    }

    if (created === 0) {
      const reason = lastSkip ?? "no_geocode";
      await finish(msg.id, "skipped", reason);
      return {
        messageId: msg.id,
        status: "skipped",
        loadsCreated: 0,
        duplicates: 0,
        reason,
        parse_status: outcome.parse_status,
        attention: outcome.attention,
      };
    }

    const rebuilt = await rebuildSender(senderKey, now);

    await finish(msg.id, "done", null);
    return {
      messageId: msg.id,
      status: "done",
      loadsCreated: created,
      duplicates: 0,
      parse_status: outcome.parse_status,
      attention: outcome.attention,
      rebuilt,
    };
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
}

async function insertJob(
  msg: RawMessageRow,
  sentAt: Date,
  e: ExtractedJob,
  contact: JobContact,
): Promise<"created" | "no_geocode"> {
  const pickup = await geocode(e.origin.address ?? e.pickup_location);
  const delivery = await geocodeDelivery(e);

  // A job whose origin cannot be placed on the map is not usable on a
  // geographic board -- it would be invisible to every state, radius and route
  // query, and the board is a map before it is a list.
  if (!pickup) return "no_geocode";

  const readyDate = resolveDatePhrase(e.ready_date_text, sentAt);
  const deliverBy = resolveDatePhrase(e.deliver_by_text, sentAt);
  const phone = normalizePhone(contact.contactPhone);

  const tripMiles = delivery
    ? haversineMiles({ lat: pickup.lat, lng: pickup.lng }, { lat: delivery.lat, lng: delivery.lng })
    : null;

  // Anything vague, unplaceable at the delivery end, or only known to state
  // level goes to review rather than sitting in results looking authoritative.
  const needsReview =
    e.confidence < 0.5 ||
    !delivery ||
    pickup.precision === "state" ||
    pickup.precision === "region";

  const rateUsd =
    e.price_flat ?? (e.price_per_cf != null && e.cubic_feet != null ? e.price_per_cf * e.cubic_feet : null);

  // Until snapshots land, a message's own send time is both the first and the
  // last sighting: seen once, right then.
  const seenAt = sentAt.toISOString();
  const expiresAt = new Date(sentAt.getTime() + SENDER_SILENCE_DAYS * 24 * 3600_000);

  const row = await queryOne<{ id: number }>(
    `INSERT INTO loads (
       source_message_id, group_id, status, status_source,
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
       first_seen_at, last_seen_at, seen_count,
       expires_at
     ) VALUES (
       $1,$2,'available','derived',
       $3,$4,$5,$6,$7,$8,$9,$10,
       $11,$12,$13,$14,$15,$16,$17,
       $18,
       $19,$20,$21,$22,
       $23,$24,$25,$26,$27,
       $28::text[],$29::text[],$30,$31,$32,
       $33,$34,$35,$36,
       $37,true,$38,$39,
       $40::timestamptz,$40::timestamptz,1,
       $41
     ) RETURNING id`,
    [
      msg.id, msg.group_id,
      e.pickup_location, e.origin.address, pickup.city, pickup.state, pickup.zip,
      pickup.lat, pickup.lng, pickup.precision,
      e.delivery_location,
      delivery?.city ?? e.dest_city, delivery?.state ?? e.dest_state, delivery?.zip ?? e.dest_zip,
      delivery?.lat ?? null, delivery?.lng ?? null, delivery?.precision ?? null,
      tripMiles,
      e.cubic_feet, e.price_per_cf, e.price_flat, rateUsd,
      e.ready_now, readyDate, e.ready_source, deliverBy, readyDate,
      e.tags, e.flags, e.notes, e.line_text || null, contact.requirements,
      contact.contactName, phone.e164 ?? phone.display, contact.contactPhone, contact.contactMode,
      e.ordinal, e.confidence, needsReview,
      seenAt,
      expiresAt,
    ],
  );

  await query(`INSERT INTO load_events (load_id, kind, detail) VALUES ($1, 'created', $2)`, [
    row!.id,
    JSON.stringify({ source: "whatsapp", message_id: msg.id, confidence: e.confidence }),
  ]);

  return "created";
}

/**
 * Place the destination. The batch posts give a state and usually a ZIP; the
 * free-text geocoder handles both, and Phase 1's `geocodeDestination` will add
 * the state-centroid fallback for a ZIP nobody recognises.
 */
async function geocodeDelivery(e: ExtractedJob): Promise<GeocodeResult | null> {
  const structured = [e.dest_city, e.dest_state, e.dest_zip].filter(Boolean).join(" ").trim();
  return geocode(structured || e.delivery_location);
}

/** Geocode a place string without touching the loads table. Used by search. */
export async function resolvePlace(text: string): Promise<GeocodeResult | null> {
  return geocode(text);
}
