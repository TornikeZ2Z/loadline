import { NextResponse } from "next/server";
import { badRequest, handler } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { ingestMessage } from "@/lib/pipeline/ingest";
import { reprocessMessage } from "@/lib/pipeline/process";
import { query } from "@/lib/db";

/**
 * Paste a WhatsApp message and watch it become a load.
 *
 * This is the pipeline's test harness, exposed in the admin UI: it goes through
 * the same ingest -> extract -> geocode -> dedup path as webhook traffic, so
 * what you see here is exactly what production would do with that text. Unlike
 * the webhook it runs synchronously, because seeing the result is the point.
 */
export const POST = handler(async (req: Request) => {
  await requireRole("admin");
  const body = (await req.json()) as {
    text?: string;
    author?: string;
    phone?: string;
    group?: string;
  };

  const text = (body.text ?? "").trim();
  if (!text) badRequest("Paste a message first");

  const { messageId } = await ingestMessage({
    waMessageId: `manual.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
    body: text,
    sentAt: new Date(),
    authorName: body.author || "Manual entry",
    authorPhone: body.phone || null,
    groupName: body.group || "Manual entry",
    groupWaId: body.group ? `name:${body.group}` : "manual",
    payload: { source: "admin" },
  });

  // reprocess rather than process: it resets state and clears any prior loads,
  // which makes re-submitting the same text idempotent.
  const result = await reprocessMessage(messageId);

  const loads = await query(
    `SELECT id, pickup_label, delivery_label, pickup_date::text AS pickup_date,
            contact_name, contact_phone, load_type, weight_lbs, pallets,
            confidence, needs_review, is_canonical, dup_group_id
       FROM loads WHERE source_message_id = $1 ORDER BY id`,
    [messageId],
  );

  const message = await query<{ extractor: string | null; extracted: unknown }>(
    `SELECT extractor, extracted FROM raw_messages WHERE id = $1`,
    [messageId],
  );

  return NextResponse.json({
    ...result,
    loads,
    extractor: message[0]?.extractor ?? null,
    extracted: message[0]?.extracted ?? null,
  });
});
