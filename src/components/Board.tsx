"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { LoadRow, LoadSearchResult } from "@/lib/loads/types";
import type { SessionUser } from "@/lib/auth";
import { EMPTY_FILTERS, FilterPanel, filtersToQuery, type Filters } from "./FilterPanel";
import { LoadList, LoadTable } from "./LoadViews";
import { LoadDetail } from "./LoadDetail";
import { EmptyState } from "./ui";
import { api } from "@/lib/basePath";

// MapLibre touches `window` on import, so it must never run on the server.
const LoadMap = dynamic(() => import("./LoadMap").then((m) => m.LoadMap), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-muted">Loading map…</div>,
});

type View = "list" | "table" | "map";

interface SavedSearch {
  id: number;
  name: string;
  params: { query?: string };
}

export function Board({ user, initialQuery }: { user: SessionUser; initialQuery: string }) {
  const [filters, setFilters] = useState<Filters>(() => hydrate(initialQuery));
  const [view, setView] = useState<View>("list");
  const [result, setResult] = useState<LoadSearchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<LoadRow | null>(null);
  const [bounds, setBounds] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Coordinates from a chosen suggestion. Cleared whenever the text is edited
  // by hand, so a stale pin can never outlive the name it belonged to.
  const [picked, setPicked] = useState<{
    origin?: { lat: number; lng: number };
    dest?: { lat: number; lng: number };
  }>({});

  // Free-text places are resolved server-side; the map needs the coordinates
  // too, so we read them back off the response rather than geocoding twice.
  const applied = result?.applied;
  const requestId = useRef(0);

  const queryString = useMemo(() => {
    const qs = filtersToQuery(filters, picked);
    return bounds ? `${qs}&${bounds}` : qs;
  }, [filters, bounds, picked]);

  const search = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(api(`/api/loads?${queryString}`));
      if (!res.ok) throw new Error((await res.json()).error ?? "Search failed");
      const data = (await res.json()) as LoadSearchResult;
      // Ignore responses that arrived out of order behind a newer request.
      if (id === requestId.current) setResult(data);
    } catch (err) {
      if (id === requestId.current) setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [queryString]);

  // Debounced so typing in the search box does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(search, 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    // Keep the URL in step so a search can be linked or reloaded. This writes a
    // real browser URL rather than a router path, so it needs the base path
    // applied by hand -- Next only rewrites <Link> and router navigations.
    const url = queryString ? api(`/loads?${queryString}`) : api("/loads");
    window.history.replaceState(null, "", url);
  }, [queryString]);

  useEffect(() => {
    fetch(api("/api/saved-searches"))
      .then((r) => r.json())
      .then((d) => setSaved(d.searches ?? []))
      .catch(() => {});
  }, []);

  const loads = result?.rows ?? [];
  const corridorMode = applied?.routeMode === "corridor";

  function locateMe() {
    if (!navigator.geolocation) {
      setError("This browser will not share a location.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setFilters((f) => ({
          ...f,
          origin: `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`,
        }));
      },
      () => {
        setLocating(false);
        setError(
          user.home_label
            ? `Location denied — using your home base, ${user.home_label}.`
            : "Location denied. Type a city or ZIP instead.",
        );
      },
      { timeout: 8000 },
    );
  }

  async function saveSearch() {
    const name = window.prompt("Name this search", suggestName(filters));
    if (!name) return;
    const res = await fetch(api("/api/saved-searches"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, query: queryString }),
    });
    if (res.ok) {
      const list = await (await fetch(api("/api/saved-searches"))).json();
      setSaved(list.searches ?? []);
    }
  }

  return (
    <div className="flex h-[calc(100vh-49px)]">
      <FilterPanel
        value={filters}
        onChange={(next) => {
          setBounds(null); // a filter change supersedes a map-area search
          setPicked((p) => ({
            origin: next.origin === filters.origin ? p.origin : undefined,
            dest: next.dest === filters.dest ? p.dest : undefined,
          }));
          setFilters(next);
        }}
        onPickOrigin={(p) => setPicked((prev) => ({ ...prev, origin: { lat: p.lat, lng: p.lng } }))}
        onPickDest={(p) => setPicked((prev) => ({ ...prev, dest: { lat: p.lat, lng: p.lng } }))}
        onLocateMe={locateMe}
        locating={locating}
        onSave={saveSearch}
        resultCount={result?.total ?? 0}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="bg-surface flex flex-wrap items-center gap-3 border-b border-border px-4 py-2">
          <div className="text-[13px]">
            {loading ? (
              <span className="text-muted">Searching…</span>
            ) : (
              <>
                <span className="text-[15px] font-bold">{result?.total ?? 0}</span>{" "}
                <span className="text-muted">
                  {result?.total === 1 ? "load" : "loads"}
                  {corridorMode ? " along your route" : ""}
                </span>
              </>
            )}
          </div>

          {applied?.origin && (
            <span className="chip" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
              {corridorMode ? "from" : "near"} {applied.origin.label ?? "your point"}
              {!corridorMode && applied.radiusMiles ? ` · ${applied.radiusMiles} mi` : ""}
            </span>
          )}
          {applied?.destination && (
            <span className="chip" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
              to {applied.destination.label ?? "your point"}
              {corridorMode && applied.corridorMiles ? ` · ±${applied.corridorMiles} mi` : ""}
            </span>
          )}
          {bounds && (
            <button className="chip cursor-pointer" onClick={() => setBounds(null)} style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>
              map area ✕
            </button>
          )}

          <div className="ml-auto flex overflow-hidden rounded-md border border-border-strong">
            {(["list", "table", "map"] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className="px-3 py-1.5 text-[13px] font-semibold capitalize"
                style={
                  view === v
                    ? { background: "var(--accent)", color: "#fff" }
                    : { background: "var(--surface)", color: "var(--muted)" }
                }
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        {saved.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2 px-4 py-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Saved
            </span>
            {saved.map((s) => (
              <button
                key={s.id}
                className="chip cursor-pointer"
                style={{ background: "var(--surface)", color: "var(--accent)" }}
                onClick={() => {
                  setBounds(null);
                  setFilters(hydrate(s.params?.query ?? ""));
                }}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}

        {error && (
          <div
            className="border-b px-4 py-2 text-[13px]"
            style={{ background: "var(--warn-soft)", color: "var(--warn)", borderColor: "var(--border)" }}
          >
            {error}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {!loading && loads.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="No loads match this search"
                hint={
                  corridorMode
                    ? "Try widening the corridor, or switch back to endpoint matching."
                    : "Try a wider radius, a different date, or clear a filter or two."
                }
              />
            </div>
          ) : view === "list" ? (
            <LoadList loads={loads} onSelect={setSelected} selectedId={selected?.id} />
          ) : view === "table" ? (
            <LoadTable loads={loads} onSelect={setSelected} showDetour={corridorMode} />
          ) : (
            <div className="h-full">
              <LoadMap
                loads={loads}
                onSelect={setSelected}
                onSearchArea={(b) =>
                  setBounds(
                    new URLSearchParams({
                      minLat: String(b.minLat),
                      maxLat: String(b.maxLat),
                      minLng: String(b.minLng),
                      maxLng: String(b.maxLng),
                    }).toString(),
                  )
                }
                route={
                  corridorMode && applied?.origin && applied?.destination
                    ? {
                        origin: [applied.origin.lng, applied.origin.lat],
                        destination: [applied.destination.lng, applied.destination.lat],
                        originLabel: applied.origin.label,
                        destinationLabel: applied.destination.label,
                        destinationPrecision: applied.destination.precision,
                      }
                    : null
                }
              />
            </div>
          )}
        </div>
      </main>

      {selected && (
        <LoadDetail
          load={selected}
          onClose={() => setSelected(null)}
          canManage={user.role !== "carrier"}
          onStatusChanged={search}
        />
      )}
    </div>
  );
}

/** Query string -> filter state, so saved searches and links restore exactly. */
function hydrate(queryString: string): Filters {
  const sp = new URLSearchParams(queryString);
  const f = { ...EMPTY_FILTERS };
  const get = (k: string, fallback: string) => sp.get(k) ?? fallback;

  f.date = get("date", "any");
  f.from = get("from", "");
  f.to = get("to", "");
  f.q = get("q", "");
  f.origin = get("origin", "");
  f.radius = get("radius", "50");
  f.dest = get("dest", "");
  f.destRadius = get("destRadius", "100");
  f.routeMode = sp.get("routeMode") === "corridor" ? "corridor" : "endpoints";
  f.corridor = get("corridor", "75");
  f.pickupState = get("pickupState", "");
  f.deliveryState = get("deliveryState", "");
  f.pickupZip = get("pickupZip", "");
  f.deliveryZip = get("deliveryZip", "");
  f.type = get("type", "");
  f.sort = get("sort", "newest");
  f.status = get("status", "available");
  return f;
}

function suggestName(f: Filters): string {
  const bits: string[] = [];
  if (f.origin) bits.push(f.origin);
  if (f.dest) bits.push(`to ${f.dest}`);
  if (f.date !== "any") bits.push(f.date);
  return bits.join(" ") || "My search";
}
