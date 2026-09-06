import { NextResponse } from "next/server";
import { badRequest, handler } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";
import { reprocessMessages } from "@/lib/pipeline/process";

/**
 * The explicit "Reprocess" button: re-run one message, every message still
 * carrying an attention code, a sender's recent messages, or every message
 * with a given format signature. Rule saves do NOT call this -- the rules
 * endpoint reprocesses on its own and reports the count.
 */
export const POST = handler(async (req: Request) => {
  await requireRole("admin");
  const sp = new URL(req.url).searchParams;
  const message = sp.get("message");
  const attention = sp.get("attention");
  const sender = sp.get("sender");
  const signature = sp.get("signature");
  const days = Math.min(Math.max(Number(sp.get("days") ?? 30) || 30, 1), 365);

  let ids: number[];
  if (message) {
    ids = [Number(message)].filter((n) => Number.isFinite(n));
  } else if (attention) {
    ids = (await query<{ id: number }>(
      attention === "any"
        ? `SELECT id FROM raw_messages WHERE attention IS NOT NULL ORDER BY sent_at, id`
        : `SELECT id FROM raw_messages WHERE attention = $1 ORDER BY sent_at, id`,
      attention === "any" ? [] : [attention],
    )).map((r) => r.id);
  } else if (sender) {
    ids = (await query<{ id: number }>(
      `SELECT id FROM raw_messages WHERE sender_key = $1 AND sent_at > now() - ($2 || ' days')::interval ORDER BY sent_at, id`,
      [sender, String(days)],
    )).map((r) => r.id);
  } else if (signature) {
    ids = (await query<{ id: number }>(`SELECT id FROM raw_messages WHERE format_signature = $1 ORDER BY sent_at, id`, [signature])).map((r) => r.id);
  } else {
    badRequest("Pass ?message=<id>, ?attention=<code|any>, ?sender=<key>[&days=30] or ?signature=<format_signature>");
  }

  const results = await reprocessMessages(ids);
  return NextResponse.json({ reprocessed: results.length, results });
});
