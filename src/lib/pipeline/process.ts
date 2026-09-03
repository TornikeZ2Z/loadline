/**
 * The processing layer: raw WhatsApp message -> structured load rows.
 *
 *   raw_messages.pending
 *        -> extract        (deterministic rules: spans, then place lookup)
 *        -> normalize      (informal place names, relative dates, phones)
 *        -> geocode        (cache -> alias -> gazetteer -> optional provider)
 *        -> dedup          (cluster reposts, keep one canonical row)
 *        -> loads          (with expiry and cached trip distance)
 *
 * Messages are claimed with a conditional UPDATE, so several workers (or a
 * webhook and a cron drain running at once) never process the same row twice.
 */
import { query, queryOne } from "@/lib/db";
import { geocode, type GeocodeResult } from "@/lib/geo/geocode";
import { haversineMiles } from "@/lib/geo/math";
import { extractLoads, type ExtractedLoad } from "@/lib/extract";
import { computeExpiry, resolveDatePhrase, resolveTimePhrase } from "@/lib/extract/dates";
import { normalizePhone } from "@/lib/extract/phone";
import { findDuplicate, linkDuplicate } from "./dedup";

export interface ProcessResult {
  messageId: number;
  status: "done" | "skipped" | "error";
  loadsCreated: number;
  duplicates: number;
  reason?: string;
}

interface RawMessageRow {
  id: number;
  group_id: number | null;
  author_name: string | null;
  author_phone: string | null;
  body: string;
  sent_at: string;
  group_name: string | null;
}

/** Claim and process up to `limit` pending messages. */
export async function processPending(limit = 25): Promise<ProcessResult[]> {
  const results: ProcessResult[] = [];
  for (let i = 0; i < limit; i++) {
    const claimed = await claimNext();
    if (!claimed) break;
    results.push(await processMessage(claimed));
  }
  return results;
}

