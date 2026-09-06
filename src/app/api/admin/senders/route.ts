import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";

/**
 * Every sender with their contacts, groups, origins and live counts. Admin-only: phones.
 *
 * `phones`, `groups`, `available` and `delisted` are the shapes the console
 * renders; the raw columns travel alongside them because the sender editor
 * needs `author_phone` on its own -- it is the one field an admin can write,
 * and a sender whose `phones` is empty is a sender none of whose jobs are
 * reachable until somebody attaches one.
 */
export const GET = handler(async (req: Request) => {
  await requireRole("admin");
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().toLowerCase();
  const senders = await query(
    `SELECT s.key, s.display_name, s.author_phone, s.contact_names, s.contact_phones, s.contact_mode, s.group_ids,
            s.default_origin, s.last_origin, s.merged_into,
            s.first_snapshot_at::text AS first_snapshot_at, s.last_snapshot_at::text AS last_snapshot_at,
            s.last_full_at::text AS last_full_at, s.snapshot_count,
            ARRAY(SELECT DISTINCT p
                    FROM unnest(ARRAY[s.author_phone] || s.contact_phones) AS p
                   WHERE p IS NOT NULL AND p <> '') AS phones,
            ARRAY(SELECT g.name FROM whatsapp_groups g WHERE g.id = ANY(s.group_ids) ORDER BY g.name) AS groups,
            (SELECT count(*) FROM loads l WHERE l.sender_key = s.key AND l.status = 'available')::int AS available,
            (SELECT count(*) FROM loads l WHERE l.sender_key = s.key AND l.status = 'delisted')::int AS delisted,
            (SELECT count(*) FROM loads l WHERE l.sender_key = s.key AND l.status = 'available')::int AS available_count,
            (SELECT count(*) FROM loads l WHERE l.sender_key = s.key AND l.status = 'delisted')::int AS delisted_count,
            (SELECT count(*) FROM loads l WHERE l.sender_key = s.key AND l.status = 'expired')::int AS expired_count,
            (SELECT count(*) FROM loads l
              WHERE l.sender_key = s.key AND l.status = 'available' AND l.contact_phone IS NULL)::int AS unreachable_count
       FROM senders s
      WHERE $1 = '' OR lower(coalesce(s.display_name, '')) LIKE '%' || $1 || '%'
         OR lower(s.key) LIKE '%' || $1 || '%'
         OR lower(array_to_string(s.contact_names, ' ')) LIKE '%' || $1 || '%'
      ORDER BY s.last_snapshot_at DESC NULLS LAST, s.key`,
    [q],
  );
  return NextResponse.json({ senders });
});
