import { NextResponse } from "next/server";
import { handler, notFound } from "@/lib/api";
import { requireWriteRole } from "@/lib/auth";
import { queryOne } from "@/lib/db";
import type { ExtractionOutcome } from "@/lib/extract";

/**
 * "Accept extraction": freeze what the pipeline (or the admin) says this
 * message means as a pattern case. `npm run rules:export` writes accepted
 * cases into scripts/fixtures/learned/, and `npm run eval` replays them, so
 * a format solved once can never silently regress.
 */
export const POST = handler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireWriteRole("admin");
  const { id } = await ctx.params;
  const messageId = Number(id);
  const body = (await req.json().catch(() => ({}))) as { expected?: unknown[] };

  const msg = await queryOne<{
    body: string; author_name: string | null; author_phone: string | null; sent_at: string; extracted: ExtractionOutcome | null;
  }>(
    `SELECT body, author_name, author_phone, sent_at::text AS sent_at, extracted FROM raw_messages WHERE id = $1`,
    [messageId],
  );
  if (!msg) notFound("Message not found");

  const expected =
    Array.isArray(body.expected) && body.expected.length
      ? body.expected
      : (msg.extracted?.loads ?? []).map((l) => ({
          origin: l.pickup_location,
          dest: l.delivery_location,
          cf: l.cubic_feet,
          pricePerCf: l.price_per_cf,
          priceFlat: l.price_flat,
          ready: l.ready_now,
          readySource: l.ready_source,
          tags: l.tags,
        }));

  const row = await queryOne<{ id: number }>(
    `INSERT INTO pattern_cases (message_id, body, author, author_phone, sent_at, expected, status)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6::jsonb, 'accepted')
     RETURNING id`,
    [messageId, msg.body, msg.author_name, msg.author_phone, new Date(msg.sent_at).toISOString(), JSON.stringify(expected)],
  );

  return NextResponse.json({ patternCaseId: row!.id });
});
