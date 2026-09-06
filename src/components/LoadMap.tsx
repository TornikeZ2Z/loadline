"use client";

/**
 * The board's map. Every job is a route, and nothing else is drawn.
 *
 * A pin says "a job exists here". A mover already knows jobs exist near them --
 * what they need is direction: is anyone leaving my area for the state I want
 * to be in tonight? So each job is an arc from pickup to delivery with
 * direction chevrons, thickened by cubic feet so a 2,000 cf load is visibly
 * worth more than a 200 cf one, and fanned onto one of five deterministic sides
 * so eight jobs out of the same warehouse stay legible instead of collapsing
 * into a single stroke.
 *
 * Consequences worth knowing:
 *  - There is no clustering. Lines cannot be clustered without destroying the
 *    one thing they carry. Low-zoom legibility comes from the state-total
 *    pills, the zoom-interpolated widths and the fan-out instead.
 *  - A destination the geocoder could not pin down still draws, dashed and
 *    amber, to its state centroid. Dropping it would hide real inventory; a
 *    solid line to a centroid would be a lie.
 *  - Colours are read once from the CSS custom properties through
 *    getComputedStyle: MapLibre paint expressions cannot take var(), and this
 *    is the only file in the components tree allowed a hex fallback.
 *
 * maplibre-gl stays on v5 on purpose: v6 resolves its worker through
 * import.meta.url, which the Next bundler does not serve as a real asset, and
 * the failure mode is a blank canvas with no error.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type MapLayerMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Feature, FeatureCollection, LineString, Point as GeoPoint } from "geojson";
import type { BoundsInput, LoadStatus, LoadSummary } from "@/lib/loads/types";
import type { PublicLoadRow } from "@/lib/loads/publicView";
import type { StoredLocation } from "@/lib/location";
import { STATE_BY_ABBR } from "@/lib/geo/states";
import { arcPoints } from "@/lib/geo/arc";
import { formatCf, jobSummary, truckLine } from "@/lib/loads/present";

export interface LoadMapProps {
  jobs: PublicLoadRow[];
  selectedId: number | null;
  hoveredId: number | null;
  onSelect(id: number | null): void;
  onHover(id: number | null): void;
  /** A state-total pill was clicked. */
  onStateClick(st: string): void;
  searchAsMove: boolean;
  onSearchAsMoveChange(v: boolean): void;
  onBoundsChange(b: BoundsInput | null): void;
  viewer: StoredLocation | null;
  home: StoredLocation | null;
  towardHome: boolean;
  /** Changes only when the filter set changes, which is the only time we refit. */
  fitKey: string;
  /** Height of the mobile sheet, so the arc is fitted into the visible half. */
  bottomPadding?: number;
  filteredSummary: LoadSummary | null;
}

interface RouteFeatureProps {
  id: number;
  cf: number | null;
  pricePerCf: number | null;
  rateUsd: number | null;
  pickupState: string | null;
  deliveryState: string | null;
  pickupLabel: string;
  deliveryLabel: string;
  readyNow: boolean;
  readyDate: string | null;
  lastSeenAt: string | null;
  approx: boolean;
  review: boolean;
  status: LoadStatus;
  side: number;
}

interface EndFeatureProps {
  key: string;
  id: number;
  role: "pickup" | "delivery";
  approx: boolean;
  line: boolean;
}

const CONUS: [[number, number], [number, number]] = [
  [-125, 24],
  [-66, 49],
];

/** Above this zoom the state totals would sit on top of the routes they count. */
const PILL_MAX_ZOOM = 5.4;

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/** The palette, read from globals.css once the document exists. */
interface Palette {
  routeStart: string;
  routeEnd: string;
  accentHover: string;
  pickup: string;
  delivery: string;
  approx: string;
  warn: string;
  you: string;
  home: string;
}

const FALLBACK: Palette = {
  routeStart: "#2563eb",
  routeEnd: "#0f172a",
  accentHover: "#1d4ed8",
  pickup: "#2563eb",
  delivery: "#0f172a",
  approx: "#b45309",
  warn: "#d97706",
  you: "#059669",
  home: "#0f172a",
};

