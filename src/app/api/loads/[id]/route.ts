import { NextResponse } from "next/server";
import { handler, jobIdFrom, notFound, rateLimit } from "@/lib/api";
import { query } from "@/lib/db";
import { getDuplicates, getLoad } from "@/lib/loads/query";
import { loadDistances } from "@/lib/loads/roadDistance";
import { toPublicLoad, toPublicLoads, toPublicSource, type PublicSource } from "@/lib/loads/publicView";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * One job, for anybody.
 *
 * Public and phone-free: the row, its twins and the original WhatsApp text all
 * come back with every number replaced by "[phone hidden]". Nothing is recorded
 * here either -- opening a job is browsing, not interest. The one event worth
 * counting is written by POST /api/loads/:id/contact, where a real person with
 * a real account asked for a real number.
 */
export const GET = handler(async (req: Request, ctx: Ctx) => {
  rateLimit(req, "detail", 120);
  const { id } = await ctx.params;

  const jobId = jobIdFrom(id);
  if (jobId == null) notFound("Job not found");

  const load = await getLoad(jobId);
  if (!load) notFound("Job not found");

  const duplicates = await getDuplicates(load);

  // The viewer's position travels with the request, never from a stored column:
  // a location lives in the browser. Without it there is no "from you" leg.
  const sp = new URL(req.url).searchParams;
  const lat = Number(sp.get("viewerLat"));
  const lng = Number(sp.get("viewerLng"));
  const viewer = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;

  // Road distance is looked up here rather than in the list query: one billable
  // routing call when a driver opens a job, none for the 50 they scrolled past.
  const distances = await loadDistances(load.id, viewer);

  // The original WhatsApp text, so a driver can judge the extraction for
  // themselves rather than trusting a parsed summary.
  const source = load.source_message_id
    ? await query<PublicSource>(
        `SELECT m.body, m.author_name, m.sent_at::text AS sent_at, g.name AS group_name
           FROM raw_messages m LEFT JOIN whatsapp_groups g ON g.id = m.group_id
          WHERE m.id = $1`,
        [load.source_message_id],
      )
    : [];

  return NextResponse.json({
    load: toPublicLoad(load),
    duplicates: toPublicLoads(duplicates),
    source: toPublicSource(source[0] ?? null),
    distances,
  });
});
