import { NextResponse } from "next/server";
import { handler, notFound } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { query } from "@/lib/db";
import { getDuplicates, getLoad } from "@/lib/loads/query";
import { loadDistances } from "@/lib/loads/roadDistance";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = handler(async (_req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;

  const load = await getLoad(Number(id));
  if (!load) notFound("Load not found");

  const duplicates = await getDuplicates(load);

  // Road distance is looked up here rather than in the list query: one billable
  // routing call when a driver opens a load, none for the 50 they scrolled past.
  const viewer =
    user.home_lat != null && user.home_lng != null
      ? { lat: user.home_lat, lng: user.home_lng }
      : null;
  const distances = await loadDistances(load.id, viewer);

  // The original WhatsApp text, so a driver can judge the extraction for
  // themselves rather than trusting a parsed summary.
  const source = load.source_message_id
    ? await query<{
        body: string;
        author_name: string | null;
        sent_at: string;
        group_name: string | null;
      }>(
        `SELECT m.body, m.author_name, m.sent_at::text AS sent_at, g.name AS group_name
           FROM raw_messages m LEFT JOIN whatsapp_groups g ON g.id = m.group_id
          WHERE m.id = $1`,
        [load.source_message_id],
      )
    : [];

  // Revealing a contact is worth recording: it is the closest thing this
  // marketplace has to a conversion event.
  await query(`INSERT INTO load_events (load_id, actor_id, kind) VALUES ($1,$2,'viewed_contact')`, [
    load.id,
    user.id,
  ]);

  return NextResponse.json({ load, duplicates, source: source[0] ?? null, distances });
});
