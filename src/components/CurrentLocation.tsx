"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/basePath";
import {
  OPEN_LOCATION_EVENT,
  clearLocation,
  useViewerLocation,
  writeLocation,
  type LocationSlot,
} from "@/lib/location";
import { LocationInput, type ResolvedPlace } from "./LocationInput";

/**
 * "Where are you?" -- set once, used everywhere, stored nowhere but this browser.
 *
 * This is the input the whole board hangs off: it sorts jobs by distance to
 * pickup, puts "142 mi from you" on the cards and drive time in the detail. It
 * lives in the header rather than a settings page because a mover's answer
 * changes during the day, and it needs no account because the board needs no
 * account.
 *
 * Two slots. **Current** is where you are (or will be when you're empty).
 * **Home** is where you're heading back to -- it only pre-selects the delivery
 * filter and powers the Toward-home corridor, which is why it is a separate,
 * quieter pill rather than a second required field.
 */
export function CurrentLocation() {
  const { current, home, hydrated } = useViewerLocation();
  const [open, setOpen] = useState<LocationSlot | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  // The Board's first-visit nudge and the detail's "From you" tile ask for this
  // popover by event, so nothing of ours has to be mounted inside the map area.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const slot = (e as CustomEvent<{ slot?: LocationSlot }>).detail?.slot;
      setOpen(slot === "home" ? "home" : "current");
    };
    window.addEventListener(OPEN_LOCATION_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_LOCATION_EVENT, onOpen);
  }, []);

  return (
    <div ref={box} className="relative flex items-center gap-[var(--sp-2)]">
      <button
        type="button"
        className="pill"
        onClick={() => setOpen((s) => (s === "current" ? null : "current"))}
        title="Where you are — sorts the board by distance"
        style={
          hydrated && !current
            ? { borderColor: "var(--accent)", color: "var(--accent)" }
            : undefined
        }
      >
        ◎ {current ? `Near ${current.label}` : "Where are you?"} ▾
      </button>

      <button
        type="button"
        className="pill"
        onClick={() => setOpen((s) => (s === "home" ? null : "home"))}
        title="Where you're heading back to"
      >
        ⌂ {home ? `Home ${home.state ?? home.label}` : "Home"} ▾
      </button>

      {open && <LocationPopover slot={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function LocationPopover({ slot, onClose }: { slot: LocationSlot; onClose: () => void }) {
  const { current, home } = useViewerLocation();
  const stored = slot === "current" ? current : home;

  const [text, setText] = useState(stored?.label ?? "");
  const [picked, setPicked] = useState<ResolvedPlace | null>(null);
  const [truck, setTruck] = useState(stored?.truckCf ? String(stored.truckCf) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(
    (place: ResolvedPlace) => {
      writeLocation(slot, {
        label: place.label,
        lat: place.lat,
        lng: place.lng,
        state: place.state,
        precision: place.precision,
        // A truck size belongs to the driver, not to the place they're heading
        // back to -- the home slot never carries one.
        truckCf: slot === "current" && truck.trim() ? Number(truck) || null : null,
      });
      onClose();
    },
    [slot, truck, onClose],
  );

  /** Resolve whatever is in the box: a picked suggestion, or the free text. */
  async function saveTyped() {
    if (picked) return save(picked);

    const label = text.trim();
    if (!label) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(api("/api/places/resolve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) {
        setError("We could not find that place — try a city or ZIP.");
        return;
      }
      save((await res.json()) as ResolvedPlace);
    } finally {
      setBusy(false);
    }
  }

  function useGps() {
    if (!navigator.geolocation) {
      setError("This browser will not share a location.");
      return;
    }
    setBusy(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          // The browser's coordinates are what sort the board; the round trip
          // only buys a name a person recognises.
          const res = await fetch(api("/api/places/resolve"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
          });
          if (res.ok) save((await res.json()) as ResolvedPlace);
          else setError("Could not name that location — type a place instead.");
        } finally {
          setBusy(false);
        }
      },
      () => {
        setBusy(false);
        setError("Location permission denied — type a place instead.");
      },
      { timeout: 8000 },
    );
  }

  const isCurrent = slot === "current";

  return (
    <div
      className="popover absolute right-0 top-full z-50 mt-2 w-[340px] max-w-[calc(100vw-2rem)] p-[var(--sp-3)]"
      style={{ background: "var(--surface)", borderColor: "var(--border-strong)" }}
    >
      <div className="label">{isCurrent ? "Where are you?" : "Where are you heading back to?"}</div>
      <p className="mb-2 text-[var(--fs-xs)]" style={{ color: "var(--muted)" }}>
        {isCurrent
          ? "Where will you be when you're empty? Jobs get sorted by distance to pickup and show drive time."
          : "A state is fine — it pre-selects the delivery filter and powers Toward home."}
      </p>

      <LocationInput
        ariaLabel={isCurrent ? "Your current location" : "Where you are heading back to"}
        placeholder="City, ZIP or address…"
        value={text}
        onChange={(t) => {
          setText(t);
          setPicked(null);
        }}
        onPick={(p) => {
          setPicked(p);
          setText(p.label);
        }}
      />

      {isCurrent && (
        <div className="mt-2">
          <label className="label" htmlFor="truck-cf">
            Truck size (cf) — optional
          </label>
          <input
            id="truck-cf"
            className="field"
            inputMode="numeric"
            placeholder="1500"
            value={truck}
            onChange={(e) => setTruck(e.target.value.replace(/[^\d]/g, ""))}
          />
        </div>
      )}

      {error && (
        <p className="mt-2 text-[var(--fs-xs)]" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}

      <div className="mt-3 flex gap-[var(--sp-2)]">
        <button
          type="button"
          className="btn btn-primary flex-1"
          disabled={busy || (!picked && !text.trim())}
          onClick={() => void saveTyped()}
        >
          {busy ? "One moment…" : "Save"}
        </button>
        <button type="button" className="btn" onClick={useGps} disabled={busy} title="Use GPS">
          ◎ Use GPS
        </button>
      </div>

      {stored && (
        <button
          type="button"
          className="btn btn-ghost btn-sm mt-2"
          onClick={() => {
            clearLocation(slot);
            onClose();
          }}
        >
          Clear
        </button>
      )}

      <p className="mt-3 text-[11px]" style={{ color: "var(--muted-2)" }}>
        Stays on this device. Sent only with your searches.
      </p>
    </div>
  );
}
