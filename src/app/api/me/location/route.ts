import { NextResponse } from "next/server";
import { badRequest, handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { query } from "@/lib/db";
import { geocode } from "@/lib/geo/geocode";

/**
 * Set the signed-in user's current location.
 *
 * Everything distance-related keys off this: "loads near me", the distance
 * column, and the drive time shown on a load. Accepts either coordinates
 * (from the browser's geolocation or a picked suggestion) or free text.
 */
export const PUT = handler(async (req: Request) => {
  const user = await requireUser();
  const body = (await req.json()) as {
    label?: string;
    lat?: number;
    lng?: number;
  };

  let label = body.label?.trim() ?? "";
  let lat = body.lat;
  let lng = body.lng;

  if (lat == null || lng == null) {
    if (!label) badRequest("Give a place name or coordinates");
    const hit = await geocode(label);
    if (!hit) badRequest(`Could not find "${label}"`);
    lat = hit.lat;
    lng = hit.lng;
    label = hit.label;
  }

  await query(
    `UPDATE users SET home_label = $1, home_lat = $2, home_lng = $3 WHERE id = $4`,
    [label || null, lat, lng, user.id],
  );

  return NextResponse.json({ label, lat, lng });
});
