/**
 * Demo data reset, shared by `npm run seed` and the in-app test console.
 *
 * Wipes the derived world (messages, loads, geocode cache) and replays the
 * sample corpus through the real ingest + processing path. User accounts and
 * saved searches survive, so resetting mid-demo does not sign anyone out.
 */
import { exec, query } from "@/lib/db";
import { ingestMessage } from "@/lib/pipeline/ingest";
import { processPending } from "@/lib/pipeline/process";
import { expireStaleLoads } from "@/lib/pipeline/expire";
import { GROUPS, MESSAGES } from "./sample-messages";

export interface ResetSummary {
  groups: number;
  messages: number;
  loadsCreated: number;
  duplicates: number;
  skipped: number;
  expired: number;
}

export async function resetDemoData(): Promise<ResetSummary> {
  // Loads cascade from raw_messages; places is a cache and must go too, or a
  // stale bad geocode outlives the reset.
  await exec(
    `TRUNCATE load_events, loads, raw_messages, whatsapp_groups, places RESTART IDENTITY CASCADE`,
  );

  for (const g of GROUPS) {
    await query(
      `INSERT INTO whatsapp_groups (wa_group_id, name, description) VALUES ($1,$2,$3)
       ON CONFLICT (wa_group_id) DO UPDATE SET description = EXCLUDED.description`,
      [g.waId, g.name, g.description],
    );
  }

  const waIdByName = new Map(GROUPS.map((g) => [g.name, g.waId]));
  const now = Date.now();

  for (const [i, m] of MESSAGES.entries()) {
    await ingestMessage({
      waMessageId: `seed.${i}.${m.group.replace(/\W/g, "")}`,
      body: m.body,
      // Relative to the reset, so "tomorrow" always means tomorrow.
      sentAt: new Date(now - m.hoursAgo * 3_600_000),
      authorName: m.author,
      authorPhone: m.phone ?? null,
      groupWaId: waIdByName.get(m.group) ?? null,
      groupName: m.group,
      payload: { source: "demo-reset" },
    });
  }

  const results = await processPending(MESSAGES.length + 10);
  const { expired } = await expireStaleLoads();

  return {
    groups: GROUPS.length,
    messages: MESSAGES.length,
    loadsCreated: results.reduce((n, r) => n + r.loadsCreated, 0),
    duplicates: results.reduce((n, r) => n + r.duplicates, 0),
    skipped: results.filter((r) => r.status === "skipped").length,
    expired,
  };
}
