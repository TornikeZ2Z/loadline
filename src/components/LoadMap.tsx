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
import type { FeatureCollection, Point as GeoPoint } from "geojson";
import type { BoundsInput, LoadSummary, MapEnd } from "@/lib/loads/types";
import type { PublicLoadRow } from "@/lib/loads/publicView";
import type { StoredLocation } from "@/lib/location";
import { STATE_BY_ABBR } from "@/lib/geo/states";
import { api } from "@/lib/basePath";
import { formatCf, jobSummary, truckLine } from "@/lib/loads/present";
import {
  buildGroups,
  endLabelText,
  endPoint,
  groupSummary,
  idsOf,
  type PointGroup,
} from "@/lib/geo/points";

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
  /** The first search has not answered yet; the panel must not report a 0. */
  loading?: boolean;
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

/**
 * Below this zoom a state pill drops the job count and reads "FL · 4,900 cf".
 *
 * The tier is chosen by ZOOM and not by whether the long string happens to
 * fit, because "fits" changes on every frame of a pan and a label whose words
 * rewrite themselves while you drag is worse than one that is merely narrow.
 * The full sentence is always on the pill's `title`.
 */
const PILL_SHORT_ZOOM = 4.6;

/* --------------------------- label decluttering ---------------------------
 *
 * Every label on this map is an HTML `Marker`, and MapLibre places those where
 * it is told and nowhere else -- there is no collision handling for them the
 * way there is for a symbol layer's `text-field`. With sixteen state pills at
 * the national view that meant the northeast rendered as a smudge: "NY · 1 job
 * · 250 cf" printed straight through its neighbour, and a count badge sat on
 * top of both. Two labels on top of each other are worth less than one label,
 * which is the same failure this whole points view exists to fix, in miniature.
 *
 * So placement runs through a greedy screen-space pass, the way a cartographer
 * (and MapLibre's own symbol placement) does it: walk the labels in order of
 * importance, give each the first candidate position whose box is still free,
 * and hide the ones that have nowhere to go. Nothing is lost by hiding -- the
 * dot underneath keeps its size, its hover summary and its click.
 */

/** Where a label may go, relative to its natural position, in order of preference. */
const LABEL_SLOTS: Array<[number, number]> = [
  [0, 0],
  [0, -20],
  [0, 20],
  [0, -40],
  [0, 40],
  [-52, -14],
  [52, -14],
  [-52, 14],
  [52, 14],
];

/** Breathing room around a placed label, in px. */
const LABEL_PAD = 3;

type LabelKind = "route" | "count" | "state";

interface MapLabel {
  kind: LabelKind;
  marker: maplibregl.Marker;
  el: HTMLElement;
  lng: number;
  lat: number;
  /** How the element hangs off its point, matching the Marker's own anchor. */
  anchor: "center" | "bottom" | "left";
  /** The offset the marker was built with; slots are added to it. */
  base: [number, number];
  /** Higher wins a contested spot. */
  weight: number;
  /** Placed first and never moved or hidden: the route's own two ends. */
  fixed?: boolean;
}

type Box = [number, number, number, number];

