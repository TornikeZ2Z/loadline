"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { LoadRow } from "@/lib/loads/types";

/**
 * Pickup pins, clustered by MapLibre so a metro with 40 loads reads as one
 * number instead of a pile of overlapping dots.
 *
 * "Search this area" is the important interaction here: a driver browsing the
 * map is asking a geographic question, and making them translate it back into
 * a city name would defeat the point.
 *
 * Pinned to maplibre-gl v5 deliberately: v6 resolves its web worker through
 * `import.meta.url`, which the Next dev bundler does not serve as a real asset.
 * The worker then never starts, and the failure mode is a blank canvas with no
 * useful error. v5 inlines the worker and works under both bundlers.
 */
export function LoadMap({
  loads,
  onSelect,
  onSearchArea,
  route,
}: {
  loads: LoadRow[];
  onSelect: (l: LoadRow) => void;
  onSearchArea: (bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number }) => void;
  route?: { origin: [number, number]; destination: [number, number] } | null;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const [moved, setMoved] = useState(false);
  // Hold the latest callback without making it an effect dependency, so the map
  // is built once rather than torn down on every parent render.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // --- init ---------------------------------------------------------------
  useEffect(() => {
    if (!container.current || map.current) return;

    const instance = new maplibregl.Map({
      container: container.current,
      // Raster OSM: no API key and no account needed. Swap in a vector style
      // plus a token when you want production cartography.
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
          },
        },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      },
      center: [-77.5, 39.5],
      zoom: 5.2,
    });
    map.current = instance;

    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    // Style and tile failures are otherwise silent -- the map simply renders an
    // empty canvas -- so surface them.
    instance.on("error", (e) => console.error("[LoadMap]", e.error?.message ?? e));

    instance.on("load", () => {
      instance.addSource("loads", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        cluster: true,
        clusterRadius: 45,
        clusterMaxZoom: 11,
      });

      // Route source added before the pin layers so the line draws beneath them.
      instance.addSource("route", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      instance.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        paint: {
          "line-color": "#1d4ed8",
          "line-width": 3,
          "line-dasharray": [2, 1.5],
          "line-opacity": 0.55,
        },
      });

      instance.addLayer({
        id: "clusters",
        type: "circle",
        source: "loads",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#1d4ed8",
          "circle-opacity": 0.9,
          "circle-radius": ["step", ["get", "point_count"], 16, 5, 21, 15, 27],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });
      instance.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "loads",
        filter: ["has", "point_count"],
        layout: { "text-field": "{point_count_abbreviated}", "text-size": 12 },
        paint: { "text-color": "#ffffff" },
      });
      instance.addLayer({
        id: "pin",
        type: "circle",
        source: "loads",
        filter: ["!", ["has", "point_count"]],
        paint: {
          // Loads placed only at a state or region centroid are drawn in the
          // warning colour, so the map never implies precision it does not have.
          "circle-color": ["case", ["get", "approximate"], "#b45309", "#1d4ed8"],
          "circle-radius": 7,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });

      instance.on("click", "clusters", (e: MapMouseEvent) => {
        const feature = instance.queryRenderedFeatures(e.point, { layers: ["clusters"] })[0];
        if (!feature) return;
        const source = instance.getSource("loads") as GeoJSONSource;
        source
          .getClusterExpansionZoom(feature.properties.cluster_id as number)
          .then((zoom) =>
            instance.easeTo({
              center: (feature.geometry as { coordinates: [number, number] }).coordinates,
              zoom,
            }),
          );
      });

      instance.on("click", "pin", (e: MapMouseEvent) => {
        const feature = instance.queryRenderedFeatures(e.point, { layers: ["pin"] })[0];
        const raw = feature?.properties?.load;
        if (typeof raw === "string") onSelectRef.current(JSON.parse(raw) as LoadRow);
      });

      for (const layer of ["clusters", "pin"]) {
        instance.on("mouseenter", layer, () => (instance.getCanvas().style.cursor = "pointer"));
        instance.on("mouseleave", layer, () => (instance.getCanvas().style.cursor = ""));
      }

      // Only offer "search this area" once the user has actually moved the map.
      instance.on("moveend", () => setMoved(true));
      setReady(true);
    });

    return () => {
      instance.remove();
      map.current = null;
      setReady(false);
    };
  }, []);

  // --- pins ---------------------------------------------------------------
  useEffect(() => {
    const source = map.current?.getSource("loads") as GeoJSONSource | undefined;
    if (!ready || !source) return;

    source.setData({
      type: "FeatureCollection",
      features: loads
        .filter((l) => l.pickup_lat != null && l.pickup_lng != null)
        .map((l) => ({
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: [l.pickup_lng!, l.pickup_lat!] },
          properties: {
            approximate: l.pickup_precision === "state" || l.pickup_precision === "region",
            load: JSON.stringify(l),
          },
        })),
    });
  }, [loads, ready]);

  // --- route overlay ------------------------------------------------------
  useEffect(() => {
    const instance = map.current;
    const source = instance?.getSource("route") as GeoJSONSource | undefined;
    if (!ready || !instance || !source) return;

    source.setData(
      route
        ? {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: {},
                geometry: { type: "LineString", coordinates: [route.origin, route.destination] },
              },
            ],
          }
        : { type: "FeatureCollection", features: [] },
    );

    if (route) {
      instance.fitBounds(
        [
          [
            Math.min(route.origin[0], route.destination[0]),
            Math.min(route.origin[1], route.destination[1]),
          ],
          [
            Math.max(route.origin[0], route.destination[0]),
            Math.max(route.origin[1], route.destination[1]),
          ],
        ],
        { padding: 70, duration: 700 },
      );
    }
  }, [route, ready]);

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="h-full w-full" />

      {moved && (
        <button
          className="btn btn-primary absolute left-1/2 top-3 -translate-x-1/2 shadow-md"
          onClick={() => {
            const b = map.current?.getBounds();
            if (!b) return;
            setMoved(false);
            onSearchArea({
              minLat: b.getSouth(),
              maxLat: b.getNorth(),
              minLng: b.getWest(),
              maxLng: b.getEast(),
            });
          }}
        >
          Search this area
        </button>
      )}

      <div className="absolute bottom-6 left-3 rounded-md border border-border bg-surface/90 px-2.5 py-1.5 text-[11px] text-muted">
        <span
          className="mr-2 inline-block h-2 w-2 rounded-full align-middle"
          style={{ background: "#1d4ed8" }}
        />
        exact pickup
        <span
          className="mr-2 ml-3 inline-block h-2 w-2 rounded-full align-middle"
          style={{ background: "#b45309" }}
        />
        approximate
      </div>
    </div>
  );
}