function readPalette(): Palette {
  if (typeof window === "undefined") return FALLBACK;
  const css = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    routeStart: pick("--route-start", FALLBACK.routeStart),
    routeEnd: pick("--route-end", FALLBACK.routeEnd),
    accentHover: pick("--accent-hover", FALLBACK.accentHover),
    pickup: pick("--pickup", FALLBACK.pickup),
    delivery: pick("--delivery", FALLBACK.delivery),
    approx: pick("--approx", FALLBACK.approx),
    warn: pick("--warn", FALLBACK.warn),
    you: pick("--you", FALLBACK.you),
    home: pick("--home", FALLBACK.home),
  };
}

/** Line width by cubic feet: a full truckload should read as one. */
const WIDTH_BY_CF: maplibregl.ExpressionSpecification = [
  "step",
  ["coalesce", ["get", "cf"], 0],
  1.5,
  200,
  2,
  400,
  2.75,
  800,
  3.5,
  1200,
  4.5,
];

const ZOOM_WIDTH: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  4,
  WIDTH_BY_CF,
  8,
  ["*", WIDTH_BY_CF, 1.5],
];

const DIM_OPACITY: maplibregl.ExpressionSpecification = [
  "case",
  ["boolean", ["feature-state", "dim"], false],
  0.18,
  0.85,
];

/** Where a job's delivery end goes: its own point, or its state's centroid. */
function deliveryPoint(job: PublicLoadRow): { lng: number; lat: number; approx: boolean } | null {
  if (job.delivery_lat != null && job.delivery_lng != null) {
    return {
      lng: job.delivery_lng,
      lat: job.delivery_lat,
      approx: job.delivery_precision === "state" || job.delivery_precision === "region",
    };
  }
  const st = job.delivery_state ? STATE_BY_ABBR.get(job.delivery_state) : null;
  return st ? { lng: st.lng, lat: st.lat, approx: true } : null;
}

/**
 * Jobs -> the two GeoJSON sources.
 *
 * `side` is derived from the id rather than from the index so a job keeps the
 * same curve across refetches; otherwise every poll would reshuffle the fan.
 */
function buildFeatures(jobs: PublicLoadRow[]): {
  routes: FeatureCollection<LineString, RouteFeatureProps>;
  ends: FeatureCollection<GeoPoint, EndFeatureProps>;
  drawn: number;
} {
  const routes: Feature<LineString, RouteFeatureProps>[] = [];
  const ends: Feature<GeoPoint, EndFeatureProps>[] = [];

  for (const job of jobs) {
    if (job.pickup_lat == null || job.pickup_lng == null) continue;
    const dest = deliveryPoint(job);
    if (!dest) continue;

    const pickupApprox = job.pickup_precision === "state" || job.pickup_precision === "region";
    const approx = pickupApprox || dest.approx;
    const side = (job.id % 5) - 2;

    routes.push({
      type: "Feature",
      id: job.id,
      geometry: {
        type: "LineString",
        coordinates: arcPoints(
          { lat: job.pickup_lat, lng: job.pickup_lng },
          { lat: dest.lat, lng: dest.lng },
          side,
        ),
      },
      properties: {
        id: job.id,
        cf: job.cubic_feet,
        pricePerCf: job.price_per_cf,
        rateUsd: job.rate_usd,
        pickupState: job.pickup_state,
        deliveryState: job.delivery_state,
        pickupLabel: job.pickup_label,
        deliveryLabel: job.delivery_label,
        readyNow: job.ready_now,
        readyDate: job.ready_date,
        lastSeenAt: job.last_seen_at,
        approx,
        review: job.needs_review,
        status: job.status,
        side,
      },
    });

    ends.push(
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [job.pickup_lng, job.pickup_lat] },
        properties: {
          key: `${job.id}:pickup`,
          id: job.id,
          role: "pickup",
          approx: pickupApprox,
          line: true,
        },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [dest.lng, dest.lat] },
        properties: {
          key: `${job.id}:delivery`,
          id: job.id,
          role: "delivery",
          approx: dest.approx,
          line: true,
        },
      },
    );
  }

  return {
    routes: { type: "FeatureCollection", features: routes },
    ends: { type: "FeatureCollection", features: ends },
    drawn: routes.length,
  };
}

