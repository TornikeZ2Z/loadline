import { NextResponse } from "next/server";
import { handler, rateLimit } from "@/lib/api";
import { hereAutocomplete, hereConfigured } from "@/lib/geo/here";
import { CITIES } from "@/lib/geo/cities";
import { REGIONS, STATES, stateForZip } from "@/lib/geo/states";
import { ALIASES } from "@/lib/geo/aliases";

export interface Suggestion {
  label: string;
  detail: string;
  /** Null for HERE results, which are resolved on pick via /api/places/resolve. */
  lat: number | null;
  lng: number | null;
  precision: string;
  /** "FL" when the row knows it. Feeds the post form and the location slots. */
  state: string | null;
  /** 5 digits when the row is a ZIP or carries one. */
  zip: string | null;
  hereId?: string;
}

/**
 * Place suggestions for the location inputs. Public: this is the type-ahead
 * behind "Where are you?", and the board asks nobody to sign in to browse.
 * A rate limit stands in for the session that used to gate it.
 *
 * Local matches come first on purpose. The mover vocabulary -- "north jersey",
 * "socal", "philly", "EWR" -- is exactly what people type and exactly what a
 * general geocoder is worst at: HERE turns "north jer" into North Jerico,
 * Virginia. Those entries are also free and instant.
 *
 * HERE then supplies everything our curated list cannot: every US city, ZIP and
 * street address. Its results carry no coordinates (see hereAutocomplete), so
 * they are resolved only when one is actually chosen.
 */
export const GET = handler(async (req: Request) => {
  rateLimit(req, "suggest", 60);
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
      state: p.state ?? null,
      zip: p.postalCode ?? null,
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

/** Aliases, curated cities, ZIPs, regions and states -- our own vocabulary. */
function localSuggestions(q: string): Suggestion[] {
  const needle = q.toLowerCase().trim();
  const out: Suggestion[] = [];

  // A typed ZIP resolves offline: five digits are unambiguous and the mover's
  // own posts are written in them ("FL 33180"), so this must work with no key.
  if (/^\d{3,5}$/.test(needle)) {
    for (const c of CITIES) {
      if (out.length >= 4) break;
      if (c.zip && c.zip.startsWith(needle)) {
        out.push({
          label: `${c.city}, ${c.state} ${c.zip}`,
          detail: `${c.city}, ${c.state}`,
          lat: c.lat,
          lng: c.lng,
          precision: "zip",
          state: c.state,
          zip: c.zip,
        });
      }
    }
    if (needle.length === 5 && !out.length) {
      const s = stateForZip(needle);
      if (s) {
        out.push({
          label: `${needle}, ${s.abbr}`,
          detail: `ZIP ${needle} — ${s.name}`,
          lat: s.lat,
          lng: s.lng,
          precision: "zip",
          state: s.abbr,
          zip: needle,
        });
      }
    }
  }

  // Mover nicknames: "philly", "socal", "north jersey", "EWR".
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (out.length >= 6) break;
    if (!alias.startsWith(needle)) continue;

    if (target.city) {
      const c = CITIES.find(
        (x) => `${x.city}, ${x.state}`.toLowerCase() === target.city!.toLowerCase(),
      );
      if (c) {
        out.push({
          label: `${c.city}, ${c.state}`,
          detail: `"${alias}" — ${c.city}, ${c.state}`,
          lat: c.lat,
          lng: c.lng,
          precision: "city",
          state: c.state,
          zip: null,
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
          // A region spans states, so it names none of them.
          state: null,
          zip: null,
        });
      }
    }
  }

  for (const c of CITIES) {
    if (out.length >= 8) break;
    if (c.city.toLowerCase().startsWith(needle)) {
      out.push({
        label: `${c.city}, ${c.state}`,
        detail: `${c.city}, ${c.state}`,
        lat: c.lat,
        lng: c.lng,
        precision: "city",
        state: c.state,
        zip: null,
      });
    }
  }

  for (const s of STATES) {
    if (out.length >= 10) break;
    if (s.name.toLowerCase().startsWith(needle)) {
      out.push({
        label: s.name,
        detail: `${s.name} — anywhere in the state`,
        lat: s.lat,
        lng: s.lng,
        precision: "state",
        state: s.abbr,
        zip: null,
      });
    }
  }

  // De-duplicate by label, keeping first (ZIPs and aliases outrank plain states).
  const seen = new Set<string>();
  return out.filter((s) => {
    const k = s.label.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
