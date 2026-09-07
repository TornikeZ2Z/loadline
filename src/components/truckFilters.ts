/**
 * The board's one set of filters, translated into the truck board's vocabulary.
 *
 * A separate translator rather than a second `filtersToQuery`, because the two
 * boards answer different questions with the same words and the difference is
 * the whole of §15.2:
 *
 *   * `pickupState` means "the freight is in X" for a job and "the truck is in
 *     X" for a truck, so it becomes `originState`;
 *   * `minCf` means the size of a shipment. A truck's `minFreeCf` is the size of
 *     a hole. Mapping one onto the other is a filter that lies, so the job size
 *     filter is NOT applied and the Trucks tab says so out loud;
 *   * `readyBy` is when the furniture is on the sidewalk. A truck departs. Not
 *     applied, and said;
 *   * `hasPrice` hides every truck, because a truck carries no price in v1.
 *     That is correct behaviour that reads exactly like a bug, so it is printed
 *     rather than left to be discovered.
 *
 * `parseTruckSearchParams` refuses every one of those keys with a 400, so this
 * cannot silently pass one through: forgetting to drop `minCf` here would break
 * the Trucks tab loudly rather than answer a question about freight with an
 * unfiltered truck board.
 *
 * NO FILTER IS EVER SILENTLY IGNORED. `truckFilterNotes` is the other half of
 * this file and is rendered above the truck list; the two are written together
 * so a key dropped here without a note is visible in one screen of source.
 */

import type { BoundsInput } from "@/lib/loads/types";
import type { StoredLocation } from "@/lib/location";
import type { Filters } from "./FilterBar";

/**
 * `FilterBar`'s "this city only" sentinel, and the job board's default radius.
 *
 * Copied rather than imported: `FilterBar.tsx` keeps both private, and widening
 * its exports to feed this file would put two more names on a 2,000-line module
 * for the sake of two constants. `npm run check:sums` asserts the values still
 * agree with the ones that file uses.
 */
const EXACT = "city";
const DEFAULT_RADIUS = "50";

/** The truck statuses that are not "still on offer" — the mirror of the job board's inactive set. */
const INACTIVE_TRUCK_STATUSES = "available,booked,departed,expired,cancelled";

function round5(n: number): string {
  return n.toFixed(5);
}

export function truckFiltersToQuery(
  f: Filters,
  ctx: { current: StoredLocation | null; home: StoredLocation | null; bounds?: BoundsInput | null },
): string {
  const sp = new URLSearchParams();

  // Geography: the same places, the truck's own column names.
  if (f.pickupState.length) sp.set("originState", f.pickupState.join(","));
  if (f.pickupZip) sp.set("originZip", f.pickupZip);
  if (f.deliveryState.length) sp.set("destState", f.deliveryState.join(","));
  if (f.deliveryZip) sp.set("destZip", f.deliveryZip);

  if (f.seenDays) sp.set("seenDays", f.seenDays);
  if (f.q.trim()) sp.set("q", f.q.trim());
  if (f.showInactive) sp.set("status", INACTIVE_TRUCK_STATUSES);
  // Admin-only, and the route strips it for everybody else — exactly as the job
  // board does, so a driver cannot enumerate the review queue by typing a key.
  if (f.review) sp.set("review", "1");

  const writePoint = (
    place: { label: string; lat: number | null; lng: number | null },
    textKey: string,
    latKey: string,
    lngKey: string,
  ) => {
    if (place.label) sp.set(textKey, place.label);
    if (place.lat != null && place.lng != null) {
      sp.set(latKey, round5(place.lat));
      sp.set(lngKey, round5(place.lng));
    }
  };

  if (f.routeMode === "corridor") {
    sp.set("routeMode", "corridor");
    if (f.corridor) sp.set("corridor", f.corridor);
    if (f.origin) writePoint(f.origin, "origin", "originLat", "originLng");
    else if (ctx.current) {
      sp.set("originLat", round5(ctx.current.lat));
      sp.set("originLng", round5(ctx.current.lng));
    }
    if (f.dest) writePoint(f.dest, "dest", "destLat", "destLng");
    else if (ctx.home) {
      sp.set("destLat", round5(ctx.home.lat));
      sp.set("destLng", round5(ctx.home.lng));
    }
  } else if (f.routeMode === "radius") {
    // "This city only" becomes `originCity`, the truck board's exact-match key.
    // The job board spells the same idea `pickupCity`, which the truck parser
    // refuses by name — the two are different questions about different rows.
    if (f.origin) {
      if (f.radius === EXACT && f.origin.city) sp.set("originCity", f.origin.city);
      else {
        writePoint(f.origin, "origin", "originLat", "originLng");
        sp.set("radius", f.radius && f.radius !== EXACT ? f.radius : DEFAULT_RADIUS);
      }
    }
    if (f.dest) {
      if (f.destRadius === EXACT && f.dest.city) sp.set("destCity", f.dest.city);
      else {
        writePoint(f.dest, "dest", "destLat", "destLng");
        sp.set("destRadius", f.destRadius && f.destRadius !== EXACT ? f.destRadius : DEFAULT_RADIUS);
      }
    }
  }

  if (ctx.bounds) {
    sp.set("minLat", ctx.bounds.minLat.toFixed(5));
    sp.set("maxLat", ctx.bounds.maxLat.toFixed(5));
    sp.set("minLng", ctx.bounds.minLng.toFixed(5));
    sp.set("maxLng", ctx.bounds.maxLng.toFixed(5));
  }

  if (ctx.current) {
    sp.set("viewerLat", round5(ctx.current.lat));
    sp.set("viewerLng", round5(ctx.current.lng));
  }

  return sp.toString();
}

export interface TruckFilterNote {
  key: string;
  text: string;
}

/**
 * Every job-shaped filter that is currently set and is NOT narrowing the trucks
 * on screen, said in one sentence each.
 *
 * The deliver-by lesson from wave 1, applied before it can be repeated: a
 * control that appears to be doing something and is not is worse than one that
 * is switched off, because the driver reads the result as the answer to a
 * question they never actually asked.
 */
export function truckFilterNotes(f: Filters): TruckFilterNote[] {
  const notes: TruckFilterNote[] = [];

  if (f.hasPrice) {
    notes.push({
      key: "price",
      text: "Trucks never carry a price, so “priced only” hides all of them.",
    });
  }
  if (f.minCf || f.maxCf || !f.unsized) {
    notes.push({
      key: "cf",
      text: "Not narrowed by size — “jobs over 600 cf” and “trucks with 600 cf free” are different questions.",
    });
  }
  if (f.ready !== "any") {
    notes.push({
      key: "ready",
      text: "Not narrowed by “ready” — a truck departs rather than becoming ready.",
    });
  }
  if (f.deliverBy) {
    notes.push({
      key: "deliverBy",
      text: "Not narrowed by the delivery deadline — a truck has no delivery to be late for.",
    });
  }

  return notes;
}

/** True when the price filter alone empties the truck board. */
export function pricedOnlyHidesTrucks(f: Filters): boolean {
  return f.hasPrice;
}