async function claimNext(): Promise<RawMessageRow | null> {
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

/** Re-run one message through the pipeline, discarding loads from a prior run. */
export async function reprocessMessage(id: number): Promise<ProcessResult> {
  await query(`DELETE FROM loads WHERE source_message_id = $1`, [id]);
  await query(
    `UPDATE raw_messages SET status = 'processing', attempts = 0, error = NULL, skip_reason = NULL
      WHERE id = $1`,
    [id],
  );
  const msg = await loadMessage(id);
  if (!msg) return { messageId: id, status: "error", loadsCreated: 0, duplicates: 0, reason: "not found" };
  return processMessage(msg);
}

export async function processMessage(msg: RawMessageRow): Promise<ProcessResult> {
  const sentAt = new Date(msg.sent_at);
  try {
    const outcome = extractLoads({
      body: msg.body,
      authorName: msg.author_name,
      authorPhone: msg.author_phone,
      groupName: msg.group_name,
      sentAt,
    });

    await query(`UPDATE raw_messages SET extractor = $1, extracted = $2 WHERE id = $3`, [
      outcome.extractor,
      JSON.stringify(outcome),
      msg.id,
    ]);

    if (!outcome.is_load_post || outcome.loads.length === 0) {
      await finish(msg.id, "skipped", outcome.reason ?? "not_a_load");
      return {
        messageId: msg.id,
        status: "skipped",
        loadsCreated: 0,
        duplicates: 0,
        reason: outcome.reason ?? "not_a_load",
      };
    }

    let created = 0;
    let duplicates = 0;
    let lastSkip: string | null = null;

    for (const extracted of outcome.loads) {
      const inserted = await insertLoad(msg, sentAt, extracted);
      if (inserted === "no_geocode") {
        lastSkip = "no_geocode";
        continue;
      }
      created++;
      if (inserted === "duplicate") duplicates++;
    }

    if (created === 0) {
      await finish(msg.id, "skipped", lastSkip ?? "no_usable_load");
      return { messageId: msg.id, status: "skipped", loadsCreated: 0, duplicates: 0, reason: lastSkip ?? "no_usable_load" };
    }

    await finish(msg.id, "done", null);
    return { messageId: msg.id, status: "done", loadsCreated: created, duplicates };
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

async function insertLoad(
  msg: RawMessageRow,
  sentAt: Date,
  e: ExtractedLoad,
): Promise<"created" | "duplicate" | "no_geocode"> {
  const pickup = await geocode(e.pickup_address ?? e.pickup_location);
  const delivery = await geocode(e.delivery_address ?? e.delivery_location);

  // A load whose origin cannot be placed on the map is not usable on a
  // geographic board -- it would be invisible to every radius and route query.
  if (!pickup) return "no_geocode";

  const pickupDate = resolveDatePhrase(e.pickup_date_text, sentAt) ?? e.pickup_date_iso ?? null;
  const deliveryDate = resolveDatePhrase(e.delivery_date_text, sentAt) ?? null;
  const { time, note } = resolveTimePhrase(e.pickup_time_text);
  const phone = normalizePhone(e.contact_phone);

  const tripMiles =
    delivery && pickup
      ? haversineMiles({ lat: pickup.lat, lng: pickup.lng }, { lat: delivery.lat, lng: delivery.lng })
      : null;

  // Anything vague, undated, or only placeable at state level goes to review
  // rather than silently sitting in search results looking authoritative.
  const needsReview =
    e.confidence < 0.5 ||
    !pickupDate ||
    !delivery ||
    pickup.precision === "state" ||
    pickup.precision === "region";

  const candidate = {
    pickup_city: pickup.city,
    pickup_state: pickup.state,
    pickup_zip: pickup.zip,
    delivery_city: delivery?.city ?? null,
    delivery_state: delivery?.state ?? null,
    delivery_zip: delivery?.zip ?? null,
    pickup_date: pickupDate,
    contact_phone: phone.e164 ?? phone.display,
    contact_name: e.contact_name,
    weight_lbs: e.weight_lbs,
    pallets: e.pallets,
    group_id: msg.group_id,
    confidence: e.confidence,
  };

  const dup = await findDuplicate(candidate);

  const row = await queryOne<{ id: number }>(
    `INSERT INTO loads (
       source_message_id, group_id, status,
       pickup_label, pickup_address, pickup_city, pickup_state, pickup_zip,
       pickup_lat, pickup_lng, pickup_precision,
       delivery_label, delivery_address, delivery_city, delivery_state, delivery_zip,
       delivery_lat, delivery_lng, delivery_precision,
       trip_miles, pickup_date, pickup_time, pickup_time_note, delivery_date,
       load_type, weight_lbs, pallets, pieces, rate_usd,
       contact_name, contact_phone, contact_phone_raw, notes,
       confidence, needs_review, expires_at
     ) VALUES (
       $1,$2,'available',
       $3,$4,$5,$6,$7,$8,$9,$10,
       $11,$12,$13,$14,$15,$16,$17,$18,
       $19,$20,$21,$22,$23,
       $24,$25,$26,$27,$28,
       $29,$30,$31,$32,
       $33,$34,$35
     ) RETURNING id`,
    [
      msg.id, msg.group_id,
      pickup.label, e.pickup_address, pickup.city, pickup.state, pickup.zip,
      pickup.lat, pickup.lng, pickup.precision,
      delivery?.label ?? e.delivery_location, e.delivery_address,
      delivery?.city ?? null, delivery?.state ?? null, delivery?.zip ?? null,
      delivery?.lat ?? null, delivery?.lng ?? null, delivery?.precision ?? null,
      tripMiles, pickupDate, time, note, deliveryDate,
      e.load_type, e.weight_lbs, e.pallets, e.pieces, e.rate_usd,
      e.contact_name, phone.e164 ?? phone.display, e.contact_phone, e.notes,
      e.confidence, needsReview, computeExpiry(pickupDate, sentAt),
    ],
  );

  const loadId = row!.id;
  await query(`INSERT INTO load_events (load_id, kind, detail) VALUES ($1, 'created', $2)`, [
    loadId,
    JSON.stringify({ source: "whatsapp", message_id: msg.id, confidence: e.confidence }),
  ]);

  if (dup) {
    await linkDuplicate(loadId, dup);
    return "duplicate";
  }
  return "created";
}

/** Geocode a place string without touching the loads table. Used by search. */
export async function resolvePlace(text: string): Promise<GeocodeResult | null> {
  return geocode(text);
}
