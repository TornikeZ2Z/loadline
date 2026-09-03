/**
 * Queries behind the WhatsApp test console.
 *
 * The console shows the corpus as it would look in WhatsApp, next to what the
 * pipeline made of it. That pairing is the point: it makes extraction legible
 * to someone who is evaluating the product rather than reading the code.
 */
import { query } from "@/lib/db";

export interface ChatGroup {
  id: number;
  name: string;
  description: string | null;
  message_count: number;
  load_count: number;
  skipped_count: number;
}

export interface ChatMessage {
  id: number;
  body: string;
  author_name: string | null;
  author_phone: string | null;
  sent_at: string;
  status: string;
  skip_reason: string | null;
  error: string | null;
  extractor: string | null;
  group_id: number | null;
  group_name: string | null;
  load_count: number;
}

export interface ChatLoad {
  id: number;
  pickup_label: string;
  delivery_label: string;
  pickup_date: string | null;
  pickup_time: string | null;
  delivery_date: string | null;
  load_type: string | null;
  weight_lbs: number | null;
  pallets: number | null;
  pieces: number | null;
  rate_usd: number | null;
  contact_name: string | null;
  contact_phone: string | null;
  trip_miles: number | null;
  pickup_precision: string | null;
  delivery_precision: string | null;
  confidence: number;
  needs_review: boolean;
  is_canonical: boolean;
  dup_group_id: string | null;
  status: string;
}

export async function listGroups(): Promise<ChatGroup[]> {
  return query<ChatGroup>(
    `SELECT g.id, g.name, g.description,
            (SELECT count(*) FROM raw_messages m WHERE m.group_id = g.id)::int AS message_count,
            (SELECT count(*) FROM loads l WHERE l.group_id = g.id)::int AS load_count,
            (SELECT count(*) FROM raw_messages m
              WHERE m.group_id = g.id AND m.status = 'skipped')::int AS skipped_count
       FROM whatsapp_groups g
      ORDER BY message_count DESC, g.name`,
  );
}

export async function listMessages(groupId: number | null): Promise<ChatMessage[]> {
  return query<ChatMessage>(
    `SELECT m.id, m.body, m.author_name, m.author_phone,
            m.sent_at::text AS sent_at, m.status, m.skip_reason, m.error, m.extractor,
            m.group_id, g.name AS group_name,
            (SELECT count(*) FROM loads l WHERE l.source_message_id = m.id)::int AS load_count
       FROM raw_messages m
       LEFT JOIN whatsapp_groups g ON g.id = m.group_id
      WHERE ($1::bigint IS NULL OR m.group_id = $1)
      ORDER BY m.sent_at ASC, m.id ASC`,
    [groupId],
  );
}

/** Loads derived from one message -- what the pipeline made of that text. */
export async function loadsForMessage(messageId: number): Promise<ChatLoad[]> {
  return query<ChatLoad>(
    `SELECT id, pickup_label, delivery_label,
            pickup_date::text AS pickup_date, pickup_time::text AS pickup_time,
            delivery_date::text AS delivery_date,
            load_type, weight_lbs, pallets, pieces, rate_usd,
            contact_name, contact_phone, trip_miles,
            pickup_precision, delivery_precision,
            confidence, needs_review, is_canonical, dup_group_id, status
       FROM loads WHERE source_message_id = $1 ORDER BY id`,
    [messageId],
  );
}
