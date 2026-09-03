/**
 * Message intake.
 *
 * Every message enters the system through this one function -- the WhatsApp
 * Cloud API webhook, the seeder, and the admin "paste a message" tool all call
 * it. That means the demo data and production traffic exercise exactly the same
 * code path, and swapping the intake source later (chat exports, a different
 * provider) touches only the caller.
 *
 * Intake is idempotent on wa_message_id: Meta retries webhook deliveries, and a
 * retry must not create a second copy of the load.
 */
import { query, queryOne } from "@/lib/db";

export interface IncomingMessage {
  /** Provider-side message id. Deduplicates redelivery. */
  waMessageId: string;
  body: string;
  sentAt: Date;
  authorName?: string | null;
  authorPhone?: string | null;
  /** Provider-side group/chat id. */
  groupWaId?: string | null;
  groupName?: string | null;
  payload?: unknown;
}

export interface IngestResult {
  messageId: number;
  duplicate: boolean;
}

export async function ingestMessage(msg: IncomingMessage): Promise<IngestResult> {
  const groupId = msg.groupWaId || msg.groupName ? await upsertGroup(msg) : null;

  const existing = await queryOne<{ id: number }>(
    `SELECT id FROM raw_messages WHERE wa_message_id = $1`,
    [msg.waMessageId],
  );
  if (existing) return { messageId: existing.id, duplicate: true };

  const row = await queryOne<{ id: number }>(
    `INSERT INTO raw_messages
       (group_id, wa_message_id, author_name, author_phone, body, sent_at, payload, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
     ON CONFLICT (wa_message_id) DO NOTHING
     RETURNING id`,
    [
      groupId,
      msg.waMessageId,
      msg.authorName ?? null,
      msg.authorPhone ?? null,
      msg.body,
      msg.sentAt.toISOString(),
      msg.payload ? JSON.stringify(msg.payload) : null,
    ],
  );

  if (!row) {
    // Lost a race with a concurrent delivery of the same message.
    const now = await queryOne<{ id: number }>(
      `SELECT id FROM raw_messages WHERE wa_message_id = $1`,
      [msg.waMessageId],
    );
    return { messageId: now!.id, duplicate: true };
  }

  return { messageId: row.id, duplicate: false };
}

async function upsertGroup(msg: IncomingMessage): Promise<number | null> {
  const waId = msg.groupWaId ?? `name:${msg.groupName}`;
  const name = msg.groupName ?? waId;
  await query(
    `INSERT INTO whatsapp_groups (wa_group_id, name)
     VALUES ($1, $2)
     ON CONFLICT (wa_group_id) DO NOTHING`,
    [waId, name],
  );
  const row = await queryOne<{ id: number }>(
    `SELECT id FROM whatsapp_groups WHERE wa_group_id = $1`,
    [waId],
  );
  return row?.id ?? null;
}
