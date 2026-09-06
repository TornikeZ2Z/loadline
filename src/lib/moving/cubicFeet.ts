/**
 * Cubic feet: the unit a household mover actually trades in.
 *
 * Numeric helpers only, and client-safe (no database, no session). Every label,
 * tone and UI option table lives in C's src/lib/loads/present.ts -- no name
 * exists in both files.
 */
import type { LoadRow } from "@/lib/loads/types";

/** A 26 ft box truck, the usual unit of "one truckload" in these groups. */
export const TRUCK_CF = 1500;

export const CF_PRESETS = [
  { label: "≤ 300", min: null, max: 300 },
  { label: "300–600", min: 300, max: 600 },
  { label: "600–1,000", min: 600, max: 1000 },
  { label: "1,000+", min: 1000, max: null },
] as const;

type PricedJob = Pick<LoadRow, "price_per_cf" | "price_flat" | "cubic_feet">;

/** "1,200 cf" — or "—" when the post never said a size. */
export function formatCf(cf: number | null | undefined): string {
  if (cf == null || !Number.isFinite(cf)) return "—";
  return `${Math.round(cf).toLocaleString("en-US")} cf`;
}

/** "≈ 0.8 truck" / "≈ 2.1 trucks", against TRUCK_CF. */
export function truckEquivalent(cf: number): string {
  const trucks = cf / TRUCK_CF;
  const rounded = Math.round(trucks * 10) / 10;
  return `≈ ${rounded.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${
    rounded === 1 ? "truck" : "trucks"
  }`;
}

/** Per-cubic-foot price, derived from a flat price when that is all the post gave. */
export function pricePerCf(job: PricedJob): number | null {
  if (job.price_per_cf != null) return job.price_per_cf;
  if (job.price_flat != null && job.cubic_feet != null && job.cubic_feet > 0) {
    return job.price_flat / job.cubic_feet;
  }
  return null;
}

/** What the job pays in total: the flat price, else per-cf × cf. */
export function jobPrice(job: PricedJob): number | null {
  if (job.price_flat != null) return job.price_flat;
  if (job.price_per_cf != null && job.cubic_feet != null) return job.price_per_cf * job.cubic_feet;
  return null;
}

/** Ready to be picked up on `todayIso` (YYYY-MM-DD). */
export function isReady(job: Pick<LoadRow, "ready_now" | "ready_date">, todayIso: string): boolean {
  if (job.ready_now) return true;
  return job.ready_date != null && job.ready_date <= todayIso;
}
