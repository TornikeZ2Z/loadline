"use client";

/**
 * The board's map: one point per PLACE, and one road route at a time.
 *
 * This replaces an arc-per-job map. Arcs were right when the board held a dozen
 * jobs and wrong the moment it held a hundred: real posts are batch
 * inventories, one message is twenty-five jobs out of one warehouse, and a
 * hundred overlapping curves is not a picture of anything. So the default view
 * answers the question a mover with an empty truck actually asks -- "what is
 * standing near me" -- and the route, which is still the point of the product,
 * is drawn for the ONE job they open.
 *
 * Consequences worth knowing:
 *
 *  - **Which end is a choice, not a guess.** `Pickups` / `Deliveries` lives in
 *    the filter bar and in the URL (`map=delivery`). Everything downstream --
 *    the plotted point, the state-total pills, the in-view totals -- reads the
 *    selected end, so the map never mixes the two.
 *
 *  - **Aggregation is the whole point.** Jobs are grouped by their rounded
 *    coordinate before anything is drawn. Twenty-five dots stacked on one
 *    warehouse would be the same illegible pile in a different shape; one
 *    marker reading "Rochester, MN · 11 jobs · 6,006 cf" is the answer. Size
 *    comes from the group's total cubic feet, not from how many rows it holds:
 *    a driver is filling a truck, not counting tickets.
 *
 *  - **A guessed coordinate looks guessed.** A job whose end resolved only to a
 *    state centroid is drawn as a hollow amber ring and says so on hover.
 *    Dropping it would hide real inventory; drawing it solid would be a lie.
 *
 *  - **The selected route is the real road**, from HERE's truck router, fetched
 *    from `/api/loads/:id/route` and cached on the row. One routing call per
 *    job, ever -- never for a list, a hover, or this points view. With no key
 *    and nothing cached, selection falls back to a dashed straight line and the
 *    map says the road route is unavailable rather than drawing nothing.
 *
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
import type { Feature, FeatureCollection, Point as GeoPoint } from "geojson";
import type { BoundsInput, LoadSummary } from "@/lib/loads/types";
import type { PublicLoadRow } from "@/lib/loads/publicView";
import type { StoredLocation } from "@/lib/location";
import { STATE_BY_ABBR } from "@/lib/geo/states";
import { api } from "@/lib/basePath";
import { formatCf, jobSummary, placeLabel, truckLine } from "@/lib/loads/present";
import type { MapEnd } from "./FilterBar";

export interface LoadMapProps {
  jobs: PublicLoadRow[];
  /** Which end of every lane is plotted. Also drives the state pills. */
  end: MapEnd;
  selectedId: number | null;
  hoveredId: number | null;
  onSelect(id: number | null): void;
  onHover(id: number | null): void;
  /** A state-total pill was clicked; the caller applies it to `end`'s filter. */
  onStateClick(st: string): void;
  /** A marker holding several jobs was clicked: narrow the list to exactly these. */
  onGroupClick(ids: number[], label: string): void;
  searchAsMove: boolean;
  onSearchAsMoveChange(v: boolean): void;
  onBoundsChange(b: BoundsInput | null): void;
  viewer: StoredLocation | null;
  home: StoredLocation | null;
  towardHome: boolean;
  /** Changes only when the filter set changes, which is the only time we refit. */
  fitKey: string;
  /** Height of the mobile sheet, so the route is fitted into the visible half. */
  bottomPadding?: number;
  filteredSummary: LoadSummary | null;
}

/** One drawn marker: every job whose selected end sits on the same spot. */
interface PointGroup {
  /** Rounded "lng,lat" -- the feature id, and the key everything syncs on. */
  key: string;
  lng: number;
  lat: number;
  ids: number[];
  /** Total stated cubic feet standing here; drives the marker's size. */
  cf: number;
  /** Jobs here whose post never stated a size, so the total can be honest. */
  unsized: number;
  label: string;
  state: string | null;
}