/** A 12 px right-pointing triangle, registered as an SDF so icon-color works. */
function chevronImage(): ImageData | null {
  if (typeof document === "undefined") return null;
  const size = 12;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.moveTo(2.5, 1.5);
  ctx.lineTo(9.5, size / 2);
  ctx.lineTo(2.5, size - 1.5);
  ctx.closePath();
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

/** Bounding box of a coordinate list, as MapLibre wants it. */
function bboxOf(coords: [number, number][]): [[number, number], [number, number]] | null {
  if (!coords.length) return null;
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

export function LoadMap({
  jobs,
  selectedId,
  hoveredId,
  onSelect,
  onHover,
  onStateClick,
  searchAsMove,
  onSearchAsMoveChange,
  onBoundsChange,
  viewer,
  home,
  towardHome,
  fitKey,
  bottomPadding = 0,
  filteredSummary,
}: LoadMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const [inView, setInView] = useState<{ count: number; cf: number; unsized: number } | null>(null);
  const [zoom, setZoom] = useState(4);
  const palette = useRef<Palette>(FALLBACK);

  // Callbacks are held in refs so the map is built once and never torn down by
  // a parent re-render; a remount would drop the viewport the user set.
  const cb = useRef({ onSelect, onHover, onStateClick, onBoundsChange, searchAsMove });
  cb.current = { onSelect, onHover, onStateClick, onBoundsChange, searchAsMove };

  const stateMarkers = useRef<maplibregl.Marker[]>([]);
  const placeMarkers = useRef<maplibregl.Marker[]>([]);
  const labelMarkers = useRef<maplibregl.Marker[]>([]);
  const popup = useRef<maplibregl.Popup | null>(null);
  const dimmed = useRef<number[]>([]);
  const priorBounds = useRef<maplibregl.LngLatBounds | null>(null);

  const built = useMemo(() => buildFeatures(jobs), [jobs]);

  /** Recompute the in-view totals from what is actually rendered. */
  const measureInView = useCallback(() => {
    const m = map.current;
    if (!m || !m.getLayer("job-lines")) return;
    const seen = new Set<number>();
    let cf = 0;
    let unsized = 0;
    for (const f of m.queryRenderedFeatures({ layers: ["job-lines", "job-lines-approx"] })) {
      const id = f.properties?.id as number | undefined;
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      const value = f.properties?.cf as number | null | undefined;
      if (value == null) unsized += 1;
      else cf += value;
    }
    setInView({ count: seen.size, cf, unsized });
  }, []);

  // --- init ----------------------------------------------------------------
  useEffect(() => {
    if (!container.current || map.current) return;
    palette.current = readPalette();
    const colors = palette.current;

    const instance = new maplibregl.Map({
      container: container.current,
      style: {
        version: 8,
        sources: {
          basemap: {
            type: "raster",
            tiles: [
              "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
              "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
              "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
            ],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors © CARTO",
          },
        },
        layers: [{ id: "basemap", type: "raster", source: "basemap" }],
      },
      bounds: CONUS,
      fitBoundsOptions: { padding: 40 },
    });
    map.current = instance;
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    // A tile host that is blocked or down otherwise fails silently as a blank
    // canvas, so fall back to plain OSM the first time a tile errors.
    let swapped = false;
    instance.on("error", (e) => {
      const message = e.error?.message ?? String(e);
      if (!swapped && /tile|fetch|load/i.test(message)) {
        swapped = true;
        const src = instance.getSource("basemap") as maplibregl.RasterTileSource | undefined;
        src?.setTiles?.(["https://tile.openstreetmap.org/{z}/{x}/{y}.png"]);
        return;
      }
      console.error("[LoadMap]", message);
    });

    instance.on("load", () => {
      const image = chevronImage();
      if (image && !instance.hasImage("chevron")) {
        instance.addImage("chevron", image, { sdf: true });
      }

      instance.addSource("jobs", {
        type: "geojson",
        data: EMPTY,
        lineMetrics: true,
        promoteId: "id",
      });
      instance.addSource("ends", { type: "geojson", data: EMPTY, promoteId: "key" });
      instance.addSource("road", { type: "geojson", data: EMPTY });
      instance.addSource("toward", { type: "geojson", data: EMPTY });

      // Toward-home corridor sits under everything: it is context, not content.
      instance.addLayer({
        id: "toward-fill",
        type: "fill",
        source: "toward",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": colors.you, "fill-opacity": 0.06 },
      });
      instance.addLayer({
        id: "toward-line",
        type: "line",
        source: "toward",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: {
          "line-color": colors.you,
          "line-width": 1.5,
          "line-dasharray": [1, 3],
          "line-opacity": 0.5,
        },
      });

      instance.addLayer({
        id: "job-casing",
        type: "line",
        source: "jobs",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#ffffff",
          "line-width": ["+", ZOOM_WIDTH, 3],
          "line-opacity": 0.9,
        },
      });

      instance.addLayer({
        id: "job-lines",
        type: "line",
        source: "jobs",
        filter: ["!", ["get", "approx"]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-gradient": [
            "interpolate",
            ["linear"],
            ["line-progress"],
            0,
            colors.routeStart,
            1,
            colors.routeEnd,
          ],
          "line-width": ZOOM_WIDTH,
          "line-opacity": DIM_OPACITY,
        },
      });

      instance.addLayer({
        id: "job-lines-approx",
        type: "line",
        source: "jobs",
        filter: ["get", "approx"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": colors.approx,
          "line-width": ZOOM_WIDTH,
          "line-dasharray": [2, 2],
          "line-opacity": DIM_OPACITY,
        },
      });

      // An unverified job reads as "stitched" rather than hidden: it is real
      // inventory, it just has not been confirmed by a human yet.
      instance.addLayer({
        id: "job-lines-review",
        type: "line",
        source: "jobs",
        filter: ["get", "review"],
        paint: {
          "line-color": colors.warn,
          "line-width": ZOOM_WIDTH,
          "line-dasharray": [1, 1.5],
          "line-opacity": 0.55,
        },
      });

      instance.addLayer({
        id: "job-lines-active",
        type: "line",
        source: "jobs",
        filter: ["boolean", ["feature-state", "active"], false],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": colors.accentHover,
          "line-width": ["+", ZOOM_WIDTH, 1.5],
          "line-opacity": 1,
        },
      });

      instance.addLayer({
        id: "job-hit",
        type: "line",
        source: "jobs",
        paint: { "line-color": "#000000", "line-width": 14, "line-opacity": 0 },
      });

      instance.addLayer({
        id: "job-chevrons",
        type: "symbol",
        source: "jobs",
        minzoom: 4,
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": 90,
          "icon-image": "chevron",
          "icon-size": 1,
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-color": colors.routeEnd, "icon-opacity": DIM_OPACITY },
      });

      instance.addLayer({
        id: "job-road",
        type: "line",
        source: "road",
        paint: { "line-color": colors.routeEnd, "line-width": 4 },
      });

      // A ring at the delivery end, a filled dot at the pickup: an empty end
      // reads as "drop here", a full one as "load here", with no legend.
      instance.addLayer({
        id: "job-delivery",
        type: "circle",
        source: "ends",
        filter: ["==", ["get", "role"], "delivery"],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 3, 6, 5],
          "circle-color": "#ffffff",
          "circle-stroke-width": 2.5,
          "circle-stroke-color": [
            "case",
            ["get", "approx"],
            colors.approx,
            colors.delivery,
          ],
        },
      });
      instance.addLayer({
        id: "job-pickup",
        type: "circle",
        source: "ends",
        filter: ["==", ["get", "role"], "pickup"],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 3, 6, 5],
          "circle-color": ["case", ["get", "approx"], colors.approx, colors.pickup],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });

      const hitLayers = ["job-hit", "job-pickup", "job-delivery"];
      for (const layer of hitLayers) {
        instance.on("mousemove", layer, (e: MapLayerMouseEvent) => {
          const id = e.features?.[0]?.properties?.id as number | undefined;
          instance.getCanvas().style.cursor = "pointer";
          if (id != null) cb.current.onHover(id);
        });
        instance.on("mouseleave", layer, () => {
          instance.getCanvas().style.cursor = "";
          cb.current.onHover(null);
        });
        instance.on("click", layer, (e: MapLayerMouseEvent) => {
          const id = e.features?.[0]?.properties?.id as number | undefined;
          if (id != null) cb.current.onSelect(id);
        });
      }

      instance.on("zoom", () => setZoom(instance.getZoom()));

      let boundsTimer: ReturnType<typeof setTimeout> | null = null;
      instance.on("moveend", () => {
        measureInView();
        if (!cb.current.searchAsMove) return;
        if (boundsTimer) clearTimeout(boundsTimer);
        boundsTimer = setTimeout(() => {
          const b = instance.getBounds();
          cb.current.onBoundsChange({
            minLat: b.getSouth(),
            maxLat: b.getNorth(),
            minLng: b.getWest(),
            maxLng: b.getEast(),
          });
        }, 400);
      });

      setZoom(instance.getZoom());
      setReady(true);
    });

    return () => {
      for (const list of [stateMarkers, placeMarkers, labelMarkers]) {
        for (const m of list.current) m.remove();
        list.current = [];
      }
      popup.current?.remove();
      popup.current = null;
      instance.remove();
      map.current = null;
      setReady(false);
    };
  }, [measureInView]);

  // --- data ----------------------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    (m.getSource("jobs") as GeoJSONSource | undefined)?.setData(built.routes);
    (m.getSource("ends") as GeoJSONSource | undefined)?.setData(built.ends);
    // queryRenderedFeatures only sees what has actually been drawn, so measure
    // on the next idle rather than immediately after setData.
    m.once("idle", measureInView);
  }, [built, ready, measureInView]);

  // --- refit when the filter set changes -----------------------------------
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    const padding = { top: 40, right: 40, bottom: 40 + bottomPadding, left: 40 };

    if (viewer && home) {
      m.fitBounds(
        [
          [Math.min(viewer.lng, home.lng), Math.min(viewer.lat, home.lat)],
          [Math.max(viewer.lng, home.lng), Math.max(viewer.lat, home.lat)],
        ],
        { padding, duration: 0 },
      );
      return;
    }

    const all = built.routes.features.flatMap((f) => f.geometry.coordinates as [number, number][]);
    const box = bboxOf(all);
    m.fitBounds(box ?? CONUS, { padding, duration: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, ready]);

  // --- hover: highlight one route, dim the rest ----------------------------
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    const focus = hoveredId ?? selectedId;

    for (const id of dimmed.current) m.setFeatureState({ source: "jobs", id }, { dim: false, active: false });
    dimmed.current = [];

    if (focus == null) return;
    for (const f of built.routes.features) {
      const id = f.properties.id;
      m.setFeatureState({ source: "jobs", id }, { dim: id !== focus, active: id === focus });
      dimmed.current.push(id);
    }
  }, [hoveredId, selectedId, built, ready]);

  // --- hover popup ---------------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    popup.current?.remove();
    popup.current = null;
    if (hoveredId == null) return;

    const job = jobs.find((j) => j.id === hoveredId);
    const feature = built.routes.features.find((f) => f.properties.id === hoveredId);
    if (!job || !feature) return;

    const coords = feature.geometry.coordinates as [number, number][];
    const mid = coords[Math.floor(coords.length / 2)];
    popup.current = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12 })
      .setLngLat(mid)
      .setText(jobSummary(job))
      .addTo(m);
  }, [hoveredId, jobs, built, ready]);

  // --- selection: fit the arc, and ease back when it closes ----------------
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;

    if (selectedId == null) {
      if (priorBounds.current) {
        m.fitBounds(priorBounds.current, { duration: 600 });
        priorBounds.current = null;
      }
      for (const marker of labelMarkers.current) marker.remove();
      labelMarkers.current = [];
      return;
    }

    const feature = built.routes.features.find((f) => f.properties.id === selectedId);
    if (!feature) return;
    const coords = feature.geometry.coordinates as [number, number][];
    const box = bboxOf(coords);
    if (!box) return;

    if (!priorBounds.current) priorBounds.current = m.getBounds();
    m.fitBounds(box, {
      padding: { top: 60, right: 60, bottom: 60 + bottomPadding, left: 60 },
      duration: 600,
    });

    for (const marker of labelMarkers.current) marker.remove();
    labelMarkers.current = [
      endLabel(m, coords[0], feature.properties.pickupLabel, "left"),
      endLabel(
        m,
        coords[coords.length - 1],
        feature.properties.cf != null
          ? `${feature.properties.deliveryLabel} · ${formatCf(feature.properties.cf)}`
          : feature.properties.deliveryLabel,
        "left",
      ),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, built, ready]);

  // --- you-are-here and home ----------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    for (const marker of placeMarkers.current) marker.remove();
    placeMarkers.current = [];
    const colors = palette.current;

    if (viewer) {
      const el = document.createElement("div");
      el.style.cssText = "position:relative;width:10px;height:10px";
      el.title = `You are here: ${viewer.label}`;
      el.innerHTML =
        `<span class="you-halo" style="position:absolute;inset:0;border-radius:50%;background:${colors.you}"></span>` +
        `<span style="position:absolute;inset:0;border-radius:50%;background:${colors.you};border:2px solid #fff"></span>`;
      placeMarkers.current.push(
        new maplibregl.Marker({ element: el }).setLngLat([viewer.lng, viewer.lat]).addTo(m),
      );
    }

    if (home) {
      const el = document.createElement("div");
      el.title = `Home: ${home.label}`;
      el.style.cssText =
        `width:22px;height:22px;border-radius:50%;background:#fff;color:${colors.home};` +
        "border:2px solid currentColor;display:flex;align-items:center;justify-content:center;" +
        "font:600 12px/1 system-ui";
      el.textContent = "⌂";
      placeMarkers.current.push(
        new maplibregl.Marker({ element: el }).setLngLat([home.lng, home.lat]).addTo(m),
      );
    }
  }, [viewer, home, ready]);

  // --- toward-home band ----------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    const source = m.getSource("toward") as GeoJSONSource | undefined;
    if (!source) return;
    if (!towardHome || !viewer || !home) {
      source.setData(EMPTY);
      return;
    }
    source.setData(corridorFeatures(viewer, home, 100));
  }, [towardHome, viewer, home, ready]);

  // --- state-total pills ---------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    for (const marker of stateMarkers.current) marker.remove();
    stateMarkers.current = [];
    if (zoom > PILL_MAX_ZOOM) return;

    const totals = new Map<string, { jobs: number; cf: number }>();
    for (const job of jobs) {
      const st = job.pickup_state;
      if (!st) continue;
      const t = totals.get(st) ?? { jobs: 0, cf: 0 };
      t.jobs += 1;
      t.cf += job.cubic_feet ?? 0;
      totals.set(st, t);
    }

    for (const [st, t] of totals) {
      const info = STATE_BY_ABBR.get(st);
      if (!info) continue;
      const el = document.createElement("button");
      el.type = "button";
      el.className = "glass nums";
      el.style.cssText =
        "padding:3px 8px;font:600 11px/1.3 system-ui;color:var(--text);cursor:pointer;white-space:nowrap";
      el.textContent = `${st} · ${t.jobs} job${t.jobs === 1 ? "" : "s"} · ${t.cf.toLocaleString("en-US")} cf`;
      el.title = `Filter pickups to ${st}`;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        cb.current.onStateClick(st);
      });
      stateMarkers.current.push(
        new maplibregl.Marker({ element: el }).setLngLat([info.lng, info.lat]).addTo(m),
      );
    }
  }, [jobs, zoom, ready]);

  // --- clearing the bounds when the toggle goes off ------------------------
  useEffect(() => {
    if (!searchAsMove) onBoundsChange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchAsMove]);

  const totalCf = inView?.cf ?? 0;
  const allShown = inView != null && inView.count >= built.drawn;
  const notDrawn = jobs.length - built.drawn;

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="h-full w-full" />

      <div
        className="glass absolute left-[var(--sp-3)] top-[var(--sp-3)] w-[240px] p-[var(--sp-3)]"
        title="Sum of stated cubic feet for routes on screen (dashed routes end at a state centroid). Jobs without a size, and jobs that could not be placed on the map, are not counted."
      >
        <div className="big text-[var(--fs-lg)]">
          {inView == null
            ? "Loading…"
            : `${allShown ? "All " : ""}${inView.count} job${inView.count === 1 ? "" : "s"}${
                allShown ? "" : " in view"
              } · ${totalCf.toLocaleString("en-US")} cf`}
        </div>
        <div className="text-[var(--fs-sm)]" style={{ color: "var(--muted)" }}>
          {totalCf > 0 ? truckLine(totalCf, viewer?.truckCf ?? null) : "No stated sizes on screen"}
          {inView && inView.unsized > 0 && ` · ${inView.unsized} without size`}
          {notDrawn > 0 && ` · ${notDrawn} not on map`}
        </div>
        {filteredSummary && inView && filteredSummary.count !== inView.count && (
          <div className="text-[var(--fs-xs)]" style={{ color: "var(--muted-2)" }}>
            of {filteredSummary.count} filtered
          </div>
        )}
      </div>

      <label
        className="glass absolute right-[var(--sp-3)] top-[calc(var(--sp-3)+80px)] flex items-center gap-[var(--sp-2)] px-[var(--sp-3)] py-[var(--sp-2)] text-[var(--fs-sm)]"
        style={{ cursor: "pointer" }}
      >
        <input
          type="checkbox"
          checked={searchAsMove}
          onChange={(e) => onSearchAsMoveChange(e.target.checked)}
        />
        Search as I move the map
      </label>

      <div className="glass route-legend absolute bottom-[var(--sp-5)] left-[var(--sp-3)] px-[var(--sp-3)] py-[var(--sp-2)]">
        <span>
          <i /> route
        </span>
        <span>
          <i className="approx" /> approximate
        </span>
      </div>
    </div>
  );
}

