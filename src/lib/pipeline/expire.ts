/**
 * Expiry sweep.
 *
 * A batch job expires when its sender has been silent for four days
 * (`expires_at = senders.last_snapshot_at + 4 days`, written by rebuildSender);
 * a website post expires by its own `expires_at` (ready day + grace, or 72 h).
 * Delisted rows are never swept -- they already have a reason.
 *
 * `now` is a parameter, never SQL now(), so the lifecycle eval can move the
 * clock. Run it from a scheduler -- POST /api/cron/expire with the CRON_SECRET.
 */
import { query } from "@/lib/db";

export interface ExpiryResult {
  expired: number;
}

export async function expireStaleLoads(now: Date = new Date()): Promise<ExpiryResult> {
  const nowIso = now.toISOString();
  const rows = await query<{ id: number }>(
    `UPDATE loads
        SET status = 'expired', updated_at = $1::timestamptz
      WHERE status = 'available'
        AND status_source = 'derived'
        AND expires_at IS NOT NULL
        AND expires_at < $1::timestamptz
      RETURNING id`,
    [nowIso],
  );

  if (rows.length) {
    // One event row per load so the admin data-quality view can explain why a
    // load disappeared.
    await query(
      `INSERT INTO load_events (load_id, kind, detail)
       SELECT id, 'status_changed', '{"to":"expired","by":"expiry_sweep","reason":"sender_silent"}'::jsonb
         FROM loads WHERE id = ANY($1::bigint[])`,
      [rows.map((r) => r.id)],
    );
  }

  return { expired: rows.length };
}