interface PointProps {
  key: string;
  label: string;
  count: number;
  cf: number;
  unsized: number;
  approx: boolean;
  /** Comma-joined ids: MapLibre feature properties survive round trips best flat. */
  ids: string;
}

/** What `/api/loads/:id/route` answers with. */
interface RoadRouteResponse {
  path: [number, number][] | null;
  miles: number | null;
  minutes: number | null;
  unavailable: boolean;
}

const CONUS: [[number, number], [number, number]] = [
  [-125, 24],
  [-66, 49],
];

/** Above this zoom the state totals would sit on top of the points they count. */
const PILL_MAX_ZOOM = 5.4;

/** Keyless raster tiles; the pale Positron look is applied in paint, below. */
const BASEMAP_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/** The palette, read from globals.css once the document exists. */
interface Palette {
  accent: string;
  accentHover: string;
  pickup: string;
  delivery: string;
  approx: string;
  you: string;
  home: string;
}

const FALLBACK: Palette = {
  accent: "#2563eb",
  accentHover: "#1d4ed8",
  pickup: "#2563eb",
  delivery: "#0f172a",
  approx: "#b45309",
  you: "#059669",
  home: "#0f172a",
};

function readPalette(): Palette {
  if (typeof window === "undefined") return FALLBACK;
  const css = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    accent: pick("--accent", FALLBACK.accent),
    accentHover: pick("--accent-hover", FALLBACK.accentHover),
    pickup: pick("--pickup", FALLBACK.pickup),
    delivery: pick("--delivery", FALLBACK.delivery),
    approx: pick("--approx", FALLBACK.approx),
    you: pick("--you", FALLBACK.you),
    home: pick("--home", FALLBACK.home),
  };
}

/**
 * Marker radius from the group's total cubic feet.
 *
 * On the square root, so the AREA of the dot tracks the volume: a marker twice
 * the radius of another reads as four times the freight, which is what the eye
 * actually compares. Interpolated with zoom as the arcs' widths were, so the
 * national view stays readable without the city view turning into blobs.
 */
const RADIUS_BY_CF: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["sqrt", ["max", 0, ["coalesce", ["get", "cf"], 0]]],
  0,
  5,
  20,
  8,
  45,
  11,
  80,
  15,
  120,
  19,
];

function zoomRadius(extra = 0): maplibregl.ExpressionSpecification {
  const at = (scale: number): maplibregl.ExpressionSpecification =>
    extra === 0 ? ["*", RADIUS_BY_CF, scale] : ["+", ["*", RADIUS_BY_CF, scale], extra];
  return ["interpolate", ["linear"], ["zoom"], 3, at(0.85), 7, at(1.25)];
}

const DIM_OPACITY: maplibregl.ExpressionSpecification = [
  "case",
  ["boolean", ["feature-state", "dim"], false],
  0.22,
  0.92,
];

/**
 * Where a job's chosen end goes: its own coordinate, or its state's centroid.
 *
 * The centroid fallback is flagged approximate and drawn as such. It exists
 * because a post that says "delivering to FL" is real inventory a driver may
 * want, and hiding it would make the board quietly incomplete.
 */
function endPoint(
  job: PublicLoadRow,
  end: MapEnd,
): { lng: number; lat: number; approx: boolean } | null {
  const lat = end === "pickup" ? job.pickup_lat : job.delivery_lat;
  const lng = end === "pickup" ? job.pickup_lng : job.delivery_lng;
  const precision = end === "pickup" ? job.pickup_precision : job.delivery_precision;
  if (lat != null && lng != null) {
    return { lng, lat, approx: precision === "state" || precision === "region" };
  }
  const st = end === "pickup" ? job.pickup_state : job.delivery_state;
  const info = st ? STATE_BY_ABBR.get(st) : null;
  return info ? { lng: info.lng, lat: info.lat, approx: true } : null;
}

