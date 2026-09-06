import { NextResponse } from "next/server";
import { badRequest, handler, rateLimit } from "@/lib/api";
import { hereConfigured, hereGeocode, hereLookupPosition, hereReverseGeocode } from "@/lib/geo/here";
import type { HereAddress } from "@/lib/geo/here";
import { geocode } from "@/lib/geo/geocode";
import { nearestCity } from "@/lib/geo/cities";
import { haversineMiles } from "@/lib/geo/math";

/** What LocationInput.onPick hands back, and what the location slots store. */
export interface ResolvedPlace {
  label: string;
  lat: number;
  lng: number;
  precision: string;
  state: string | null;
  city: string | null;
  zip: string | null;
}

/**
 * Turn a chosen suggestion -- or a raw GPS fix -- into a place.
 *
 * Called once, when the user picks from the dropdown or presses Use GPS, never
 * per keystroke. That is the whole reason the suggestion list carries ids
 * instead of positions: one billable lookup per selection rather than one per
 * character.
 *
 * Public, like the board. Every branch returns the full shape including
 * city/state/zip: the post form fills `pickupState`/`pickupZip` from a picked
 * suggestion, and the admin console turns the same three fields into a learned
 * place. A branch that returned only coordinates would quietly break both.
 */
export const POST = handler(async (req: Request) => {
  rateLimit(req, "resolve", 30);
  const { hereId, label, lat, lng } = (await req.json().catch(() => ({}))) as {
    hereId?: string;
    label?: string;
    lat?: number;
    lng?: number;
  };

  // 1. A GPS fix. The browser's coordinates are authoritative; only the label
  //    is looked up, so a failed reverse geocode still leaves the pin correct.
  if (typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)) {
    return NextResponse.json(await reverseLabel(lat, lng));
  }

  // 2. A HERE suggestion the user actually chose.
  if (hereId) {
    const hit = await hereLookupPosition(hereId);
    if (hit) {
      // The lookup response usually carries the address parts. A city-level id
      // occasionally comes back without them; geocoding the text we already
      // have is the cheapest way to fill city/state/zip rather than return null.
      let parts: HereAddress | null = hit.address;
      if (!parts && label) {
        const geo = await hereGeocode(label);
        if (geo) parts = { city: geo.city, state: geo.state, postalCode: geo.postalCode };
      }
      const derived = [parts?.city, parts?.state].filter(Boolean).join(", ");
      return NextResponse.json({
        lat: hit.lat,
        lng: hit.lng,
        label: label ?? derived,
        precision: "address",
        state: parts?.state ?? null,
        city: parts?.city ?? null,
        zip: parts?.postalCode ?? null,
      } satisfies ResolvedPlace);
    }
  }

  // 3. Free text -- typed, or a HERE lookup that failed. The offline gazetteer
  //    answers this without a key, which is what keeps the demo working.
  if (label) {
    const hit = await geocode(label);
    if (hit) {
      return NextResponse.json({
        lat: hit.lat,
        lng: hit.lng,
        label: hit.label,
        precision: hit.precision,
        state: hit.state ?? null,
        city: hit.city ?? null,
        zip: hit.zip ?? null,
      } satisfies ResolvedPlace);
    }
  }

  badRequest("Could not resolve that place");
});

/**
 * The server half of "Use GPS": coordinates in, a name a human recognises out.
 *
 * Three tiers, and all three keep the caller's exact coordinates -- the label
 * is cosmetic, the position is what sorts the board. Without a HERE key the
 * curated city list still gives "Near Miami, FL", which is enough for a driver
 * to trust that the board knows where they are.
 */
async function reverseLabel(lat: number, lng: number): Promise<ResolvedPlace> {
  if (hereConfigured()) {
    const hit = await hereReverseGeocode(lat, lng);
    if (hit) {
      return {
        lat,
        lng,
        label: hit.label,
        precision: "address",
        state: hit.state,
        city: hit.city,
        zip: hit.zip,
      };
    }
  }

  const near = nearestCity(lat, lng);
  if (near && haversineMiles({ lat, lng }, near) <= 60) {
    return {
      lat,
      lng,
      label: `Near ${near.city}, ${near.state}`,
      precision: "address",
      state: near.state,
      city: near.city,
      zip: null,
    };
  }

  return {
    lat,
    lng,
    label: "Your location",
    precision: "address",
    state: null,
    city: null,
    zip: null,
  };
}
