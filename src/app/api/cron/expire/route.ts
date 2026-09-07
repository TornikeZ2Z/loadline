import { NextResponse } from "next/server";
import { handler, requireCronSecret } from "@/lib/api";
import { expireStaleLoads } from "@/lib/pipeline/expire";
import { expireTrucks } from "@/lib/pipeline/trucks";

/**
 * The scheduled sweep, now over both kinds of listing.
 *
 * THREE SEPARATE NUMBERS, never a total. `expired` counts jobs whose sender
 * went silent; `trucksDeparted` counts trucks whose stated day has passed;
 * `trucksExpired` counts trucks that never stated a day and ran out their
 * 48-hour TTL. They are different events with different causes, and a sum of
 * them would be a figure nobody could act on.
 *
 * The two sweeps are independent statements over two tables: `expireTrucks`
 * cannot touch a `loads` row and `expireStaleLoads` cannot touch a `trucks`
 * row, which lifecycle test T8 asserts rather than assumes.
 */
export const POST = handler(async (req: Request) => {
  requireCronSecret(req);
  const { expired } = await expireStaleLoads();
  const { trucksDeparted, trucksExpired } = await expireTrucks();
  return NextResponse.json({ expired, trucksDeparted, trucksExpired });
});