/** "Rochester, MN" -- the place, not the post's raw wording. */
function endLabelText(job: PublicLoadRow, end: MapEnd): string {
  const city = end === "pickup" ? job.pickup_city : job.delivery_city;
  const state = end === "pickup" ? job.pickup_state : job.delivery_state;
  if (city && state) return `${city}, ${state}`;
  if (city) return city;
  return placeLabel(job, end).text;
}

/**
 * Jobs -> markers.
 *
 * Grouped on three decimal places (~110 m): five decimals would split a city
 * from its own ZIP centroid into two dots sitting on each other, which is the
 * pile this view exists to remove.
 */
function buildGroups(
  jobs: PublicLoadRow[],
  end: MapEnd,
): {
  groups: PointGroup[];
  features: FeatureCollection<GeoPoint, PointProps>;
  keyByJob: Map<number, string>;
  plotted: number;
} {
  const byKey = new Map<string, PointGroup & { approx: boolean }>();
  const keyByJob = new Map<number, string>();
  let plotted = 0;

  for (const job of jobs) {
    const at = endPoint(job, end);
    if (!at) continue;
    plotted += 1;

    const key = `${at.lng.toFixed(3)},${at.lat.toFixed(3)}`;
    keyByJob.set(job.id, key);

    const existing = byKey.get(key);
    if (existing) {
      existing.ids.push(job.id);
      existing.cf += job.cubic_feet ?? 0;
      if (job.cubic_feet == null) existing.unsized += 1;
      // Only a group where EVERY member is a guess is drawn as one.
      existing.approx &&= at.approx;
      continue;
    }

    byKey.set(key, {
      key,
      lng: at.lng,
      lat: at.lat,
      ids: [job.id],
      cf: job.cubic_feet ?? 0,
      unsized: job.cubic_feet == null ? 1 : 0,
      label: endLabelText(job, end),
      state: end === "pickup" ? job.pickup_state : job.delivery_state,
      approx: at.approx,
    });
  }

  const groups = [...byKey.values()];
  const features: Feature<GeoPoint, PointProps>[] = groups.map((g) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [g.lng, g.lat] },
    properties: {
      key: g.key,
      label: g.label,
      count: g.ids.length,
      cf: g.cf,
      unsized: g.unsized,
      approx: g.approx,
      ids: g.ids.join(","),
    },
  }));

  return {
    groups,
    features: { type: "FeatureCollection", features },
    keyByJob,
    plotted,
  };
}

