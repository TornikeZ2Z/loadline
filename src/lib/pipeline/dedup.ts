/**
 * Cross-sender twins (A §7.6).
 *
 * Reposts by the same sender are supersession, not duplicates -- a sender's
 * job is one row per (sender_key, job_key) forever. What is left for a
 * duplicate check is the same job forwarded by two different senders: same
 * origin city/state, same destination ZIP, same cubic feet, both available,
 * seen within a week of each other. Never called on insert; the admin
 * data-quality tab reads it.
 */
import { query } from "@/lib/db";

export interface TwinPair {
  a: number;
  b: number;
  score: number;
}

export async function findCrossSenderTwins(): Promise<TwinPair[]> {
  const rows = await query<{ a: number; b: number; price_match: boolean }>(
    `SELECT a.id AS a, b.id AS b,
            (a.price_per_cf IS NOT DISTINCT FROM b.price_per_cf AND a.price_flat IS NOT DISTINCT FROM b.price_flat) AS price_match
       FROM loads a
       JOIN loads b ON b.id > a.id
      WHERE a.sender_key IS NOT NULL AND b.sender_key IS NOT NULL AND a.sender_key <> b.sender_key
        AND a.status = 'available' AND b.status = 'available'
        AND a.delivery_zip IS NOT NULL AND a.delivery_zip = b.delivery_zip
        AND a.cubic_feet IS NOT NULL AND a.cubic_feet = b.cubic_feet
        AND lower(coalesce(a.pickup_city, '')) = lower(coalesce(b.pickup_city, ''))
        AND a.pickup_state IS NOT DISTINCT FROM b.pickup_state
        AND a.last_seen_at IS NOT NULL AND b.last_seen_at IS NOT NULL
        AND abs(extract(epoch FROM (a.last_seen_at - b.last_seen_at))) < 7 * 86400
      ORDER BY a.id, b.id
      LIMIT 500`,
  );
  return rows.map((r) => ({ a: r.a, b: r.b, score: r.price_match ? 1 : 0.8 }));
}
