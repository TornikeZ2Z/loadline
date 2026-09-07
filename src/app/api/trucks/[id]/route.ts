import { NextResponse } from "next/server";
import { handler, jobIdFrom, notFound, rateLimit } from "@/lib/api";
import { getCurrentUser, isAdminActor } from "@/lib/auth";
import { query } from "@/lib/db";
import { getTruck } from "@/lib/loads/truckQuery";
import { toPublicSource, toPublicTruck, type PublicSource } from "@/lib/loads/publicView";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * One truck, for anybody.
 *
 * Public and phone-free: the row and the original WhatsApp text come back with
 * every number replaced by "[phone hidden]". Nothing is recorded here either --
 * opening a listing is browsing, not interest.
 *
 * TWO ways this 404s, and both are silent about which:
 *
 *   * `getTruck(id, "public")` pins `visibility = 'public'`, so a truck sitting
 *     in the review queue is not "a truck you may not see" -- it does not exist
 *     at this URL. That is the whole reason capacity has its own table: the job
 *     board's `getLoad` is `WHERE l.id = $1` with no predicate to extend, and
 *     under one table an unreviewed row would have been reachable by
 *     incrementing a bigserial;
 *   * the audience hides a truck posted from a demo account from everyone but
 *     the account that posted it.
 *
 * `jobIdFrom` parses the `[id]` segment. It is named for the board it was
 * written on and knows nothing about jobs: digits only, inside bigint range, so
 * "abc" and "0x10" 404 instead of reaching the database.
 */
export const GET = handler(async (req: Request, ctx: Ctx) => {
  // Its own bucket, like the board's: a truck detail and a job detail are
  // different endpoints, and one must not spend the other's allowance.
  rateLimit(req, "trucks-detail", 120);
  const { id } = await ctx.params;

  const truckId = jobIdFrom(id);
  if (truckId == null) notFound("Truck not found");

  const user = await getCurrentUser();
  const audience = {
    userId: user?.id ?? null,
    includeDemo: !!user && isAdminActor(user),
  };

  const truck = await getTruck(truckId, "public", audience);
  if (!truck) notFound("Truck not found");

  // The original WhatsApp text, so a driver can judge the extraction for
  // themselves rather than trusting a parsed summary. Null for a truck typed
  // into the form, which is every truck until stage 6.
  const source = truck.source_message_id
    ? await query<PublicSource>(
        `SELECT m.body, m.author_name, m.sent_at::text AS sent_at, g.name AS group_name
           FROM raw_messages m LEFT JOIN whatsapp_groups g ON g.id = m.group_id
          WHERE m.id = $1`,
        [truck.source_message_id],
      )
    : [];

  return NextResponse.json({
    truck: toPublicTruck(truck),
    source: toPublicSource(source[0] ?? null),
  });
});
