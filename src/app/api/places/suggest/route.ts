import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { hereAutocomplete, hereConfigured } from "@/lib/geo/here";
import { CITIES } from "@/lib/geo/cities";
import { REGIONS, STATES } from "@/lib/geo/states";
import { ALIASES } from "@/lib/geo/aliases";

export interface Suggestion {
  label: string;
  detail: string;
  /** Null for HERE results, which are resolved on pick via /api/places/resolve. */
  lat: number | null;
  lng: number | null;
  precision: string;
  hereId?: string;
}

/**
 * Place suggestions for the location inputs.
 *
 * Local matches come first on purpose. The freight vocabulary -- "north
 * jersey", "socal", "philly", "EWR" -- is exactly what dispatchers type and
 * exactly what a general geocoder is worst at: HERE turns "north jer" into
 * North Jerico, Virginia. Those entries are also free and instant.
 *
 * HERE then supplies everything our curated list cannot: every US city, ZIP and
 * street address. Its results carry no coordinates (see hereAutocomplete), so
 * they are resolved only when one is actually chosen.
 */
export const GET = handler(async (req: Request) => {
  await requireUser();
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ suggestions: [], source: "none" });

  const local = localSuggestions(q);

  let here: Suggestion[] = [];
  if (hereConfigured()) {
    const places = await hereAutocomplete(q);
    here = places.map((p) => ({
      label: p.short,
      detail: p.label,
      lat: null,
      lng: null,
      precision: p.precision,
      hereId: p.id,
    }));
  }

  // Drop HERE rows that duplicate a local match by name.
  const seen = new Set(local.map((s) => s.label.toLowerCase()));
  const merged = [...local, ...here.filter((s) => !seen.has(s.label.toLowerCase()))];

  return NextResponse.json({
    source: here.length ? "here+local" : "local",
    suggestions: merged.slice(0, 10),
  });
});

/** Aliases, curated cities, regions and states -- our own freight vocabulary. */
function localSuggestions(q: string): Suggestion[] {
  const needle = q.toLowerCase().trim();
  const out: Suggestion[] = [];

  // Freight nicknames: "philly", "socal", "north jersey", "EWR".
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (out.length >= 4) break;
    if (!alias.startsWith(needle)) continue;

    if (target.city) {
      const c = CITIES.find((x) => `${x.city}, ${x.state}`.toLowerCase() === target.city!.toLowerCase());
      if (c) {
        out.push({
          label: `${c.city}, ${c.state}`,
          detail: `"${alias}" — ${c.city}, ${c.state}`,
          lat: c.lat,
          lng: c.lng,
          precision: "city",
        });
      }
    } else if (target.region) {
      const r = REGIONS[target.region];
      if (r) {
        out.push({
          label: r.label,
          detail: `"${alias}" — ${r.states.join(", ")}`,
          lat: r.lat,
          lng: r.lng,
          precision: "region",
        });
      }
    }
  }

  for (const s of STATES) {
    if (out.length >= 6) break;
    if (s.name.toLowerCase().startsWith(needle)) {
      out.push({
        label: s.name,
        detail: `${s.name} — anywhere in the state`,
        lat: s.lat,
        lng: s.lng,
        precision: "state",
      });
    }
  }

  // De-duplicate by label, keeping first (aliases outrank plain states).
  const seen = new Set<string>();
  return out.filter((s) => {
    const k = s.label.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
