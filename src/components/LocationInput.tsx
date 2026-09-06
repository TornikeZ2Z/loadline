"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/basePath";

export interface PlaceSuggestion {
  label: string;
  detail: string;
  /** Null on HERE results until resolved. */
  lat: number | null;
  lng: number | null;
  precision: string;
  state: string | null;
  zip: string | null;
  hereId?: string;
}

/**
 * A suggestion once its coordinates are known.
 *
 * `state`, `city` and `zip` ride along because the callers need them, not just
 * the pin: the post form fills the delivery/pickup state and ZIP from a picked
 * place, the location slots store the state for the "Near you: FL" hint, and
 * the admin console turns the same three fields into a learned place.
 */
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
 * Place input with a type-ahead dropdown.
 *
 * Backed by HERE autocomplete through our own API route, falling back to the
 * offline gazetteer when no key is configured -- so the control behaves the
 * same either way, just with a smaller catalogue.
 *
 * Picking a suggestion reports coordinates as well as text. That matters: it
 * removes a second geocode on the server and, more importantly, removes the
 * ambiguity of re-resolving a string the user already disambiguated by hand.
 */
export function LocationInput({
  value,
  onChange,
  onPick,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (text: string) => void;
  onPick?: (place: ResolvedPlace) => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Only the newest response may update the list; slow ones must not overwrite.
  const requestId = useRef(0);
  // Suppress the fetch that a programmatic value change would otherwise trigger.
  const skipNextLookup = useRef(false);

  useEffect(() => {
    if (skipNextLookup.current) {
      skipNextLookup.current = false;
      return;
    }
    const q = value.trim();
    if (q.length < 2) {
      setSuggestions([]);
      return;
    }

    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(api(`/api/places/suggest?q=${encodeURIComponent(q)}`));
        const json = (await res.json()) as { suggestions?: PlaceSuggestion[] };
        if (id === requestId.current) {
          setSuggestions(json.suggestions ?? []);
          setActive(-1);
        }
      } catch {
        if (id === requestId.current) setSuggestions([]);
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    }, 220);

    return () => clearTimeout(timer);
  }, [value]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  async function pick(s: PlaceSuggestion) {
    skipNextLookup.current = true;
    onChange(s.label);
    setOpen(false);
    setSuggestions([]);
    if (!onPick) return;

    // A local row already carries everything; only the city has to be teased
    // out of the label, since the gazetteer writes "Miami, FL".
    if (s.lat != null && s.lng != null) {
      onPick({
        label: s.label,
        lat: s.lat,
        lng: s.lng,
        precision: s.precision,
        state: s.state,
        city: cityFromLabel(s.label),
        zip: s.zip,
      });
      return;
    }

    // HERE results arrive without coordinates; resolve the chosen one.
    setLoading(true);
    try {
      const res = await fetch(api("/api/places/resolve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hereId: s.hereId, label: s.label }),
      });
      if (res.ok) {
        const j = (await res.json()) as ResolvedPlace;
        onPick({
          label: s.label,
          lat: j.lat,
          lng: j.lng,
          // The suggestion's own precision wins. HERE's autocomplete already
          // classified the row (locality, postalCode, houseNumber); the resolve
          // route only knows it looked an id up, so letting it answer would
          // stamp "address" on a city centroid -- the exact overclaim the
          // approximate-route styling exists to prevent.
          precision: s.precision || j.precision,
          state: j.state ?? s.state,
          city: j.city ?? cityFromLabel(s.label),
          zip: j.zip ?? s.zip,
        });
      }
    } finally {
      setLoading(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || !suggestions.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      void pick(suggestions[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={box} className="relative">
      <input
        className="field"
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        autoComplete="off"
      />

      {open && (suggestions.length > 0 || loading) && (
        <ul
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-[260px] overflow-y-auto rounded-lg border shadow-lg"
          style={{ background: "var(--surface)", borderColor: "var(--border-strong)" }}
        >
          {loading && suggestions.length === 0 && (
            <li className="px-3 py-2 text-(length:--fs-sm) text-muted">Searching…</li>
          )}
          {suggestions.map((s, i) => (
            <li key={`${s.label}-${s.lat}-${i}`}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => void pick(s)}
                className="block w-full px-3 py-2 text-left"
                style={i === active ? { background: "var(--accent-soft)" } : undefined}
              >
                <span className="block text-(length:--fs-base) font-medium">{s.label}</span>
                {s.detail && s.detail !== s.label && (
                  <span className="block truncate text-(length:--fs-xs) text-muted">{s.detail}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "Kearny, NJ 07032" -> "Kearny". A label with no comma names no city. */
function cityFromLabel(label: string): string | null {
  const head = label.split(",")[0]?.trim();
  return head && head !== label.trim() ? head : null;
}
