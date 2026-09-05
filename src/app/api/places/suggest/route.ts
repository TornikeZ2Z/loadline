import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { hereAutosuggest, hereConfigured } from "@/lib/geo/here";
import { CITIES } from "@/lib/geo/cities";
import { STATES } from "@/lib/geo/states";

/**
 * Type-ahead place suggestions for the location inputs.
 *
 * Proxied rather than called from the browser so the HERE key stays on the
 * server. Without a key it falls back to the offline gazetteer, so the dropdown
 * still works -- just with the curated city list instead of every US address.
 */
export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  const sp = new URL(req.url).searchParams;
  const q = (sp.get("q") ?? "").trim();

  if (q.length < 2) return NextResponse.json({ suggestions: [], source: "none" });

  if (hereConfigured()) {
    const near =
      user.home_lat != null && user.home_lng != null
        ? { lat: user.home_lat, lng: user.home_lng }
        : null;
    const places = await hereAutosuggest(q, near);
    if (places.length) {
      return NextResponse.json({
        source: "here",
        suggestions: places.map((p) => ({
          label: p.short || p.label,
          detail: p.label,
          lat: p.lat,
          lng: p.lng,
          precision: p.precision,
        })),
      });
    }
  }

  return NextResponse.json({ source: "gazetteer", suggestions: offlineSuggestions(q) });
});

function offlineSuggestions(q: string) {
  const needle = q.toLowerCase();

  const cities = CITIES.filter((c) => c.city.toLowerCase().startsWith(needle))
    .slice(0, 6)
    .map((c) => ({
      label: `${c.city}, ${c.state}`,
      detail: `${c.city}, ${c.state} ${c.zip}`,
      lat: c.lat,
      lng: c.lng,
      precision: "city" as const,
    }));

  const states = STATES.filter((s) => s.name.toLowerCase().startsWith(needle))
    .slice(0, 3)
    .map((s) => ({
      label: s.name,
      detail: `${s.name} (anywhere in the state)`,
      lat: s.lat,
      lng: s.lng,
      precision: "state" as const,
    }));

  return [...cities, ...states].slice(0, 8);
}
