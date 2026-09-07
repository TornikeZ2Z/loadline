import { NextResponse } from "next/server";
import { badRequest, handler, notFound } from "@/lib/api";
import { requireWriteRole } from "@/lib/auth";
import { queryOne } from "@/lib/db";
import { normalizePhone } from "@/lib/extract/phone";
import { rebuildSender } from "@/lib/pipeline/reconcile";

/**
 * Edit a sender: a fixed default origin for a dispatcher who never writes a
 * header, a merge into another sender, a display name, and the number their
 * posts never carried. Sender keys contain ":" and "+"
 * ("phone:+17865550128"), so the console URL-encodes the key and this route
 * decodes it (a raw "+" in a path is a space to some clients).
 *
 * `author_phone` is the reachability escape hatch. In production the WhatsApp
 * Cloud API webhook always carries the sender's WA id, so a sender with no
 * number is a paste/import artefact -- and one that leaves every job of theirs
 * unreachable. Attaching a number here fixes all of them at once: the
 * `rebuildSender` below copies it onto every row of theirs that has none, and
 * because the sender row keeps it (`upsertSender` COALESCEs rather than
 * overwrites), it stays fixed through later posts and reprocesses.
 */
export const PATCH = handler(async (req: Request, ctx: { params: Promise<{ key: string }> }) => {
  await requireWriteRole("admin");
  const { key: raw } = await ctx.params;
  const key = decodeURIComponent(raw);
  const body = (await req.json()) as {
    default_origin?: unknown;
    merged_into?: string | null;
    display_name?: string;
    author_phone?: string | null;
  };

  const existing = await queryOne<{ key: string }>(`SELECT key FROM senders WHERE key = $1`, [key]);
  if (!existing) notFound("Sender not found");

  if (body.merged_into) {
    const target = await queryOne<{ key: string }>(`SELECT key FROM senders WHERE key = $1`, [body.merged_into]);
    if (!target) badRequest("merged_into must be an existing sender key");
    if (body.merged_into === key) badRequest("a sender cannot be merged into itself");
  }

  // Stored in E.164 like every other number, so `knownSenderPhone` and the
  // reveal see exactly what the extractor would have produced. A half-typed
  // number is rejected rather than stored: a job that dials nowhere is worse
  // than one that admits it has no number.
  let authorPhone: string | null = null;
  const setPhone = "author_phone" in body;
  if (setPhone) {
    const input = (body.author_phone ?? "").trim();
    if (input) {
      const e164 = normalizePhone(input).e164;
      if (!e164) badRequest("Enter a full phone number with its area code, or leave it empty to detach.");
      authorPhone = e164;
    }
  }

  const sender = await queryOne(
    `UPDATE senders SET
       default_origin = CASE WHEN $2 THEN $3::jsonb ELSE default_origin END,
       merged_into    = CASE WHEN $4 THEN $5 ELSE merged_into END,
       display_name   = COALESCE($6, display_name),
       author_phone   = CASE WHEN $7 THEN $8 ELSE author_phone END,
       updated_at     = now()
     WHERE key = $1
     RETURNING key, display_name, author_phone, contact_names, contact_phones, contact_mode, group_ids,
               default_origin, last_origin, merged_into, first_snapshot_at::text AS first_snapshot_at,
               last_snapshot_at::text AS last_snapshot_at, last_full_at::text AS last_full_at, snapshot_count`,
    [
      key,
      "default_origin" in body,
      body.default_origin == null ? null : JSON.stringify(body.default_origin),
      "merged_into" in body,
      body.merged_into ?? null,
      body.display_name?.trim() || null,
      setPhone,
      authorPhone,
    ],
  );

  const rebuilt = await rebuildSender(key);
  return NextResponse.json({ sender, rebuilt });
});
