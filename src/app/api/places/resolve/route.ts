import { NextResponse } from "next/server";
import { badRequest, handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { hereLookupPosition } from "@/lib/geo/here";
import { geocode } from "@/lib/geo/geocode";

/**
 * Turn a chosen suggestion into coordinates.
 *
 * Called once, when the user picks from the dropdown -- not per keystroke.
 * That is the whole reason the suggestion list carries ids instead of
 * positions: one billable lookup per selection rather than one per character.
 */
export const POST = handler(async (req: Request) => {
  await requireUser();
  const { hereId, label } = (await req.json()) as { hereId?: string; label?: string };

  if (hereId) {
    const pos = await hereLookupPosition(hereId);
    if (pos) return NextResponse.json({ lat: pos.lat, lng: pos.lng, label: label ?? null });
  }

  // No id, or the lookup failed: fall back to resolving the text.
  if (label) {
    const hit = await geocode(label);
    if (hit) return NextResponse.json({ lat: hit.lat, lng: hit.lng, label: hit.label });
  }

  badRequest("Could not resolve that place");
});
