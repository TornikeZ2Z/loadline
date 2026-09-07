/**
 * What a match result looks like on the wire.
 *
 * A match is a POINTER, NOT AN INTRODUCTION. Neither matches endpoint returns a
 * phone for either side: the listings inside a result go through exactly the
 * same `toPublicLoad` / `toPublicTruck` the boards use, so a match list can
 * never answer a question the board itself would refuse. To call, the reader
 * goes through the contact gate on whichever listing they pick, and that reveal
 * is logged like every other. SPEC 11.10.
 *
 * The verdict rides through unchanged. It carries no personal data -- miles,
 * cubic feet, two dates and a list of clauses composed from them -- and the
 * `score` on it is present for the eval suite and the admin console and is
 * never rendered.
 */
import { toPublicLoad, toPublicTruck } from "@/lib/loads/publicView";
import type { PublicLoadRow, PublicTruckRow } from "@/lib/loads/publicView";
import type { LoadRow } from "@/lib/loads/types";
import type { TruckRow } from "@/lib/loads/truckTypes";
import type { MatchResult } from "./types";

export type PublicJobMatches = MatchResult<PublicLoadRow>;
export type PublicTruckMatches = MatchResult<PublicTruckRow>;

/** "Loads that fit this truck", redacted. */
export function toPublicJobMatches(result: MatchResult<LoadRow>): PublicJobMatches {
  return {
    ...result,
    matches: result.matches.map((m) => ({ item: toPublicLoad(m.item), verdict: m.verdict })),
  };
}

/** "Trucks that could take this", redacted. */
export function toPublicTruckMatches(result: MatchResult<TruckRow>): PublicTruckMatches {
  return {
    ...result,
    matches: result.matches.map((m) => ({ item: toPublicTruck(m.item), verdict: m.verdict })),
  };
}
