"use client";

import { useState } from "react";
import { CORRIDOR_OPTIONS, LOAD_TYPES, RADIUS_OPTIONS } from "@/lib/loads/constants";
import { LocationInput, type PlaceSuggestion } from "./LocationInput";
import { STATES } from "@/lib/geo/states";

export interface Filters {
  date: string;
  from: string;
  to: string;
  origin: string;
  radius: string;
  dest: string;
  destRadius: string;
  routeMode: "endpoints" | "corridor";
  corridor: string;
  pickupState: string;
  deliveryState: string;
  pickupZip: string;
  deliveryZip: string;
  type: string;
  q: string;
  sort: string;
  status: string;
}

export const EMPTY_FILTERS: Filters = {
  date: "any",
  from: "",
  to: "",
  origin: "",
  radius: "50",
  dest: "",
  destRadius: "100",
  routeMode: "endpoints",
  corridor: "75",
  pickupState: "",
  deliveryState: "",
  pickupZip: "",
  deliveryZip: "",
  type: "",
  q: "",
  sort: "newest",
  status: "available",
};

const DATE_PRESETS: Array<[string, string]> = [
  ["any", "Any date"],
  ["today", "Today"],
  ["tomorrow", "Tomorrow"],
  ["next3", "Next 3 days"],
  ["week", "This week"],
  ["custom", "Custom range"],
];

