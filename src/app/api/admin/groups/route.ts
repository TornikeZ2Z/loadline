import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";

/**
 * Every WhatsApp group and its stored link, for the admin console.
 *
 * Admin-only, because `invite_url` may be a `wa.me` line -- a phone number
 * written as a URL. The console reads this rather than the group list the page
 * already server-renders, so the link never has to travel through a payload
 * that anonymous callers also receive.
 */
export const GET = handler(async () => {
  await requireRole("admin");
  const groups = await query(
    `SELECT g.id, g.name, g.description, g.invite_url,
            (SELECT count(*) FROM raw_messages m WHERE m.group_id = g.id)::int AS message_count
       FROM whatsapp_groups g
      ORDER BY g.name`,
  );
  return NextResponse.json({ groups });
});
