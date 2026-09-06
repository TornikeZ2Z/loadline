import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { queryMessages } from "@/lib/demo/chats";

/**
 * The raw message feed with its processing outcome -- and, with
 * `?attention=<code|any>`, the admin "Needs attention" queue. Every row is a
 * true ChatMessage (group_id, flags, attention, parse_status,
 * format_signature, sender_key, snapshot_kind) plus processed_at/attempts.
 * Admin-only: rows carry phones.
 */
export const GET = handler(async (req: Request) => {
  await requireRole("admin");
  const sp = new URL(req.url).searchParams;
  const group = sp.get("group");
  const messages = await queryMessages({
    status: sp.get("status"),
    attention: sp.get("attention"),
    flag: sp.get("flag"),
    sender: sp.get("sender"),
    group: group ? Number(group) || null : null,
    limit: Number(sp.get("limit") ?? 50) || 50,
  });
  return NextResponse.json({ messages });
});
