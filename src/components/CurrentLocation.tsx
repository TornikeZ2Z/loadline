"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/basePath";
import { LocationInput, type PlaceSuggestion } from "./LocationInput";

/**
 * "Where are you?" -- set once, used everywhere.
 *
 * This is the input the whole product hangs off: it drives loads-near-me, the
 * distance column, the default radius search and the drive time on a load. It
 * lives in the header rather than buried in a settings page because a driver's
 * answer changes during the day.
 */
export function CurrentLocation({
  label,
  role,
}: {
  label: string | null;
  role: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(label ?? "");
  const [picked, setPicked] = useState<PlaceSuggestion | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  async function save(body: { label?: string; lat?: number; lng?: number }) {
    setBusy(true);
    setError(null);
    const res = await fetch(api("/api/me/location"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    setBusy(false);

    if (!res.ok) {
      setError(json.error ?? "Could not save that location");
      return;
    }
    setText(json.label ?? "");
    setPicked(null);
    setOpen(false);
    // Server components render the distance columns, so re-fetch them.
    router.refresh();
  }

  function useGps() {
    if (!navigator.geolocation) {
      setError("This browser will not share a location.");
      return;
    }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => save({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {
        setBusy(false);
        setError("Location permission denied — type a place instead.");
      },
      { timeout: 8000 },
    );
  }

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="block text-right leading-tight"
        title="Set your current location"
      >
        <span className="block text-[11px] capitalize text-muted">
          {role}
          {" · "}
          <span style={{ color: "var(--accent)" }}>
            {label ?? "set your location"}
            {" ▾"}
          </span>
        </span>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-2 w-[320px] rounded-lg border p-3 shadow-xl"
          style={{ background: "var(--surface)", borderColor: "var(--border-strong)" }}
        >
          <div className="label">Where are you now?</div>
          <p className="mb-2 text-[11px] text-muted">
            Sets &ldquo;loads near me&rdquo;, the distance column and drive times.
          </p>

          <LocationInput
            ariaLabel="Your current location"
            placeholder="City, ZIP or address…"
            value={text}
            onChange={(t) => {
              setText(t);
              setPicked(null);
            }}
            onPick={(p) => setPicked(p)}
          />

          {error && (
            <p className="mt-2 text-[11px]" style={{ color: "var(--danger)" }}>
              {error}
            </p>
          )}

          <div className="mt-3 flex gap-2">
            <button
              className="btn btn-primary flex-1"
              disabled={busy || !text.trim()}
              onClick={() =>
                save(picked ? { label: picked.label, lat: picked.lat, lng: picked.lng } : { label: text })
              }
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button className="btn" onClick={useGps} disabled={busy} title="Use GPS">
              ◎ GPS
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
