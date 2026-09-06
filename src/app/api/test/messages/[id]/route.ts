import { NextResponse } from "next/server";
import { badRequest, handler, notFound } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { query, queryOne } from "@/lib/db";
import { getMessage, listGroups, listMessages, loadsForMessage } from "@/lib/demo/chats";
import { deleteMessage } from "@/lib/pipeline/reconcile";
import { reprocessMessage } from "@/lib/pipeline/process";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * The WhatsApp console's message inspector. Admin only: these payloads carry
 * `contact_phone` and the unmasked body, which is exactly what the console is
 * for and exactly why no public route may proxy it.
 *
 * Every read goes through A's `getMessage`, never a SELECT written here: the
 * console needs `group_name`, `flags`, `attention`, `parse_status`,
 * `format_signature`, `sender_key` and the snapshot kind, and the last one
 * needs a join this file has no business owning.
 */
export const GET = handler(async (_req: Request, ctx: Ctx) => {
  await requireRole("admin");
  const { id } = await ctx.params;

  const message = await getMessage(Number(id));
  if (!message) notFound("Message not found");

  const loads = await loadsForMessage(Number(id));

  // The per-line audit, each line carrying the job it produced. That link is
  // what lets the console paint a gutter beside the message and highlight the
  // line a job came from.
  const lines = (message.extracted?.lines ?? []).map((l) => ({
    ...l,
    job_id: loads.find((x) => x.line_no === l.n)?.id ?? null,
  }));

  return NextResponse.json({ message, loads, lines });
});

/**
 * Edit a message and immediately re-run the pipeline over it.
 *
 * This is the loop the console exists for: change the wording, watch the
 * extracted job change. Editing the raw message and re-deriving is safe because
 * jobs are derived data -- `reprocessMessage` discards the previous ones first,
 * so there is no way to accumulate stale duplicates.
 */
export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  await requireRole("admin");
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

/**
 * Remove a message. A's `deleteMessage` decides what goes with it: a job a
 * later post still sights survives, and the sender is rebuilt afterwards so the
 * remaining jobs settle into the right statuses.
 */
export const DELETE = handler(async (_req: Request, ctx: Ctx) => {
  await requireRole("admin");
  const { id } = await ctx.params;

  const existing = await queryOne<{ group_id: number | null }>(
    `SELECT group_id FROM raw_messages WHERE id = $1`,
    [id],
  );
  if (!existing) notFound("Message not found");

  await deleteMessage(Number(id));
  const [messages, groups] = await Promise.all([listMessages(existing.group_id), listGroups()]);

  return NextResponse.json({ ok: true, messages, groups });
});
