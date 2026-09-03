import { NextResponse } from "next/server";
import { badRequest, handler, notFound } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { query, queryOne } from "@/lib/db";
import { listGroups, listMessages, loadsForMessage } from "@/lib/demo/chats";
import { reprocessMessage } from "@/lib/pipeline/process";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** One message plus whatever the pipeline made of it. */
export const GET = handler(async (_req: Request, ctx: Ctx) => {
  await requireUser();
  const { id } = await ctx.params;

  const message = await queryOne(
    `SELECT m.id, m.body, m.author_name, m.author_phone, m.sent_at::text AS sent_at,
            m.status, m.skip_reason, m.error, m.extractor, m.extracted, m.group_id
       FROM raw_messages m WHERE m.id = $1`,
    [id],
  );
  if (!message) notFound("Message not found");

  return NextResponse.json({ message, loads: await loadsForMessage(Number(id)) });
});

/**
 * Edit a message and immediately re-run the pipeline over it.
 *
 * This is the loop the test console exists for: change the wording, watch the
 * extracted load change. Editing the raw message and re-deriving is safe
 * because loads are derived data -- `reprocessMessage` discards the previous
 * ones first, so there is no way to accumulate stale duplicates.
 */
export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  await requireUser();
  const { id } = await ctx.params;
  const body = (await req.json()) as {
    text?: string;
    author?: string;
    phone?: string;
    sentAt?: string;
  };

  const existing = await queryOne<{ id: number; group_id: number | null }>(
    `SELECT id, group_id FROM raw_messages WHERE id = $1`,
    [id],
  );
  if (!existing) notFound("Message not found");

  const text = (body.text ?? "").trim();
  if (!text) badRequest("Message text cannot be empty");

  const sentAt = body.sentAt ? new Date(body.sentAt) : null;
  if (sentAt && Number.isNaN(sentAt.getTime())) badRequest("sentAt is not a valid date");

  await query(
    `UPDATE raw_messages
        SET body = $1,
            author_name = COALESCE($2, author_name),
            author_phone = COALESCE($3, author_phone),
            sent_at = COALESCE($4::timestamptz, sent_at)
      WHERE id = $5`,
    [text, body.author?.trim() || null, body.phone?.trim() || null, sentAt?.toISOString() ?? null, id],
  );

  const result = await reprocessMessage(Number(id));
  const [loads, messages, groups] = await Promise.all([
    loadsForMessage(Number(id)),
    listMessages(existing.group_id),
    listGroups(),
  ]);

  return NextResponse.json({ result, loads, messages, groups });
});

/** Remove a message and the loads derived from it (they cascade). */
export const DELETE = handler(async (_req: Request, ctx: Ctx) => {
  await requireUser();
  const { id } = await ctx.params;

  const existing = await queryOne<{ group_id: number | null }>(
    `SELECT group_id FROM raw_messages WHERE id = $1`,
    [id],
  );
  if (!existing) notFound("Message not found");

  await query(`DELETE FROM raw_messages WHERE id = $1`, [id]);
  const [messages, groups] = await Promise.all([listMessages(existing.group_id), listGroups()]);

  return NextResponse.json({ ok: true, messages, groups });
});