export function FilterPanel({
  value,
  onChange,
  onLocateMe,
  locating,
  onSave,
  resultCount,
  onPickOrigin,
  onPickDest,
}: {
  value: Filters;
  onChange: (next: Filters) => void;
  onLocateMe: () => void;
  locating: boolean;
  onSave: () => void;
  resultCount: number;
  /** Fired when a suggestion is chosen, so coordinates skip a re-geocode. */
  onPickOrigin?: (place: PlaceSuggestion) => void;
  onPickDest?: (place: PlaceSuggestion) => void;
}) {
  const [openSections, setOpenSections] = useState({ lane: true, detail: false });
  const set = <K extends keyof Filters>(key: K, v: Filters[K]) => onChange({ ...value, [key]: v });

  const corridorOn = value.routeMode === "corridor";

  return (
    <aside className="bg-surface border-r border-border w-[300px] shrink-0 overflow-y-auto">
      <div className="space-y-5 p-4">
        <div>
          <label className="label">Search</label>
          <input
            className="field"
            placeholder="City, contact, notes…"
            value={value.q}
            onChange={(e) => set("q", e.target.value)}
          />
        </div>

        {/* ---------------- when ---------------- */}
        <section>
          <label className="label">Pickup date</label>
          <div className="flex flex-wrap gap-1.5">
            {DATE_PRESETS.map(([key, label]) => (
              <button
                key={key}
                onClick={() => set("date", key)}
                className="chip cursor-pointer"
                style={
                  value.date === key
                    ? { background: "var(--accent)", color: "#fff" }
                    : { background: "var(--surface-2)", color: "var(--muted)" }
                }
              >
                {label}
              </button>
            ))}
          </div>
          {value.date === "custom" && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <input
                type="date"
                className="field"
                value={value.from}
                onChange={(e) => set("from", e.target.value)}
              />
              <input
                type="date"
                className="field"
                value={value.to}
                onChange={(e) => set("to", e.target.value)}
              />
            </div>
          )}
        </section>

        {/* ---------------- where ---------------- */}
        <section className="border-t border-border pt-4">
          <div className="mb-3 flex items-center justify-between">
            <label className="label mb-0">Route</label>
            <button
              className="chip cursor-pointer"
              onClick={() => set("routeMode", corridorOn ? "endpoints" : "corridor")}
              style={
                corridorOn
                  ? { background: "var(--accent)", color: "#fff" }
                  : { background: "var(--surface-2)", color: "var(--muted)" }
              }
              title="Corridor mode also finds loads along the way, not just at the endpoints"
            >
              {corridorOn ? "Along my route" : "Endpoints only"}
            </button>
          </div>

          <label className="label">Pick up near</label>
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <LocationInput
                ariaLabel="Pick up near"
                placeholder="Start typing a city, ZIP or address…"
                value={value.origin}
                onChange={(text) => set("origin", text)}
                onPick={(p) => onPickOrigin?.(p)}
              />
            </div>
            <button
              className="btn shrink-0 px-2"
              onClick={onLocateMe}
              disabled={locating}
              title="Use my current location"
            >
              {locating ? "…" : "◎"}
            </button>
          </div>

          {!corridorOn && (
            <div className="mt-2">
              <select
                className="field"
                value={value.radius}
                onChange={(e) => set("radius", e.target.value)}
              >
                <option value="">Any distance</option>
                {RADIUS_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    within {r} miles
                  </option>
                ))}
              </select>
            </div>
          )}

          <label className="label mt-3">Deliver to</label>
          <LocationInput
            ariaLabel="Deliver to"
            placeholder="Atlanta GA, 33101, or a whole state…"
            value={value.dest}
            onChange={(text) => set("dest", text)}
            onPick={(p) => onPickDest?.(p)}
          />

          {corridorOn ? (
            <div className="mt-2">
              <select
                className="field"
                value={value.corridor}
                onChange={(e) => set("corridor", e.target.value)}
              >
                {CORRIDOR_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    up to {r} mi off my route
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-[11px] leading-snug text-muted">
                Finds loads along the way and ranks them by the extra miles they cost you, not just
                loads that run the whole lane.
              </p>
            </div>
          ) : (
            <div className="mt-2">
              <select
                className="field"
                value={value.destRadius}
                onChange={(e) => set("destRadius", e.target.value)}
              >
                <option value="">Any distance</option>
                {RADIUS_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    within {r} miles
                  </option>
                ))}
              </select>
            </div>
          )}
        </section>

        {/* ---------------- states / zips ---------------- */}
        <section className="border-t border-border pt-4">
          <button
            className="label flex w-full items-center justify-between"
            onClick={() => setOpenSections((s) => ({ ...s, lane: !s.lane }))}
          >
            States &amp; ZIP codes
            <span>{openSections.lane ? "−" : "+"}</span>
          </button>
          {openSections.lane && (
            <div className="mt-1 grid grid-cols-2 gap-2">
              <select
                className="field"
                value={value.pickupState}
                onChange={(e) => set("pickupState", e.target.value)}
              >
                <option value="">Any pickup state</option>
                {STATES.map((s) => (
                  <option key={s.abbr} value={s.abbr}>
                    {s.abbr} — {s.name}
                  </option>
                ))}
              </select>
              <select
                className="field"
                value={value.deliveryState}
                onChange={(e) => set("deliveryState", e.target.value)}
              >
                <option value="">Any delivery state</option>
                {STATES.map((s) => (
                  <option key={s.abbr} value={s.abbr}>
                    {s.abbr} — {s.name}
                  </option>
                ))}
              </select>
              <input
                className="field"
                placeholder="Pickup ZIP"
                value={value.pickupZip}
                onChange={(e) => set("pickupZip", e.target.value)}
              />
              <input
                className="field"
                placeholder="Delivery ZIP"
                value={value.deliveryZip}
                onChange={(e) => set("deliveryZip", e.target.value)}
              />
              <p className="col-span-2 text-[11px] text-muted">
                Partial ZIPs work: <span className="nums">070</span> matches all of north Jersey.
              </p>
            </div>
          )}
        </section>

        {/* ---------------- equipment / status ---------------- */}
        <section className="border-t border-border pt-4">
          <button
            className="label flex w-full items-center justify-between"
            onClick={() => setOpenSections((s) => ({ ...s, detail: !s.detail }))}
          >
            Equipment &amp; status
            <span>{openSections.detail ? "−" : "+"}</span>
          </button>
          {openSections.detail && (
            <div className="mt-1 space-y-2">
              <select className="field" value={value.type} onChange={(e) => set("type", e.target.value)}>
                <option value="">Any equipment</option>
                {LOAD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <select
                className="field"
                value={value.status}
                onChange={(e) => set("status", e.target.value)}
              >
                <option value="available">Available only</option>
                <option value="available,pending">Available &amp; pending</option>
                <option value="available,pending,taken,expired">Everything</option>
              </select>
            </div>
          )}
        </section>

        <section className="border-t border-border pt-4">
          <label className="label">Sort by</label>
          <select className="field" value={value.sort} onChange={(e) => set("sort", e.target.value)}>
            <option value="newest">Newest first</option>
            <option value="pickup_date">Pickup date</option>
            <option value="distance">Closest to me</option>
            <option value="trip_miles">Longest trip</option>
            <option value="rate">Highest rate</option>
          </select>
        </section>

        <div className="flex gap-2 border-t border-border pt-4">
          <button className="btn flex-1" onClick={() => onChange({ ...EMPTY_FILTERS })}>
            Clear
          </button>
          <button className="btn btn-primary flex-1" onClick={onSave} disabled={!resultCount}>
            Save search
          </button>
        </div>
      </div>
    </aside>
  );
}

/** Filters -> query string for /api/loads. */
export function filtersToQuery(
  f: Filters,
  resolved: { origin?: { lat: number; lng: number }; dest?: { lat: number; lng: number } },
): string {
  const sp = new URLSearchParams();
  const put = (k: string, v: string | number | undefined | null) => {
    if (v === undefined || v === null || v === "") return;
    sp.set(k, String(v));
  };

  if (f.date !== "any") put("date", f.date);
  if (f.date === "custom") {
    put("from", f.from);
    put("to", f.to);
  }
  put("q", f.q);
  put("origin", f.origin);
  put("originLat", resolved.origin?.lat);
  put("originLng", resolved.origin?.lng);
  put("dest", f.dest);
  put("destLat", resolved.dest?.lat);
  put("destLng", resolved.dest?.lng);

  if (f.routeMode === "corridor") {
    put("routeMode", "corridor");
    put("corridor", f.corridor);
  } else {
    if (f.origin) put("radius", f.radius);
    if (f.dest) put("destRadius", f.destRadius);
  }

  put("pickupState", f.pickupState);
  put("deliveryState", f.deliveryState);
  put("pickupZip", f.pickupZip);
  put("deliveryZip", f.deliveryZip);
  put("type", f.type);
  put("sort", f.sort);
  put("status", f.status);
  return sp.toString();
}
