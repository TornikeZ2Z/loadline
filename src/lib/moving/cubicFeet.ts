/**
 * Cubic-feet helpers -- numeric only, client-safe, no server imports (A-3).
 *
 * Every label/tone helper (`formatPrice`, `readyLabel`, `freshnessLabel`, …)
 * and every UI option table lives in C's `@/lib/loads/present`; no name exists
 * in both files (D §1.1 O7).
 */
import type { LoadRow } from "@/lib/loads/types";

/** One full truck, in cubic feet. The "≈ 2.6 truckloads" line divides by this. */
export const TRUCK_CF = 1500;

export const CF_PRESETS = [
  { label: "≤ 300", min: null, max: 300 },
  { label: "300–600", min: 300, max: 600 },
  { label: "600–1,000", min: 600, max: 1000 },
  { label: "1,000+", min: 1000, max: null },
] as const;

function withThousands(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "1,200 cf" | "—" */
export function formatCf(cf: number | null | undefined): string {
  if (cf == null || !Number.isFinite(cf)) return "—";
  return `${withThousands(cf)} cf`;
}

/** "≈ 0.8 truck" | "≈ 2.1 trucks" */
export function truckEquivalent(cf: number): string {
  const n = Math.round((cf / TRUCK_CF) * 10) / 10;
  return `≈ ${n.toFixed(1)} ${n > 1 ? "trucks" : "truck"}`;
}

/** Per-cf price, derived from the flat price when only that is known. */
export function pricePerCf(
  job: Pick<LoadRow, "price_per_cf" | "price_flat" | "cubic_feet">,
): number | null {
  if (job.price_per_cf != null) return job.price_per_cf;
  if (job.price_flat != null && job.cubic_feet != null && job.cubic_feet > 0) {
    return Math.round((job.price_flat / job.cubic_feet) * 100) / 100;
  }
  return null;
}

/** Total price: flat, else per-cf × cf; null when it cannot be known. */
export function jobPrice(
  job: Pick<LoadRow, "price_per_cf" | "price_flat" | "cubic_feet">,
): number | null {
  if (job.price_flat != null) return job.price_flat;
  if (job.price_per_cf != null && job.cubic_feet != null) {
    return Math.round(job.price_per_cf * job.cubic_feet * 100) / 100;
  }
  return null;
}

/** ready_now || ready_date <= today (ISO date strings compare lexically). */
export function isReady(job: Pick<LoadRow, "ready_now" | "ready_date">, todayIso: string): boolean {
  if (job.ready_now) return true;
  return job.ready_date != null && job.ready_date.slice(0, 10) <= todayIso;
}