/** "Rochester, MN · 11 jobs · 6,006 cf" */
function groupSummary(g: PointGroup): string {
  const jobs = `${g.ids.length} job${g.ids.length === 1 ? "" : "s"}`;
  const size = g.cf > 0 ? formatCf(g.cf) : "size not stated";
  const unsized =
    g.unsized > 0 && g.cf > 0 ? ` (${g.unsized} without a size)` : "";
  return `${g.label} · ${jobs} · ${size}${unsized}`;
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
  end,
  selectedId,
  hoveredId,
  onSelect,
  onHover,
  onStateClick,
  onGroupClick,
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
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [route, setRoute] = useState<{ id: number; road: RoadRouteResponse } | null>(null);
  const palette = useRef<Palette>(FALLBACK);

  // Callbacks are held in refs so the map is built once and never torn down by
  // a parent re-render; a remount would drop the viewport the user set.
  const cb = useRef({ onSelect, onHover, onStateClick, onGroupClick, onBoundsChange, searchAsMove });
  cb.current = { onSelect, onHover, onStateClick, onGroupClick, onBoundsChange, searchAsMove };

  const stateMarkers = useRef<maplibregl.Marker[]>([]);
  const placeMarkers = useRef<maplibregl.Marker[]>([]);
  const countMarkers = useRef<maplibregl.Marker[]>([]);
  const labelMarkers = useRef<maplibregl.Marker[]>([]);
  const popup = useRef<maplibregl.Popup | null>(null);
  const stated = useRef<string[]>([]);
  const priorBounds = useRef<maplibregl.LngLatBounds | null>(null);
  /** The `fitKey` the current viewport was fitted for; null until the first fit. */
  const lastFit = useRef<string | null>(null);
  /**
   * One road geometry per job for the life of the page. The server caches it on
   * the row as well, so even a reload costs no second HERE call -- this only
   * saves the round trip.
   */
  const roadCache = useRef(new Map<number, RoadRouteResponse>());

  const built = useMemo(() => buildGroups(jobs, end), [jobs, end]);
  const groupByKey = useMemo(
    () => new Map(built.groups.map((g) => [g.key, g])),
    [built],
  );
  // Read by the map's own event handlers, which are registered once and must
  // not close over a stale result set.
  const groups = useRef(built.groups);
  groups.current = built.groups;

  // A single boolean rather than the raw zoom: `zoom` ticks on every frame of
  // every wheel gesture, and rebuilding a screenful of HTML markers per frame
  // is the one thing that makes this map feel slow.
  const detailed = zoom > PILL_MAX_ZOOM;

  /**
   * The in-view totals, from the viewport box against the groups themselves.
   *
   * Deliberately NOT `queryRenderedFeatures`: that answers "what has been
   * painted", which is a different question with a race in front of it. The
   * refit after a search fires `moveend` before the new features are indexed,
   * so the panel would write a 0 that nothing takes back; and on a phone, or in
   * any tab the browser has throttled, frames arrive late enough that a map
   * plainly covered in points can report none. A point either is inside the
   * bounds or it is not, and that is knowable without a frame.
   */
  const measureInView = useCallback(() => {
    const m = map.current;
    if (!m) return;
    const box = m.getBounds();
    let count = 0;
    let cf = 0;
    let unsized = 0;
    for (const group of groups.current) {
      if (!box.contains([group.lng, group.lat])) continue;
      count += group.ids.length;
      cf += group.cf;
      unsized += group.unsized;
    }
    setInView({ count, cf, unsized });
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
            tiles: [BASEMAP_TILES],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
          },
        },
        // The design calls for a pale basemap so the board's own marks are the
        // only saturated thing on screen. CARTO Positron is the usual way to
        // get that, but it now stamps "API KEY REQUIRED" across every
        // unauthenticated tile, so the pale look is produced here instead:
        // keyless OSM tiles desaturated and lightened by the raster paint
        // properties, which touch this layer only.
        layers: [
          {
            id: "basemap",
            type: "raster",
            source: "basemap",
            paint: {
              "raster-saturation": -0.75,
              "raster-contrast": -0.12,
              "raster-brightness-min": 0.12,
              "raster-opacity": 0.9,
            },
          },
        ],
      },
      bounds: CONUS,
      fitBoundsOptions: { padding: 40 },
    });
    map.current = instance;
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    // A tile host that is blocked or down otherwise fails silently as a blank
    // canvas, so say so once rather than leaving an empty rectangle.
    let reported = false;
    instance.on("error", (e) => {
      const message = e.error?.message ?? String(e);
      if (/tile/i.test(message)) {
        if (reported) return;
        reported = true;
      }
      console.error("[LoadMap]", message);
    });

    instance.on("load", () => {
      const image = chevronImage();
      if (image && !instance.hasImage("chevron")) {
        instance.addImage("chevron", image, { sdf: true });
      }

      instance.addSource("points", { type: "geojson", data: EMPTY, promoteId: "key" });
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

      // One circle layer, not two: an approximate point differs by being hollow,
      // and keeping it in the same layer means the dim/highlight states have
      // exactly one place to live.
      instance.addLayer({
        id: "points",
        type: "circle",
        source: "points",
        paint: {
          "circle-color": ["case", ["get", "approx"], "#ffffff", colors.pickup],
          "circle-radius": zoomRadius(),
          "circle-opacity": DIM_OPACITY,
          "circle-stroke-width": ["case", ["get", "approx"], 2.5, 2],
          "circle-stroke-color": ["case", ["get", "approx"], colors.approx, "#ffffff"],
          "circle-stroke-opacity": DIM_OPACITY,
        },
      });

      // Feature-state cannot appear in a layer filter, so the highlight ring
      // draws over every point and hides all but the active one in paint.
      instance.addLayer({
        id: "points-active",
        type: "circle",
        source: "points",
        paint: {
          "circle-color": "rgba(0,0,0,0)",
          "circle-radius": zoomRadius(3),
          "circle-stroke-width": 2.5,
          "circle-stroke-color": colors.accentHover,
          "circle-stroke-opacity": [
            "case",
            ["boolean", ["feature-state", "active"], false],
            1,
            0,
          ],
        },
      });

      // The selected job's road, drawn ON TOP of the points: it is the one
      // thing on screen that is about a decision rather than an inventory.
      instance.addLayer({
        id: "route-casing",
        type: "line",
        source: "road",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0.9 },
      });
      // Six pixels rather than four so the direction chevrons sit INSIDE the
      // stroke: a white arrow on a thin line bleeds into its own white casing
      // and the direction stops being readable, which is most of what the line
      // is for.
      instance.addLayer({
        id: "route-road",
        type: "line",
        source: "road",
        filter: ["get", "road"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": colors.accent, "line-width": 6 },
      });
      // No road route to be had: a dashed chord, which reads as "we do not know
      // the way" rather than as a highway that does not exist.
      instance.addLayer({
        id: "route-straight",
        type: "line",
        source: "road",
        filter: ["!", ["get", "road"]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": colors.approx,
          "line-width": 3,
          "line-dasharray": [2, 2],
          "line-opacity": 0.85,
        },
      });
      instance.addLayer({
        id: "route-arrows",
        type: "symbol",
        source: "road",
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": 90,
          "icon-image": "chevron",
          "icon-size": 0.7,
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-color": "#ffffff", "icon-opacity": 0.95 },
      });

      instance.on("mousemove", "points", (e: MapLayerMouseEvent) => {
        const props = e.features?.[0]?.properties;
        instance.getCanvas().style.cursor = "pointer";
        const key = props?.key as string | undefined;
        setHoverKey(key ?? null);
        // Only a marker that stands for exactly one job can highlight a card;
        // scrolling the list to an arbitrary member of a group would be noise.
        const ids = idsOf(props?.ids);
        cb.current.onHover(ids.length === 1 ? ids[0]! : null);
      });
      instance.on("mouseleave", "points", () => {
        instance.getCanvas().style.cursor = "";
        setHoverKey(null);
        cb.current.onHover(null);
      });

      instance.on("click", "points", (e: MapLayerMouseEvent) => {
        const feature = e.features?.[0];
        const ids = idsOf(feature?.properties?.ids);
        if (!ids.length) return;
        if (ids.length === 1) {
          cb.current.onSelect(ids[0]!);
          return;
        }
        // A group is not a job. Clicking it says "show me these", and the map
        // goes in far enough that the members stop being one dot.
        cb.current.onGroupClick(ids, String(feature?.properties?.label ?? "this place"));
        const at = (feature?.geometry as GeoPoint | undefined)?.coordinates as
          | [number, number]
          | undefined;
        if (at) {
          instance.easeTo({ center: at, zoom: Math.max(instance.getZoom() + 2.5, 9), duration: 600 });
        }
      });

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
      for (const list of [stateMarkers, placeMarkers, labelMarkers, countMarkers]) {
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
    (m.getSource("points") as GeoJSONSource | undefined)?.setData(built.features);
    // A new result set changes the totals even when the viewport does not.
    measureInView();
  }, [built, ready, measureInView]);

  // Pickups and deliveries are different colours because they are different
  // questions; the layer is built once, so the colour is repainted here.
  useEffect(() => {
    const m = map.current;
    if (!ready || !m || !m.getLayer("points")) return;
    const solid = end === "pickup" ? palette.current.pickup : palette.current.delivery;
    m.setPaintProperty("points", "circle-color", [
      "case",
      ["get", "approx"],
      "#ffffff",
      solid,
    ]);
  }, [end, ready]);

  // --- refit when the filter set changes -----------------------------------
  // Keyed on the DATA, not on `fitKey`: the key changes the instant a filter
  // does, which is a whole round trip before that search's rows land, so
  // fitting when the key changes frames the previous result set and the map
  // ends up permanently one search behind. Fitting when the rows arrive, once
  // per key, frames what is actually on screen.
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    if (fitKey === lastFit.current) return;
    const padding = { top: 40, right: 40, bottom: 40 + bottomPadding, left: 40 };

    // The viewer/home box answers "between me and home", which is the question
    // only while the corridor is on. With the toggle off the map has to frame
    // the search, or an explicit pickup/delivery filter draws nothing on it.
    if (towardHome && viewer && home) {
      lastFit.current = fitKey;
      m.fitBounds(
        [
          [Math.min(viewer.lng, home.lng), Math.min(viewer.lat, home.lat)],
          [Math.max(viewer.lng, home.lng), Math.max(viewer.lat, home.lat)],
        ],
        { padding, duration: 0 },
      );
      return;
    }

    const box = bboxOf(built.groups.map((g) => [g.lng, g.lat] as [number, number]));
    m.fitBounds(box ?? CONUS, { padding, duration: 0, maxZoom: 9 });
    // Record the key only once there is something real to frame: before the
    // first response lands `built` is empty because nothing has been fetched
    // yet rather than because the search found nothing, and consuming the key
    // there would leave the first result set unframed.
    if (box || lastFit.current !== null) lastFit.current = fitKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [built, ready]);

  // --- hover/selection: highlight one marker, dim the rest -----------------
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    const focusId = hoveredId ?? selectedId;
    const focusKey = hoverKey ?? (focusId != null ? built.keyByJob.get(focusId) : undefined);

    for (const key of stated.current) {
      m.setFeatureState({ source: "points", id: key }, { dim: false, active: false });
    }
    stated.current = [];

    if (!focusKey) return;
    for (const group of built.groups) {
      m.setFeatureState(
        { source: "points", id: group.key },
        { dim: group.key !== focusKey, active: group.key === focusKey },
      );
      stated.current.push(group.key);
    }
  }, [hoveredId, hoverKey, selectedId, built, ready]);

  // --- hover popup ---------------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    popup.current?.remove();
    popup.current = null;

    const key = hoverKey ?? (hoveredId != null ? built.keyByJob.get(hoveredId) : undefined);
    const group = key ? groupByKey.get(key) : undefined;
    if (!group) return;

    // One job gets its own line -- lane, size, price, readiness -- because that
    // is what the viewer is about to decide on. A group gets the tally.
    const single = group.ids.length === 1 ? jobs.find((j) => j.id === group.ids[0]) : null;

    popup.current = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14 })
      .setLngLat([group.lng, group.lat])
      .setText(single ? jobSummary(single) : groupSummary(group))
      .addTo(m);
  }, [hoverKey, hoveredId, jobs, built, groupByKey, ready]);

  // --- the selected job's road --------------------------------------------
  // One request per job, answered from `loads.road_path` after the first, so
  // re-opening a job never reaches HERE again.
  useEffect(() => {
    if (selectedId == null) {
      setRoute(null);
      return;
    }
    const cached = roadCache.current.get(selectedId);
    if (cached) {
      setRoute({ id: selectedId, road: cached });
      return;
    }

    let live = true;
    setRoute(null);
    void fetch(api(`/api/loads/${selectedId}/route`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: RoadRouteResponse) => {
        const road: RoadRouteResponse = {
          path: Array.isArray(body?.path) && body.path.length > 1 ? body.path : null,
          miles: body?.miles ?? null,
          minutes: body?.minutes ?? null,
          unavailable: Boolean(body?.unavailable),
        };
        // Only a real answer is remembered; a network blip should be retryable.
        roadCache.current.set(selectedId, road);
        if (live) setRoute({ id: selectedId, road });
      })
      .catch(() => {
        if (live) {
          setRoute({
            id: selectedId,
            road: { path: null, miles: null, minutes: null, unavailable: true },
          });
        }
      });
    return () => {
      live = false;
    };
  }, [selectedId]);

  // --- draw it, and ease back when the selection closes --------------------
  useEffect(() => {
    const m = map.current;
    const source = m?.getSource("road") as GeoJSONSource | undefined;
    if (!ready || !m || !source) return;

    for (const marker of labelMarkers.current) marker.remove();
    labelMarkers.current = [];

    if (selectedId == null) {
      source.setData(EMPTY);
      if (priorBounds.current) {
        m.fitBounds(priorBounds.current, { duration: 600 });
        priorBounds.current = null;
      }
      return;
    }

    const job = jobs.find((j) => j.id === selectedId);
    const from = job ? endPoint(job, "pickup") : null;
    const to = job ? endPoint(job, "delivery") : null;

    const road = route?.id === selectedId ? route.road.path : null;
    const coords: [number, number][] | null = road
      ? road
      : from && to
        ? [
            [from.lng, from.lat],
            [to.lng, to.lat],
          ]
        : null;

    if (!job || !coords) {
      source.setData(EMPTY);
      return;
    }

    source.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { road: Boolean(road) },
          geometry: { type: "LineString", coordinates: coords },
        },
      ],
    });

    const box = bboxOf(coords);
    if (box) {
      if (!priorBounds.current) priorBounds.current = m.getBounds();
      m.fitBounds(box, {
        padding: { top: 60, right: 60, bottom: 60 + bottomPadding, left: 60 },
        duration: 600,
        maxZoom: 11,
      });
    }

    if (from && to) {
      labelMarkers.current = [
        endMarker(m, [from.lng, from.lat], endLabelText(job, "pickup")),
        endMarker(
          m,
          [to.lng, to.lat],
          job.cubic_feet != null
            ? `${endLabelText(job, "delivery")} · ${formatCf(job.cubic_feet)}`
            : endLabelText(job, "delivery"),
        ),
      ];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, selectedId, jobs, ready]);

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

  // --- counts on the markers that hold more than one job -------------------
  // Only the groups that need it: a singleton's name is on its card and in its
  // hover, and a label per dot would bury the map in text.
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    for (const marker of countMarkers.current) marker.remove();
    countMarkers.current = [];

    for (const group of built.groups) {
      if (group.ids.length < 2) continue;
      const el = document.createElement("div");
      el.className = "map-count nums";
      el.textContent = detailed ? `${group.label} · ${group.ids.length}` : String(group.ids.length);
      el.title = groupSummary(group);
      countMarkers.current.push(
        new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, -12] })
          .setLngLat([group.lng, group.lat])
          .addTo(m),
      );
    }
  }, [built, detailed, ready]);

  // --- state-total pills ---------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    for (const marker of stateMarkers.current) marker.remove();
    stateMarkers.current = [];
    if (detailed) return;

    // Counted on the SELECTED end: in Deliveries mode "FL · 9 jobs" has to mean
    // nine jobs arriving in Florida, or the pill contradicts the dots under it.
    const totals = new Map<string, { jobs: number; cf: number }>();
    for (const job of jobs) {
      const st = end === "pickup" ? job.pickup_state : job.delivery_state;
      if (!st) continue;
      const t = totals.get(st) ?? { jobs: 0, cf: 0 };
      t.jobs += 1;
      t.cf += job.cubic_feet ?? 0;
      totals.set(st, t);
    }

    const noun = end === "pickup" ? "pickups" : "deliveries";
    for (const [st, t] of totals) {
      const info = STATE_BY_ABBR.get(st);
      if (!info) continue;
      const el = document.createElement("button");
      el.type = "button";
      el.className = "glass nums";
      el.style.cssText =
        "padding:3px 8px;font:600 11px/1.3 system-ui;color:var(--text);cursor:pointer;white-space:nowrap";
      el.textContent = `${st} · ${t.jobs} job${t.jobs === 1 ? "" : "s"} · ${t.cf.toLocaleString("en-US")} cf`;
      el.title = `Filter ${noun} to ${st}`;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        cb.current.onStateClick(st);
      });
      stateMarkers.current.push(
        new maplibregl.Marker({ element: el }).setLngLat([info.lng, info.lat]).addTo(m),
      );
    }
  }, [jobs, end, detailed, ready]);

  // --- clearing the bounds when the toggle goes off ------------------------
  useEffect(() => {
    if (!searchAsMove) onBoundsChange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchAsMove]);

  const totalCf = inView?.cf ?? 0;
  const allShown = inView != null && inView.count >= jobs.length;
  const notPlotted = jobs.length - built.plotted;
  const noRoad = selectedId != null && route?.id === selectedId && route.road.path == null;

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="h-full w-full" />

      <div
        className="glass absolute left-[var(--sp-3)] top-[var(--sp-3)] w-[250px] p-[var(--sp-3)]"
        title={`Jobs whose ${end} is on screen, and the cubic feet standing there. Hollow markers sit on a state centroid rather than a real address. Jobs without a stated size are counted but add nothing to the total.`}
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
        </div>
        {notPlotted > 0 && (
          <div className="text-[var(--fs-xs)]" style={{ color: "var(--approx)" }}>
            {notPlotted} job{notPlotted === 1 ? " has" : "s have"} no mappable {end}
          </div>
        )}
        {filteredSummary && inView && filteredSummary.count !== inView.count && (
          <div className="text-[var(--fs-xs)]" style={{ color: "var(--muted-2)" }}>
            of {filteredSummary.count} filtered
          </div>
        )}
      </div>

      {noRoad && (
        <div
          className="glass absolute left-1/2 top-[var(--sp-3)] -translate-x-1/2 px-[var(--sp-3)] py-[var(--sp-2)] text-[var(--fs-sm)]"
          style={{ color: "var(--approx)" }}
        >
          Road route unavailable — showing a straight line.
        </div>
      )}

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

      <div
        className="glass point-legend absolute bottom-[var(--sp-5)] left-[var(--sp-3)] px-[var(--sp-3)] py-[var(--sp-2)]"
        style={
          {
            "--map-point": end === "pickup" ? "var(--pickup)" : "var(--delivery)",
          } as React.CSSProperties
        }
      >
        <b>
          <i className="sm" />
          <i className="lg" /> size = cubic feet
        </b>
        <b>
          <i className="approx" /> approximate
        </b>
        {selectedId != null && (
          <b>
            <i className="road" /> road route
          </b>
        )}
      </div>
    </div>
  );
}

/** "12,15,19" -> [12, 15, 19]; anything else -> []. */
function idsOf(raw: unknown): number[] {
  if (typeof raw !== "string" || !raw) return [];
  return raw
    .split(",")
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
}

/** A small white label pinned to one end of the selected route. */
function endMarker(m: maplibregl.Map, at: [number, number], text: string): maplibregl.Marker {
  const el = document.createElement("div");
  el.className = "glass nums";
  el.style.cssText = "padding:2px 7px;font:600 11px/1.5 system-ui;white-space:nowrap";
  el.textContent = text;
  return new maplibregl.Marker({ element: el, anchor: "left", offset: [10, 0] })
    .setLngLat(at)
    .addTo(m);
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
