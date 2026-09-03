/**
 * Expiry sweep.
 *
 * A load board full of yesterday's freight is worse than useless, and nobody
 * goes back to WhatsApp to say "that one's gone". So expiry is derived: every
 * load carries expires_at (end of its pickup day plus a grace window, or 48h
 * for undated posts) and this sweep flips the status once that passes.
 *
 * Run it from a scheduler -- POST /api/cron/expire with the CRON_SECRET.
 */
import { query } from "@/lib/db";

export interface ExpiryResult {
  expired: number;
}

export async function expireStaleLoads(): Promise<ExpiryResult> {
  const rows = await query<{ id: number }>(
    `UPDATE loads
        SET status = 'expired', updated_at = now()
      WHERE status IN ('available', 'pending')
        AND expires_at IS NOT NULL
        AND expires_at < now()
      RETURNING id`,
  );

  if (rows.length) {
    // One event row per load so the admin data-quality view can explain why a
    // load disappeared.
    await query(
      `INSERT INTO load_events (load_id, kind, detail)
       SELECT id, 'status_changed', '{"to":"expired","by":"expiry_sweep"}'::jsonb
         FROM loads WHERE id = ANY($1::bigint[])`,
      [rows.map((r) => r.id)],
    );
  }

  return { expired: rows.length };
}
