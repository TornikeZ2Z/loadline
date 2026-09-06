/**
 * Demo data reset, shared by `npm run seed` and the in-app test console.
 *
 * Wipes the derived world (messages, senders, snapshots, sightings, jobs,
 * issues, format signatures, geocode cache) and replays the sample corpus
 * through the real ingest + processing path. User accounts, saved searches
 * and -- deliberately -- learned extraction rules and accepted pattern cases
 * survive: "solve once, keep forever" has to survive a reset.
 */
import { exec, query, queryOne } from "@/lib/db";
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
  senders: number;
  delisted: number;
  /** Messages in the admin "Needs attention" queue. */
  attention: number;
  /** Available jobs from FL to NJ -- the README walkthrough's first filter. */
  flNj: number;
}

/** The truncate list every reset shares (rules and pattern cases are kept). */
export const RESET_TABLES =
  "load_events, load_sightings, sender_snapshots, senders, loads, raw_messages, whatsapp_groups, places, extraction_issues, format_signatures";

export async function resetDemoData(): Promise<ResetSummary> {
  await exec(`TRUNCATE ${RESET_TABLES} RESTART IDENTITY CASCADE`);

  for (const g of GROUPS) {
    await query(
      `INSERT INTO whatsapp_groups (wa_group_id, name, description, invite_url) VALUES ($1,$2,$3,$4)
       ON CONFLICT (wa_group_id) DO UPDATE SET
         description = EXCLUDED.description, invite_url = EXCLUDED.invite_url`,
      [g.waId, g.name, g.description, g.invite ?? null],
    );
  }

  const waIdByName = new Map(GROUPS.map((g) => [g.name, g.waId]));
  const now = Date.now();

  for (const [i, m] of MESSAGES.entries()) {
    await ingestMessage({
      waMessageId: `seed.${i}.${m.group.replace(/\W/g, "")}`,
      body: m.body,
      // Relative to the reset, so "yesterday's post" is always yesterday's.
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

  const counts = await queryOne<{ senders: number; delisted: number; attention: number; fl_nj: number }>(
    `SELECT (SELECT count(*) FROM senders)::int AS senders,
            (SELECT count(*) FROM loads WHERE status = 'delisted')::int AS delisted,
            (SELECT count(*) FROM raw_messages WHERE attention IS NOT NULL)::int AS attention,
            (SELECT count(*) FROM loads WHERE pickup_state = 'FL' AND delivery_state = 'NJ' AND status = 'available')::int AS fl_nj`,
  );

  return {
    groups: GROUPS.length,
    messages: MESSAGES.length,
    loadsCreated: results.reduce((n, r) => n + r.loadsCreated, 0),
    duplicates: results.reduce((n, r) => n + r.duplicates, 0),
    skipped: results.filter((r) => r.status === "skipped").length,
    expired,
    senders: counts?.senders ?? 0,
    delisted: counts?.delisted ?? 0,
    attention: counts?.attention ?? 0,
    flNj: counts?.fl_nj ?? 0,
  };
}
