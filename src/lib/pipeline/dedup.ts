/**
 * Duplicate detection.
 *
 * The same load gets posted repeatedly -- reposted an hour later for
 * visibility, forwarded into three groups, or posted by both the broker and
 * their dispatcher. Showing it four times makes the board feel like WhatsApp
 * again, which is the thing we are trying to fix.
 *
 * Strategy: a cheap blocking pass to find plausible candidates (same lane, same
 * pickup day, recent), then a weighted score on the details. Above the
 * threshold, the new load joins the existing cluster and stops being canonical,
 * so only one row surfaces in search.
 */
import { query } from "@/lib/db";

export interface DedupCandidateInput {
  pickup_city: string | null;
  pickup_state: string | null;
  pickup_zip: string | null;
  delivery_city: string | null;
  delivery_state: string | null;
  delivery_zip: string | null;
  pickup_date: string | null;
  contact_phone: string | null;
  contact_name: string | null;
  weight_lbs: number | null;
  pallets: number | null;
  group_id: number | null;
  confidence: number;
}

interface ExistingLoad {
  id: number;
  dup_group_id: string | null;
  is_canonical: boolean;
  confidence: number;
  pickup_city: string | null;
  pickup_state: string | null;
  pickup_zip: string | null;
  delivery_city: string | null;
  delivery_state: string | null;
  delivery_zip: string | null;
  pickup_date: string | null;
  contact_phone: string | null;
  contact_name: string | null;
  weight_lbs: number | null;
  pallets: number | null;
}

export interface DuplicateMatch {
  /** The load already in the database that this one duplicates. */
  matchId: number;
  dupGroupId: string;
  score: number;
  /** True when the new load is better data and should take over as canonical. */
  supersedes: boolean;
}

/** Score above which two posts are treated as the same load. */
const THRESHOLD = 0.72;

export async function findDuplicate(
  candidate: DedupCandidateInput,
): Promise<DuplicateMatch | null> {
  // Blocking pass. Same pickup day, and lanes that agree on at least the state
  // pair -- cheap enough to run per message and it uses the state indexes.
  const rows = await query<ExistingLoad>(
    `SELECT id, dup_group_id, is_canonical, confidence,
            pickup_city, pickup_state, pickup_zip,
            delivery_city, delivery_state, delivery_zip,
            pickup_date::text AS pickup_date,
            contact_phone, contact_name, weight_lbs, pallets
       FROM loads
      WHERE status <> 'cancelled'
        AND created_at > now() - interval '7 days'
        AND (pickup_date IS NOT DISTINCT FROM $1::date)
        AND (pickup_state IS NOT DISTINCT FROM $2)
        AND (delivery_state IS NOT DISTINCT FROM $3)
      ORDER BY id DESC
      LIMIT 200`,
    [candidate.pickup_date, candidate.pickup_state, candidate.delivery_state],
  );

  let best: { row: ExistingLoad; score: number } | null = null;
  for (const row of rows) {
    const score = similarity(candidate, row);
    if (score >= THRESHOLD && (!best || score > best.score)) best = { row, score };
  }
  if (!best) return null;

  const dupGroupId = best.row.dup_group_id ?? `dg_${best.row.id}`;
  if (!best.row.dup_group_id) {
    await query(`UPDATE loads SET dup_group_id = $1 WHERE id = $2`, [dupGroupId, best.row.id]);
  }

  return {
    matchId: best.row.id,
    dupGroupId,
    score: best.score,
    supersedes: candidate.confidence > best.row.confidence + 0.15,
  };
}

/**
 * Weighted field agreement, 0..1. Phone is the strongest signal by far -- two
 * posts with the same lane, same day, and same callback number are the same
 * load essentially always.
 */
function similarity(a: DedupCandidateInput, b: ExistingLoad): number {
  let score = 0;
  let weight = 0;

  const add = (w: number, agree: boolean | null) => {
    if (agree === null) return; // unknown on one side: no evidence either way
    weight += w;
    if (agree) score += w;
  };

  add(0.40, cmp(digits(a.contact_phone), digits(b.contact_phone)));
  add(0.10, cmp(a.contact_name?.toLowerCase(), b.contact_name?.toLowerCase()));
  add(0.18, cmp(a.pickup_zip, b.pickup_zip) ?? cmp(norm(a.pickup_city), norm(b.pickup_city)));
  add(0.18, cmp(a.delivery_zip, b.delivery_zip) ?? cmp(norm(a.delivery_city), norm(b.delivery_city)));
  add(0.08, cmp(a.weight_lbs, b.weight_lbs));
  add(0.06, cmp(a.pallets, b.pallets));

  if (weight === 0) return 0;
  // Normalize by the evidence actually available, then require a floor of real
  // signal so two sparse posts do not match on nothing.
  const normalized = score / weight;
  return weight >= 0.5 ? normalized : normalized * 0.6;
}

function cmp<T>(x: T | null | undefined, y: T | null | undefined): boolean | null {
  if (x == null || y == null) return null;
  return x === y;
}

function digits(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const d = phone.replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

function norm(city: string | null | undefined): string | null {
  return city ? city.toLowerCase().replace(/[^a-z]/g, "") : null;
}

/**
 * Attach a load to an existing cluster. When the newcomer has materially
 * better data it becomes canonical and demotes the old row instead.
 */
export async function linkDuplicate(
  newLoadId: number,
  match: DuplicateMatch,
): Promise<void> {
  if (match.supersedes) {
    await query(
      `UPDATE loads SET dup_group_id = $1, is_canonical = false, dup_of = $2, updated_at = now()
        WHERE dup_group_id = $1 AND id <> $3`,
      [match.dupGroupId, newLoadId, newLoadId],
    );
    await query(
      `UPDATE loads SET dup_group_id = $1, is_canonical = true, dup_of = NULL, dup_score = $2
        WHERE id = $3`,
      [match.dupGroupId, match.score, newLoadId],
    );
  } else {
    await query(
      `UPDATE loads SET dup_group_id = $1, is_canonical = false, dup_of = $2, dup_score = $3
        WHERE id = $4`,
      [match.dupGroupId, match.matchId, match.score, newLoadId],
    );
  }
  await query(
    `INSERT INTO load_events (load_id, kind, detail) VALUES ($1, 'merged', $2)`,
    [newLoadId, JSON.stringify({ matched: match.matchId, score: match.score, supersedes: match.supersedes })],
  );
}
