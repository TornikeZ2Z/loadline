/**
 * Queries behind the WhatsApp test console and the admin queue.
 *
 * The console shows the corpus as it would look in WhatsApp, next to what the
 * pipeline made of it. That pairing is the point: it makes extraction legible
 * to someone who is evaluating the product rather than reading the code.
 *
 * These payloads are admin-only and therefore carry phones. No public route
 * proxies them.
 */
import { query, queryOne } from "@/lib/db";
import type { ExtractionOutcome } from "@/lib/extract/schema";
import { pageLimit } from "@/lib/loads/query";

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
  flags: string[];
  attention: string | null;
  parse_status: string | null;
  format_signature: string | null;
  sender_key: string | null;
  snapshot_kind: "full" | "partial" | "truncated" | null;
}

export interface ChatLoad {
  id: number;
  status: string;
  pickup_label: string;
  pickup_state: string | null;
  delivery_label: string;
  delivery_state: string | null;
  delivery_zip: string | null;
  cubic_feet: number | null;
  price_per_cf: number | null;
  price_flat: number | null;
  rate_usd: number | null;
  ready_now: boolean;
  ready_date: string | null;
  ready_source: string | null;
  deliver_by: string | null;
  tags: string[];
  flags: string[];
  job_notes: string | null;
  /** From load_sightings for this message; null for website and legacy rows. */
  line_no: number | null;
  line_text: string | null;
  contact_name: string | null;
  /** Admin-only payloads; never proxied by a public route. */
  contact_phone: string | null;
  contact_mode: string;
  trip_miles: number | null;
  pickup_precision: string | null;
  delivery_precision: string | null;
  confidence: number;
  needs_review: boolean;
  first_seen_at: string | null;
  last_seen_at: string | null;
  seen_count: number;
}

/**
 * Jobs sighted by a message, falling back to the rows the message originally
 * created. The fallback covers website posts, legacy rows, and -- until the
 * snapshot pipeline lands -- everything.
 */
const SIGHTING_COUNT = `(
  SELECT count(*) FROM load_sightings s
    JOIN sender_snapshots sn ON sn.id = s.snapshot_id
   WHERE sn.message_id = m.id
)`;

const SOURCE_COUNT = `(SELECT count(*) FROM loads l WHERE l.source_message_id = m.id)`;

const MESSAGE_COLUMNS = `
  m.id, m.body, m.author_name, m.author_phone,
  m.sent_at::text AS sent_at, m.status, m.skip_reason, m.error, m.extractor,
  m.group_id, g.name AS group_name,
  coalesce(m.flags, '{}') AS flags,
  m.attention, m.parse_status, m.format_signature, m.sender_key,
  sn.kind AS snapshot_kind,
  coalesce(nullif(${SIGHTING_COUNT}, 0), ${SOURCE_COUNT})::int AS load_count`;

const MESSAGE_FROM = `
  FROM raw_messages m
  LEFT JOIN whatsapp_groups g ON g.id = m.group_id
  LEFT JOIN sender_snapshots sn ON sn.message_id = m.id`;

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
    `SELECT ${MESSAGE_COLUMNS}
       ${MESSAGE_FROM}
      WHERE ($1::bigint IS NULL OR m.group_id = $1)
      ORDER BY m.sent_at ASC, m.id ASC`,
    [groupId],
  );
}

/** One message, with the extraction outcome the pipeline recorded for it. */
export async function getMessage(
  id: number,
): Promise<(ChatMessage & { extracted: ExtractionOutcome | null }) | null> {
  return queryOne<ChatMessage & { extracted: ExtractionOutcome | null }>(
    `SELECT ${MESSAGE_COLUMNS}, m.extracted
       ${MESSAGE_FROM}
      WHERE m.id = $1`,
    [id],
  );
}

const LOAD_COLUMNS = `
  l.id, l.status,
  l.pickup_label, l.pickup_state,
  l.delivery_label, l.delivery_state, l.delivery_zip,
  l.cubic_feet, l.price_per_cf, l.price_flat, l.rate_usd,
  l.ready_now, l.ready_date::text AS ready_date, l.ready_source,
  l.deliver_by::text AS deliver_by,
  coalesce(l.tags, '{}') AS tags,
  coalesce(l.flags, '{}') AS flags,
  l.job_notes, l.line_text,
  l.contact_name, l.contact_phone, l.contact_mode,
  l.trip_miles, l.pickup_precision, l.delivery_precision,
  l.confidence, l.needs_review,
  l.first_seen_at::text AS first_seen_at,
  l.last_seen_at::text  AS last_seen_at,
  l.seen_count`;

/**
 * Jobs this message is evidence for -- what the pipeline made of that text.
 *
 * The jobs SIGHTED by the message, in line order: a repost sights jobs it did
 * not create, and those belong in this list. Website and legacy rows have no
 * sightings, so the `source_message_id` fallback covers them.
 */
export async function loadsForMessage(messageId: number): Promise<ChatLoad[]> {
  const sighted = await query<ChatLoad>(
    `SELECT ${LOAD_COLUMNS}, s.line_no
       FROM load_sightings s
       JOIN sender_snapshots sn ON sn.id = s.snapshot_id
       JOIN loads l ON l.id = s.load_id
      WHERE sn.message_id = $1
      ORDER BY s.line_no NULLS LAST, l.id`,
    [messageId],
  );
  if (sighted.length) return sighted;
  return query<ChatLoad>(
    `SELECT ${LOAD_COLUMNS}, NULL::int AS line_no
       FROM loads l
      WHERE l.source_message_id = $1
      ORDER BY l.id`,
    [messageId],
  );
}

export interface MessageFilters {
  status?: string | null;
  /** An attention code, or "any" for every message that needs attention. */
  attention?: string | null;
  flag?: string | null;
  sender?: string | null;
  group?: number | null;
  limit?: number;
}

/** The admin queue: every row is a true ChatMessage plus processing metadata. */
export async function queryMessages(f: MessageFilters): Promise<Array<ChatMessage & { processed_at: string | null; attempts: number }>> {
  // Same rounding the board's pages use: clamping alone leaves `?limit=1.5`
  // intact, and a non-integer bound to a bigint LIMIT is a 500.
  const limit = pageLimit(f.limit, 200);
  return query<ChatMessage & { processed_at: string | null; attempts: number }>(
    `SELECT ${MESSAGE_COLUMNS}, m.processed_at::text AS processed_at, m.attempts
       ${MESSAGE_FROM}
      WHERE ($1::text IS NULL OR m.status = $1)
        AND ($2::text IS NULL OR ($2 = 'any' AND m.attention IS NOT NULL) OR m.attention = $2)
        AND ($3::text IS NULL OR $3 = ANY(coalesce(m.flags, '{}')))
        AND ($4::text IS NULL OR m.sender_key = $4)
        AND ($5::bigint IS NULL OR m.group_id = $5)
      ORDER BY m.sent_at DESC, m.id DESC
      LIMIT $6`,
    [f.status || null, f.attention || null, f.flag || null, f.sender || null, f.group ?? null, limit],
  );
}