function overlaps(a: Box, b: Box): boolean {
  return !(a[0] > b[2] || a[2] < b[0] || a[1] > b[3] || a[3] < b[1]);
}

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
  loading = false,
}: LoadMapProps) {
  const container = useRef<HTMLDivElement>(null);
  /** The canvas plus everything floating over it; the declutter frame. */
  const shell = useRef<HTMLDivElement>(null);
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
  /** Everything the declutter pass places, across all three marker groups. */
  const labels = useRef<MapLabel[]>([]);
  /** Rendered size per element class + text; a pan must not read layout. */
  const labelSize = useRef(new Map<string, [number, number]>());
  const popup = useRef<maplibregl.Popup | null>(null);
  const stated = useRef<string[]>([]);
  const priorBounds = useRef<maplibregl.LngLatBounds | null>(null);
  /** The `fitKey` the current viewport was fitted for; null until the first fit. */
  const lastFit = useRef<string | null>(null);
  /** The `bottomPadding` that fit was computed with. */
  const lastFitPad = useRef<number | null>(null);
  /** The viewer has panned or zoomed by hand: their frame outranks ours. */
  const viewerFramed = useRef(false);
  /**
   * One road geometry per job for the life of the page. The server caches it on
   * the row as well, so even a reload costs no second HERE call -- this only
   * saves the round trip.
   */
  const roadCache = useRef(new Map<number, RoadRouteResponse>());

  const built = useMemo(() => buildGroups(jobs, end), [jobs, end]);
  // Read by the map's own event handlers, which are registered once and must
  // not close over a stale result set.
  const groups = useRef(built.groups);
  groups.current = built.groups;

  // A single boolean rather than the raw zoom: `zoom` ticks on every frame of
  // every wheel gesture, and rebuilding a screenful of HTML markers per frame
  // is the one thing that makes this map feel slow.
  const detailed = zoom > PILL_MAX_ZOOM;
  /** Same reasoning as `detailed`: a boolean, so a wheel gesture rebuilds the
      pills at most twice instead of once a frame. */
  const shortPills = zoom < PILL_SHORT_ZOOM;

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

  // --- label placement -----------------------------------------------------

  /**
   * The rendered size of a label, cached by class + text.
   *
   * `offsetWidth` is a layout read, and doing one per label per frame of a pan
   * is exactly the thrash that makes a map feel gluey. A label's box does not
   * change while the viewport moves, so it is measured the first time its text
   * is seen and never again.
   */
  const sizeOf = useCallback((l: MapLabel): [number, number] => {
    const key = `${l.el.className}|${l.el.textContent ?? ""}`;
    const hit = labelSize.current.get(key);
    if (hit) return hit;
    const size: [number, number] = [l.el.offsetWidth, l.el.offsetHeight];
    labelSize.current.set(key, size);
    return size;
  }, []);

  /** Greedy screen-space placement; see LABEL_SLOTS above for the why. */
  const declutter = useCallback(() => {
    const m = map.current;
    if (!m) return;
    const canvas = m.getCanvas();
    const vw = canvas.clientWidth;
    const vh = canvas.clientHeight;
    const taken: Box[] = [];

    // The map's own furniture -- the in-view panel, the legend, the zoom
    // buttons -- is opaque, so a label placed under it is a label that is not
    // there. Reserve those boxes first. Read in one go, before the loop starts
    // writing, so this stays a single layout pass.
    const frame = shell.current?.getBoundingClientRect();
    if (frame) {
      for (const el of shell.current!.querySelectorAll<HTMLElement>("[data-map-chrome]")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        taken.push([r.left - frame.left, r.top - frame.top, r.right - frame.left, r.bottom - frame.top]);
      }
    }

    const ordered = [...labels.current].sort((a, b) => b.weight - a.weight);
    for (const l of ordered) {
      // A marker group whose effect bailed before re-registering its labels can
      // leave an entry pointing at a removed element. Measuring one would give
      // a zero-width box that quietly lets a real label overlap something.
      if (!l.el.isConnected) continue;
      const at = m.project([l.lng, l.lat]);
      const [w, h] = sizeOf(l);
      // Off screen entirely: nothing to draw and nothing to reserve. Generous
      // margin so a label whose point is just past the edge still keeps its
      // neighbours honest.
      if (at.x < -200 || at.y < -200 || at.x > vw + 200 || at.y > vh + 200) {
        l.el.style.visibility = "hidden";
        continue;
      }

      let placed = false;
      for (const [dx, dy] of l.fixed ? [[0, 0] as [number, number]] : LABEL_SLOTS) {
        const ox = l.base[0] + dx;
        const oy = l.base[1] + dy;
        const cx = at.x + ox;
        const cy = at.y + oy;
        const left = l.anchor === "left" ? cx : cx - w / 2;
        const top = l.anchor === "bottom" ? cy - h : cy - h / 2;
        const box: Box = [left - LABEL_PAD, top - LABEL_PAD, left + w + LABEL_PAD, top + h + LABEL_PAD];
        if (!l.fixed) {
          // The map column clips, so a label that runs off the edge reads as
          // broken text rather than as a label. Try another slot, or none.
          if (box[0] < 2 || box[1] < 2 || box[2] > vw - 2 || box[3] > vh - 2) continue;
          if (taken.some((t) => overlaps(box, t))) continue;
        }
        l.marker.setOffset([ox, oy]);
        l.el.style.visibility = "visible";
        taken.push(box);
        placed = true;
        break;
      }
      if (!placed) l.el.style.visibility = "hidden";
    }
  }, [sizeOf]);

  /** Replace one group's labels, keeping the other groups' entries. */
  const setLabels = useCallback(
    (kind: LabelKind, next: MapLabel[]) => {
      labels.current = labels.current.filter((l) => l.kind !== kind).concat(next);
      declutter();
    },
    [declutter],
  );

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
    // MapLibre builds its own chrome, so it cannot carry the attribute in JSX.
    // Marking it here keeps the declutter pass from placing a state total
    // behind the zoom buttons or the attribution line.
    for (const el of instance
      .getContainer()
      .querySelectorAll(".maplibregl-ctrl-group, .maplibregl-ctrl-attrib")) {
      el.setAttribute("data-map-chrome", "");
    }

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

      // `originalEvent` is present only when a pointer, a wheel or a key moved
      // the camera; a fitBounds of ours has none. Once the viewer has framed
      // the map themselves, nothing but a new search may reframe it.
      instance.on("movestart", (e) => {
        if ((e as { originalEvent?: unknown }).originalEvent) viewerFramed.current = true;
      });

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
      labels.current = [];
      labelSize.current.clear();
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
    // A refit is owed either because the search changed, or because the frame
    // it was fitted into did. The second case is not hypothetical: on a phone
    // the layout viewport is still settling while the first rows arrive (a URL
    // bar collapsing, an emulator applying its metrics), and a fit computed
    // against the wrong height put the whole country underneath the bottom
    // sheet and left a driver looking at the Canadian Arctic. Once the viewer
    // has moved the map themselves, their frame wins and nothing but a new
    // search touches it.
    const reframed =
      lastFitPad.current !== null &&
      Math.abs(lastFitPad.current - bottomPadding) > 32 &&
      !viewerFramed.current;
    if (fitKey === lastFit.current && !reframed) return;
    const padding = { top: 40, right: 40, bottom: 40 + bottomPadding, left: 40 };
    // A new search snaps; a sheet that has just been dragged to a new stop
    // eases, because the viewer is watching that half of the screen and a jump
    // there reads as the map having reloaded.
    const duration = reframed && fitKey === lastFit.current ? 320 : 0;
    lastFitPad.current = bottomPadding;
    viewerFramed.current = false;

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
        { padding, duration },
      );
      return;
    }

    const box = bboxOf(built.groups.map((g) => [g.lng, g.lat] as [number, number]));
    m.fitBounds(box ?? CONUS, { padding, duration, maxZoom: 9 });
    // Record the key only once there is something real to frame: before the
    // first response lands `built` is empty because nothing has been fetched
    // yet rather than because the search found nothing, and consuming the key
    // there would leave the first result set unframed.
    if (box || lastFit.current !== null) lastFit.current = fitKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [built, ready, bottomPadding]);

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
    const group = key ? built.byKey.get(key) : undefined;
    if (!group) return;

    // One job gets its own line -- lane, size, price, readiness -- because that
    // is what the viewer is about to decide on. A group gets the tally.
    const single = group.ids.length === 1 ? jobs.find((j) => j.id === group.ids[0]) : null;

    popup.current = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14 })
      .setLngLat([group.lng, group.lat])
      .setText(single ? jobSummary(single) : groupSummary(group))
      .addTo(m);
  }, [hoverKey, hoveredId, jobs, built, ready]);

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
    setLabels("route", []);

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
      const ends: Array<{ at: [number, number]; text: string }> = [
        { at: [from.lng, from.lat], text: endLabelText(job, "pickup") },
        {
          at: [to.lng, to.lat],
          text:
            job.cubic_feet != null
              ? `${endLabelText(job, "delivery")} · ${formatCf(job.cubic_feet)}`
              : endLabelText(job, "delivery"),
        },
      ];
      const next: MapLabel[] = [];
      for (const e of ends) {
        const { marker, el } = endMarker(m, e.at, e.text);
        labelMarkers.current.push(marker);
        // The two ends of the job the viewer just opened: the one thing on
        // this map that is never allowed to lose a fight for space.
        next.push({
          kind: "route",
          marker,
          el,
          lng: e.at[0],
          lat: e.at[1],
          anchor: "center",
          base: [10, 0],
          weight: Number.MAX_SAFE_INTEGER,
          fixed: true,
        });
      }
      setLabels("route", next);
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

    const next: MapLabel[] = [];
    for (const group of built.groups) {
      if (group.ids.length < 2) continue;
      const el = document.createElement("div");
      el.className = "map-count nums";
      el.textContent = detailed ? `${group.label} · ${group.ids.length}` : String(group.ids.length);
      el.title = groupSummary(group);
      const marker = new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, -12] })
        .setLngLat([group.lng, group.lat])
        .addTo(m);
      countMarkers.current.push(marker);
      // A badge sits ON its dot, so it outranks a state total: losing it
      // orphans a mark, while a hidden state total still has its dots.
      // Between badges, the bigger pile of freight keeps its number.
      next.push({
        kind: "count",
        marker,
        el,
        lng: group.lng,
        lat: group.lat,
        anchor: "bottom",
        base: [0, -12],
        weight: 1_000_000 + group.cf,
      });
    }
    setLabels("count", next);
  }, [built, detailed, ready, setLabels]);

  // --- state-total pills ---------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    for (const marker of stateMarkers.current) marker.remove();
    stateMarkers.current = [];
    if (detailed) {
      setLabels("state", []);
      return;
    }

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
    const next: MapLabel[] = [];
    for (const [st, t] of totals) {
      const info = STATE_BY_ABBR.get(st);
      if (!info) continue;
      const el = document.createElement("button");
      el.type = "button";
      el.className = "map-pill nums";
      const full = `${st} · ${t.jobs} job${t.jobs === 1 ? "" : "s"} · ${t.cf.toLocaleString("en-US")} cf`;
      // Zoomed all the way out the count is the least of the three: the dots
      // already show where the freight is and the badges already count the
      // piles, so the pill spends its width on the state and the volume.
      el.textContent =
        shortPills ? `${st} · ${t.cf.toLocaleString("en-US")} cf` : full;
      el.title = `${full} — click to filter ${noun} to ${st}`;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        cb.current.onStateClick(st);
      });
      const marker = new maplibregl.Marker({ element: el }).setLngLat([info.lng, info.lat]).addTo(m);
      stateMarkers.current.push(marker);
      next.push({
        kind: "state",
        marker,
        el,
        lng: info.lng,
        lat: info.lat,
        anchor: "center",
        base: [0, 0],
        // The state holding the most freight keeps its label when two collide.
        weight: t.cf,
      });
    }
    setLabels("state", next);
  }, [jobs, end, detailed, ready, shortPills, setLabels]);

  // --- re-place the labels whenever the viewport moves ---------------------
  // On `move`, not `moveend`: markers follow the camera every frame, so waiting
  // for the gesture to finish would show the smudge for the whole of it. One
  // rAF-throttled pass over ~30 cached boxes is pure arithmetic.
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        declutter();
      });
    };
    m.on("move", schedule);
    m.on("resize", schedule);
    schedule();
    return () => {
      m.off("move", schedule);
      m.off("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ready, declutter]);

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
    <div
      ref={shell}
      className="relative h-full w-full"
      /* On a phone the map now runs the full height of the board and the bottom
         sheet floats over its lower half, so anything anchored to the bottom of
         the map -- the legend, and MapLibre's own attribution, which is a
         licence condition and not decoration -- would be underneath it. This is
         how far up they have to sit. Capped in CSS at 55vh: past the half snap
         the map is not what anybody is looking at, and an uncapped value would
         push the legend out through the top of the screen. */
      style={{ "--map-inset-b": `${bottomPadding}px` } as React.CSSProperties}
    >
      <div ref={container} className="h-full w-full" />

      {/* Every floating panel carries data-map-chrome: it is opaque, so the
          label placer has to treat it as occupied ground. */}
      <div
        data-map-chrome
        /* Below `md` this panel is on a map band 261 px tall at the sheet's
           default snap, so it drops to one line and its own title: everything
           hidden here is printed again in the sheet's handle a thumb's width
           below, and a phone cannot afford to say it twice. */
        className="glass absolute left-[var(--sp-3)] top-[var(--sp-3)] max-w-[260px] p-[var(--sp-2)] md:p-[var(--sp-3)]"
        title={`Jobs whose ${end} is on screen, and the cubic feet standing there. Hollow markers sit on a state centroid rather than a real address. Jobs without a stated size are counted but add nothing to the total.`}
      >
        {/* The list header counts the whole result; this counts the viewport.
            Saying which is which costs one small line and stops the two
            reading as the same number printed twice. */}
        <div className="hidden md:block">
          <div className="label">On screen</div>
        </div>
        {/* The map is ready long before the first search answers, so `inView`
            is a truthful 0 over an empty map -- and a confident "All 0 jobs"
            is the wrong thing to say to someone who is waiting. */}
        {inView == null || loading ? (
          <>
            <span className="skeleton h-[16px] w-[150px]" />
            <span className="skeleton mt-[4px] hidden h-[12px] w-[110px] md:block" />
          </>
        ) : (
          <>
            <div className="big nums text-(length:--fs-md) md:text-(length:--fs-lg)">
              {`${allShown ? "All " : ""}${inView.count} job${inView.count === 1 ? "" : "s"} · ${totalCf.toLocaleString("en-US")} cf`}
              <span className="font-normal md:hidden" style={{ color: "var(--muted)" }}>
                {" on screen"}
              </span>
            </div>
            <div className="hidden text-(length:--fs-sm) md:block" style={{ color: "var(--muted)" }}>
              {totalCf > 0
                ? truckLine(totalCf, viewer?.truckCf ?? null)
                : "No stated sizes on screen"}
              {inView.unsized > 0 && ` · ${inView.unsized} without size`}
            </div>
          </>
        )}
        {notPlotted > 0 && (
          <div className="mt-[2px] text-(length:--fs-xs)" style={{ color: "var(--approx)" }}>
            {notPlotted} job{notPlotted === 1 ? " has" : "s have"} no mappable {end}
          </div>
        )}
        {filteredSummary && inView && filteredSummary.count !== inView.count && (
          <div className="text-(length:--fs-xs)" style={{ color: "var(--muted-2)" }}>
            of {filteredSummary.count} filtered
          </div>
        )}

        {/* Inside this panel rather than floating on its own, which is where it
            used to be: on a 390 px map three separate glass cards is two too
            many, and the one it belongs with is this one. The panel answers
            "what is on screen"; the toggle says "and keep the search tied to
            it". */}
        <label className="check-row mt-[var(--sp-1)] border-t border-border pt-[var(--sp-1)] text-(length:--fs-sm) font-medium md:mt-[var(--sp-2)] md:pt-[var(--sp-2)]">
          <input
            type="checkbox"
            checked={searchAsMove}
            onChange={(e) => onSearchAsMoveChange(e.target.checked)}
          />
          Search as I move<span className="hidden md:inline">&nbsp;the map</span>
        </label>
      </div>

      {noRoad && (
        <div
          data-map-chrome
          className="glass absolute left-1/2 top-[var(--sp-3)] -translate-x-1/2 px-[var(--sp-3)] py-[var(--sp-2)] text-(length:--fs-sm)"
          style={{ color: "var(--approx)" }}
        >
          Road route unavailable — showing a straight line.
        </div>
      )}

      <div
        data-map-chrome
        className="glass point-legend px-[var(--sp-3)] py-[var(--sp-2)]"
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

/** A small white label pinned to one end of the selected route. */
function endMarker(
  m: maplibregl.Map,
  at: [number, number],
  text: string,
): { marker: maplibregl.Marker; el: HTMLElement } {
  const el = document.createElement("div");
  el.className = "map-pill nums";
  el.textContent = text;
  const marker = new maplibregl.Marker({ element: el, anchor: "left", offset: [10, 0] })
    .setLngLat(at)
    .addTo(m);
  return { marker, el };
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