/** A small white label pinned to one end of the selected route. */
function endLabel(
  m: maplibregl.Map,
  at: [number, number],
  text: string,
  anchor: "left" | "right",
): maplibregl.Marker {
  const el = document.createElement("div");
  el.className = "glass nums";
  el.style.cssText = "padding:2px 7px;font:600 11px/1.5 system-ui;white-space:nowrap";
  el.textContent = text;
  return new maplibregl.Marker({ element: el, anchor, offset: [10, 0] }).setLngLat(at).addTo(m);
}

/**
 * The dashed line from where the viewer is to home, plus the corridor they are
 * willing to detour into, as a simple offset quad around the chord.
 */
function corridorFeatures(
  from: StoredLocation,
  to: StoredLocation,
  miles: number,
): FeatureCollection {
  const dLat = to.lat - from.lat;
  const dLng = to.lng - from.lng;
  const length = Math.hypot(dLat, dLng) || 1;
  // Degrees of latitude per mile; longitude is scaled by the local cosine so
  // the band does not balloon at the top of the map.
  const padLat = miles / 69;
  const padLng = miles / (69 * Math.max(0.2, Math.cos((((from.lat + to.lat) / 2) * Math.PI) / 180)));
  const nx = (-dLat / length) * padLng;
  const ny = (dLng / length) * padLat;

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [from.lng, from.lat],
            [to.lng, to.lat],
          ],
        },
      },
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [from.lng + nx, from.lat + ny],
              [to.lng + nx, to.lat + ny],
              [to.lng - nx, to.lat - ny],
              [from.lng - nx, from.lat - ny],
              [from.lng + nx, from.lat + ny],
            ],
          ],
        },
      },
    ],
  };
}
