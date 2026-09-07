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
import { LOCATION_KEYS, type StoredLocation } from "@/lib/location";
import { STATE_BY_ABBR } from "@/lib/geo/states";
import { api } from "@/lib/basePath";
import { formatCf, jobSummary, truckLine } from "@/lib/loads/present";
import { corridorRing, intermediatePoint, type Point as LatLng } from "@/lib/geo/math";
import {
  buildGroups,
  endLabelText,
  endPoint,
  groupSummary,
  idsOf,
  pointRadius,
  RADIUS_STOPS,
  RADIUS_ZOOM,
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
  /**
   * The shareable query string. Changes only when the filter set changes,
   * which is the only time we refit -- and it is also how the corridor reaches
   * this map: see `parseCorridorQuery` below.
   */
  fitKey: string;
  /** Height of the mobile sheet, so the route is fitted into the visible half. */
  bottomPadding?: number;
  /** The phone layout: the map band is a fraction of its usual height. */
  compact?: boolean;
  filteredSummary: LoadSummary | null;
  /** The first search has not answered yet; the panel must not report a 0. */
  loading?: boolean;
  /**
   * The board fetch FAILED. Different from `loading` and from an empty result:
   * `jobs` is empty because nothing could be read, so every number the panel
   * would print is a number about nothing. Optional, and false by default, so
   * a caller that does not pass it gets exactly the old behaviour.
   */
  error?: boolean;
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

/**
 * Where a COUNT may go: barely anywhere.
 *
 * A state total is a caption and survives being nudged half a label sideways;
 * a count is bare type with nothing tying it to its dot but proximity, and at
 * 390 px the general slot list threw "15" forty pixels clear of the pile it
 * was counting, where it read as a number belonging to whatever was nearest.
 * Two small steps up and one either shoulder, then nothing -- an unplaceable
 * count is hidden, and the dot underneath keeps its size, its hover and its
 * click.
 */
const COUNT_SLOTS: Array<[number, number]> = [
  [0, 0],
  [0, -11],
  [13, -3],
  [-13, -3],
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
  /**
   * Cubic feet of the marker this label has to sit clear of. Present only on
   * the count badges: their vertical base offset is the dot's drawn radius,
   * which changes with the zoom, so it is read per frame rather than baked in.
   */
  clearOf?: number;
  /** Bare type with no box: it may only be placed touching its own mark. */
  tight?: boolean;
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

/* ------------------------------- the corridor -----------------------------
 *
 * "Near my route" is a real filter with a real shape, and until now the map
 * drew a decoration instead: a flat quad at a hardcoded 100 miles around the
 * viewer-to-home chord, which was neither the width the server used nor the
 * shape it tested nor, once a driver can type a route of their own, the right
 * pair of endpoints.
 *
 * Where the numbers come from: the QUERY STRING, which is this product's one
 * description of a search -- the same keys `searchParams.ts` parses on the way
 * in (`routeMode=corridor`, `corridor`, `originLat`/`originLng`,
 * `destLat`/`destLng`, and the `origin`/`dest` labels). Reading them here
 * rather than taking a prop means whichever control emits them -- today's
 * Toward-home toggle, tomorrow's typed route and width slider -- lights up the
 * same band with no second contract to keep in step. `fitKey` is that string:
 * the Board passes the URL it just wrote.
 *
 * What is NOT in the shareable URL is the viewer's own coordinates, on
 * purpose (`location.ts`: a position is the one thing a job board should not
 * keep). So an endpoint the query does not carry falls back to the stored slot
 * that produced it -- current for the origin, home for the destination -- and
 * an endpoint with neither draws nothing at all rather than a guessed band.
 */

/**
 * The server's own default when a corridor search arrives with no width.
 * Kept in step with DEFAULT_CORRIDOR_MILES in `lib/loads/query.ts` by hand:
 * that module reaches the database driver and cannot be imported here. Drawing
 * a different number would be the map disagreeing with the filter.
 */
const DEFAULT_CORRIDOR_MILES = 75;

interface CorridorQuery {
  miles: number;
  origin: LatLng | null;
  destination: LatLng | null;
  originLabel: string | null;
  destLabel: string | null;
}

/** The corridor as it can actually be drawn: both ends resolved. */
interface Corridor extends CorridorQuery {
  origin: LatLng;
  destination: LatLng;
}

function queryPoint(sp: URLSearchParams, latKey: string, lngKey: string): LatLng | null {
  const lat = Number(sp.get(latKey));
  const lng = Number(sp.get(lngKey));
  if (!sp.get(latKey) || !sp.get(lngKey)) return null;
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/** `routeMode=corridor` and everything that describes it, or null. */
function parseCorridorQuery(query: string): CorridorQuery | null {
  const sp = new URLSearchParams(query);
  if (sp.get("routeMode") !== "corridor") return null;
  const miles = Number(sp.get("corridor"));
  return {
    miles: Number.isFinite(miles) && miles > 0 ? miles : DEFAULT_CORRIDOR_MILES,
    origin: queryPoint(sp, "originLat", "originLng"),
    destination: queryPoint(sp, "destLat", "destLng"),
    originLabel: sp.get("origin"),
    destLabel: sp.get("dest"),
  };
}

/** Two positions the same marker would be drawn on, to within ~half a mile. */
function samePlace(a: LatLng, b: LatLng | null | undefined): boolean {
  return b != null && Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lng - b.lng) < 0.01;
}

/**
 * Free space, in cubic feet: how much of the truck is EMPTY, which is a
 * different number from how big the truck is and the only one a fit is
 * measured against.
 *
 * Read straight out of the stored location record rather than off the
 * `StoredLocation` the Board hands down, because `StoredLocation` does not
 * carry the field yet and `parseStored` drops what it does not know. There is
 * no input for it anywhere in the product today, which is recorded in
 * `.design/impl/wave1-map.md`: this reads the key the input will write, so the
 * fit lines below come alive the moment it exists, and shows nothing until
 * then. When the field lands on `StoredLocation`, this whole function becomes
 * `viewer.freeCf` and should go.
 */
function readFreeSpaceCf(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LOCATION_KEYS.current);
    if (!raw) return null;
    const value = JSON.parse(raw) as { freeCf?: unknown };
    const cf = value?.freeCf;
    return typeof cf === "number" && Number.isFinite(cf) && cf > 0 ? cf : null;
  } catch {
    // Private mode, blocked storage, or a half-written record.
    return null;
  }
}

/**
 * "57% of your 700 cf free · 300 cf left", and its honest other half,
 * "129% of your 700 cf free · 200 cf over".
 *
 * A percentage of a truck is the one number on this map that a driver could
 * read as a promise, so the sentence it sits in never says "fits": volume is
 * the only thing being compared, and the caveat under it says so.
 */
function fitAgainstFreeSpace(cf: number, freeCf: number): string {
  const pct = Math.round((cf / freeCf) * 100);
  const left = freeCf - cf;
  const size = freeCf.toLocaleString("en-US");
  return left >= 0
    ? `${pct}% of your ${size} cf free · ${left.toLocaleString("en-US")} cf left`
    : `${pct}% of your ${size} cf free · ${Math.abs(left).toLocaleString("en-US")} cf over`;
}

/** The palette, read from globals.css once the document exists. */
interface Palette {
  accent: string;
  accentHover: string;
  pickup: string;
  delivery: string;
  approx: string;
  you: string;
  home: string;
  /** The wash the basemap tiles are blended into. */
  paper: string;
  /** The two ends of the selected route's gradient. */
  routeStart: string;
  routeEnd: string;
  /** The ink every soft shadow on this map is made of. */
  ink: string;
}

const FALLBACK: Palette = {
  accent: "#2563eb",
  accentHover: "#1d4ed8",
  pickup: "#2563eb",
  delivery: "#0f172a",
  approx: "#b45309",
  you: "#059669",
  home: "#0f172a",
  paper: "#e6ebf2",
  routeStart: "#2563eb",
  routeEnd: "#0f172a",
  ink: "#0f172a",
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
    paper: pick("--map-paper", FALLBACK.paper),
    routeStart: pick("--route-start", FALLBACK.routeStart),
    routeEnd: pick("--route-end", FALLBACK.routeEnd),
    ink: pick("--text", FALLBACK.ink),
  };
}

/**
 * Marker radius from the group's total cubic feet.
 *
 * On the square root, so the AREA of the dot tracks the volume: a marker twice
 * the radius of another reads as four times the freight, which is what the eye
 * actually compares. Interpolated with zoom as the arcs' widths were, so the
 * national view stays readable without the city view turning into blobs.
 *
 * The stops live in `points.ts` because the count badge has to sit clear of
 * the circle, which means something outside the paint expression needs the
 * same number. Two copies of this curve is one copy too many.
 */
const RADIUS_BY_CF: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["sqrt", ["max", 0, ["coalesce", ["get", "cf"], 0]]],
  ...RADIUS_STOPS.flat(),
] as maplibregl.ExpressionSpecification;

function zoomRadius(extra = 0): maplibregl.ExpressionSpecification {
  const at = (scale: number): maplibregl.ExpressionSpecification =>
    extra === 0 ? ["*", RADIUS_BY_CF, scale] : ["+", ["*", RADIUS_BY_CF, scale], extra];
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    RADIUS_ZOOM[0]![0],
    at(RADIUS_ZOOM[0]![1]),
    RADIUS_ZOOM[1]![0],
    at(RADIUS_ZOOM[1]![1]),
  ];
}

/**
 * How present a marker is: full when nothing is focused, faint when something
 * else is.
 *
 * `weight` grades the top end by freight. A flat mid-blue disc at every size
 * is a legend, not a picture -- 200 cf and 15,500 cf differ only in how big
 * they are, and at the national view the small one is eight pixels across and
 * the difference is gone. Grading opacity as well means the eye reads the big
 * piles first and the small ones as the texture around them, which is the
 * order a driver wants them in.
 */
function presence(weight: number): maplibregl.ExpressionSpecification {
  return [
    "case",
    // Dimmed, not deleted. At 0.18 -- what the arcs-everywhere map used, where
    // a dimmed line still had its own shape -- a whole screenful of dots went
    // to ghosts the moment the pointer touched a card, and a board whose
    // inventory vanishes while you read one row of it is worse than one that
    // never highlighted anything.
    ["boolean", ["feature-state", "dim"], false],
    weight * 0.36,
    [
      "interpolate",
      ["linear"],
      ["sqrt", ["max", 0, ["coalesce", ["get", "cf"], 0]]],
      0,
      weight * 0.74,
      30,
      weight * 0.88,
      90,
      weight,
    ],
  ];
}

/** A guessed coordinate is drawn out of focus. See the approx note below. */
const APPROX_BLUR: maplibregl.ExpressionSpecification = [
  "case",
  ["get", "approx"],
  0.6,
  0,
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

/**
 * Normalise whatever was thrown into an `Error` the boundary can print.
 *
 * The WebGL case needs one specific piece of care. MapLibre does not throw
 * `new Error("Failed to initialize WebGL")` -- it JSON-stringifies the whole
 * `webglcontextcreationerror` event into the message, so `.message` arrives as
 * a 300-character blob of requested context attributes with the two useful
 * fields buried in it. Printed raw under "Map unavailable" that is noise; the
 * two fields, though, are exactly what a visitor and a support reply both need:
 * "Failed to initialize WebGL — disabled by enterprise policy or commandline
 * switch" says whose problem this is and roughly why.
 */
function asError(err: unknown): Error {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err != null && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err);

  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as { message?: unknown; statusMessage?: unknown };
      const head = typeof parsed.message === "string" ? parsed.message : "";
      const why = typeof parsed.statusMessage === "string" ? parsed.statusMessage : "";
      const joined = [head, why].filter(Boolean).join(" — ");
      if (joined) return new Error(joined);
    } catch {
      // Not JSON after all; fall through and use it as it came.
    }
  }
  return err instanceof Error && raw === err.message
    ? err
    : new Error(raw || "The map could not start");
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
  compact = false,
  filteredSummary,
  loading = false,
  error = false,
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
  /**
   * The map cannot draw at all: WebGL refused, or the style could not be built.
   * Held here and re-thrown during render so `MapBoundary` in `Board` handles
   * it -- see the note above that throw.
   */
  const [failure, setFailure] = useState<Error | null>(null);
  /**
   * A DIFFERENT and much smaller failure: the basemap's tiles are not arriving,
   * but the map itself is alive and the job markers are drawn over the paper
   * background exactly as they always were. Geography goes missing; the board
   * does not. It gets a quiet line, not the unavailable panel.
   */
  const [tilesDown, setTilesDown] = useState(false);
  /** One flaky tile is weather; a dozen is an outage or a blocked host. */
  const tileErrors = useRef(0);

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

  /**
   * The corridor to draw, or null. See the note above `parseCorridorQuery`.
   *
   * `towardHome` is the same switch arriving as a prop, and it is kept as a
   * second way in so the existing toggle cannot be broken by a query string
   * that stops carrying `routeMode` -- but the width and the endpoints come
   * from the query wherever it has them, so a control that changes either one
   * changes the band without touching this component.
   */
  const corridor = useMemo<Corridor | null>(() => {
    const q = parseCorridorQuery(fitKey);
    if (!q && !towardHome) return null;
    const spec: CorridorQuery = q ?? {
      miles: DEFAULT_CORRIDOR_MILES,
      origin: null,
      destination: null,
      originLabel: null,
      destLabel: null,
    };
    const origin = spec.origin ?? (viewer ? { lat: viewer.lat, lng: viewer.lng } : null);
    const destination = spec.destination ?? (home ? { lat: home.lat, lng: home.lng } : null);
    // Half a corridor is not a corridor. A search can be running in corridor
    // mode with the coordinates deliberately kept out of the shareable URL and
    // the slot that held them since cleared; the honest picture of that is no
    // band, not a band drawn from whatever is left.
    if (!origin || !destination) return null;
    return {
      ...spec,
      origin,
      destination,
      originLabel: spec.originLabel ?? viewer?.label ?? null,
      destLabel: spec.destLabel ?? home?.label ?? null,
    };
  }, [fitKey, towardHome, viewer, home]);

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

    // The marks themselves are occupied ground too. Without this a state total
    // is free to land squarely on the dot it is counting -- "CA · 15,500 cf"
    // printed across the pile in Los Angeles -- which hides the one thing on
    // the map that is not text. The boxes are the drawn discs plus a hairline
    // of air; a count badge already clears its own dot, so what this really
    // stops is a label covering somebody ELSE's.
    const z = m.getZoom();
    for (const group of groups.current) {
      const at = m.project([group.lng, group.lat]);
      if (at.x < -60 || at.y < -60 || at.x > vw + 60 || at.y > vh + 60) continue;
      const r = pointRadius(group.cf, z) + 2;
      taken.push([at.x - r, at.y - r, at.x + r, at.y + r]);
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

      // A count badge hangs off the top of a dot whose radius is a function of
      // freight and zoom, so its resting offset is read here rather than being
      // fixed when the marker was made.
      const base: [number, number] =
        l.clearOf == null
          ? l.base
          // One pixel more than the air reserved around the disc above, so a
          // badge does not read as colliding with its own dot and get bumped
          // twenty pixels up the map for nothing.
          : [l.base[0], -(pointRadius(l.clearOf, m.getZoom()) + 7)];

      const slots = l.fixed
        ? [[0, 0] as [number, number]]
        : l.tight
          ? COUNT_SLOTS
          : LABEL_SLOTS;

      let placed = false;
      for (const [dx, dy] of slots) {
        const oy = base[1] + dy;
        const cx = at.x + base[0] + dx;
        const cy = at.y + oy;
        const natural = l.anchor === "left" ? cx : cx - w / 2;
        const top = l.anchor === "bottom" ? cy - h : cy - h / 2;
        // Slide a label that would run past a side back inside, rather than
        // hiding it or letting it clip. "FL · 4,900 cf" is 90 px on a 390 px
        // map, so on a phone the whole eastern seaboard is within half a label
        // of the edge, and hiding all of it is not decluttering. The shift is
        // applied BEFORE the collision test, so what is checked is where the
        // label will actually be drawn -- and it applies to the route's two end
        // labels as well, which are the only ones that may not be hidden and so
        // were the only ones that could still come out clipped.
        let shift = 0;
        if (natural - LABEL_PAD < 2) shift = 2 - (natural - LABEL_PAD);
        else if (natural + w + LABEL_PAD > vw - 2) shift = vw - 2 - (natural + w + LABEL_PAD);
        const ox = base[0] + dx + shift;
        const left = natural + shift;
        const box: Box = [left - LABEL_PAD, top - LABEL_PAD, left + w + LABEL_PAD, top + h + LABEL_PAD];
        if (!l.fixed) {
          // Vertically there is nowhere to slide to: the label belongs beside
          // its point, and a map is taller than one label everywhere it
          // matters. Try another slot, or none.
          if (box[1] < 2 || box[3] > vh - 2) continue;
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

    const options: maplibregl.MapOptions = {
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
        // THE BASEMAP KEEPS ITS COLOUR. It is a map of the country, and a
        // country has green in it.
        //
        // Two recipes were tried before this one and both went the same way.
        // -0.75 saturation left a quarter of OSM's colour behind and the land
        // came out olive; -0.85 over a cool paper at 70% went the rest of the
        // way and bleached the country flat, which is the version the user
        // rejected in three words: "more green colors". Measured, that map put
        // Maine's woodland and Montana's plains at the SAME rgb(237, 238, 240)
        // and the Atlantic seven points off it -- a whole continent rendered as
        // one grey with a slightly bluer grey beside it.
        //
        // So the desaturation is gone. OpenStreetMap's own palette does the
        // work it was drawn to do: woodland green, water blue, cities warm,
        // terrain visible. Only two adjustments are left, and neither touches
        // hue:
        //
        //  - `brightness-min: 0.2` lifts the tile's black floor to a mid grey.
        //    This is what keeps the basemap UNDER the board: OSM's place names
        //    and its motorway ink stop being the darkest thing on screen, and
        //    the darkest thing on screen becomes a job.
        //  - `contrast: -0.06` with `opacity: 0.93` over --map-paper takes the
        //    hard edge off the road web at city zooms and gives the whole frame
        //    one ground to sit on.
        //
        // Measured on the painted canvas at the national view -- Pennsylvania
        // woodland rgb(193, 217, 182), the Atlantic rgb(189, 217, 225),
        // farmland rgb(239, 237, 232): green is green (G-R +24), water is blue
        // (B-R +36), and the land between them is neither. The old map could
        // not tell any of those three apart.
        //
        // And the board still wins. A job point is #2563eb -- chroma 198 at
        // luminance 99 -- against a basemap whose loudest pixel anywhere in a
        // busy northeast frame is chroma 77 at luminance 200. Nothing OSM draws
        // is within a factor of two of the marks in either register, which is
        // why the marks did not need the map bleached; they needed it lifted.
        //
        // (The tile host is unchanged. CARTO Positron would give a pale map for
        // free but now stamps "API KEY REQUIRED" over unauthenticated tiles.)
        layers: [
          { id: "paper", type: "background", paint: { "background-color": colors.paper } },
          {
            id: "basemap",
            type: "raster",
            source: "basemap",
            paint: {
              "raster-saturation": 0,
              "raster-contrast": -0.06,
              "raster-brightness-min": 0.2,
              "raster-opacity": 0.93,
            },
          },
        ],
      },
      bounds: CONUS,
      fitBoundsOptions: { padding: 40 },
    };

    // THE THROW THIS FILE'S ERROR HANDLING EXISTS FOR.
    //
    // `new maplibregl.Map()` calls `_setupPainter`, which asks the canvas for a
    // WebGL context and throws "Failed to initialize WebGL" SYNCHRONOUSLY when
    // it does not get one: a machine with no GPU acceleration, an enterprise
    // policy, a hardened browser, a VM, `--disable-3d-apis`. This is a React
    // effect, so before this try/catch that throw walked straight past every
    // component to Next's built-in global handler, which replaced the whole
    // document with "This page couldn't load" -- no list, no filters, no jobs,
    // on every route that mounts the board, `/jobs/[id]` deep links included.
    // The map is the only thing here that needs a GPU, so the map is the only
    // thing that may go missing when there is not one.
    let instance: maplibregl.Map;
    try {
      instance = new maplibregl.Map(options);
    } catch (err) {
      console.error("[LoadMap] could not start", err);
      setFailure(asError(err));
      return;
    }
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
    //
    // MapLibre reports these ASYNCHRONOUSLY, on its own event channel -- an
    // error boundary will never see one, which is why this is handled here at
    // the point of failure rather than left to `MapBoundary`. And it is a
    // strictly smaller failure than a map that will not start: every job marker
    // is still drawn, over the paper background instead of over streets. So it
    // gets a line, not the unavailable panel.
    let reported = false;
    instance.on("error", (e) => {
      const message = e.error?.message ?? String(e);
      if (/tile/i.test(message)) {
        // A single 404 at an odd zoom is normal; a wall of them is a blocked
        // host or an outage. Waiting for a few keeps the notice honest.
        tileErrors.current += 1;
        if (tileErrors.current >= 4) setTilesDown(true);
        if (reported) return;
        reported = true;
      }
      console.error("[LoadMap]", message);
    });

    // Everything the style needs, built once the base style is in. It is
    // wrapped below because a throw in here would be inside MapLibre's own
    // event dispatch -- outside React's call stack, where no boundary and no
    // effect can catch it -- and would leave a half-built map that draws a
    // basemap and no jobs, with nothing on screen saying so.
    const build = () => {
      const image = chevronImage();
      if (image && !instance.hasImage("chevron")) {
        instance.addImage("chevron", image, { sdf: true });
      }

      instance.addSource("points", { type: "geojson", data: EMPTY, promoteId: "key" });
      // `lineMetrics` is what makes `line-gradient` legal on the road: it
      // darkens from the pickup toward the delivery, and a gradient needs to
      // know how far along the line each pixel is.
      instance.addSource("road", { type: "geojson", data: EMPTY, lineMetrics: true });
      instance.addSource("toward", { type: "geojson", data: EMPTY });

      // The route corridor sits under everything: it is context, not content.
      instance.addLayer({
        id: "toward-fill",
        type: "fill",
        source: "toward",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": colors.you, "fill-opacity": 0.06 },
      });
      // Where the corridor STOPS. A 6%-opacity wash has no edge a driver can
      // point at, and the edge is the whole claim the band is making: a job
      // outside this line was not in the result. Thin and quiet -- it is a
      // boundary, not a route.
      instance.addLayer({
        id: "toward-edge",
        type: "line",
        source: "toward",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "line-color": colors.you, "line-width": 1, "line-opacity": 0.35 },
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
      // The two ends of a typed route, which -- unlike the viewer's own two
      // slots -- have no marker of their own. Emitted only when they are not
      // already under one; see `corridorFeatures`.
      instance.addLayer({
        id: "toward-ends",
        type: "circle",
        source: "toward",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 4,
          "circle-color": colors.you,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fff",
          "circle-opacity": 0.9,
        },
      });

      // The soft ground a marker sits on. Two jobs at once: it lifts the dot
      // off the basemap the way a drop shadow lifts a card, and -- because its
      // opacity is graded by freight -- it is the difference between a 200 cf
      // dot and a 15,500 cf one at a glance, before the radius is even read.
      instance.addLayer({
        id: "points-lift",
        type: "circle",
        source: "points",
        filter: ["!", ["get", "approx"]],
        paint: {
          "circle-radius": zoomRadius(4),
          "circle-color": colors.pickup,
          "circle-blur": 0.9,
          "circle-opacity": [
            "case",
            ["boolean", ["feature-state", "dim"], false],
            0.03,
            [
              "interpolate",
              ["linear"],
              ["sqrt", ["max", 0, ["coalesce", ["get", "cf"], 0]]],
              0,
              0.05,
              40,
              0.13,
              110,
              0.22,
            ],
          ],
        },
      });

      // One circle layer, not two. An approximate point is the same mark, out
      // of focus: no ring, lower opacity, and a soft edge.
      //
      // It used to be a hollow white disc inside a 2.5 px amber ring, and in
      // Deliveries mode -- where most ends resolve only to a ZIP centroid or a
      // state -- that turned the entire map into a field of orange rings
      // shouting about our own uncertainty, louder than any of the freight.
      // Keeping the amber as a thin ring on a blurred dot was tried next and
      // was worse in a different way: a warm halo bleeding around a cool core
      // reads as a rust stain, not as a caveat.
      //
      // So the amber is gone from the mark entirely and softness carries the
      // meaning, which is the honest form of it -- this dot is literally not
      // sharp because we do not know where it is. The WORD is not lost: it is
      // on the hover card, in amber, at the moment somebody asks about that
      // dot, and on the job's own card as a chip. A caveat every mark wears
      // permanently is not a caveat, it is a texture.
      instance.addLayer({
        id: "points",
        type: "circle",
        source: "points",
        paint: {
          "circle-color": colors.pickup,
          "circle-radius": zoomRadius(),
          "circle-blur": APPROX_BLUR,
          // 0.72, not the 0.52 this started at. The soft mark was tuned
          // against a bleached map where every square inch of ground was
          // rgb(237, 238, 240); on a map with green in it a 44%-opacity navy
          // cloud over Appalachian woodland measured a contrast of 2.02, which
          // is a smudge, not a mark. Blur is what says "we guessed" -- opacity
          // was only ever saying "there are a lot of us", and the map is no
          // longer pale enough to afford that. The blur is untouched.
          "circle-opacity": ["case", ["get", "approx"], presence(0.72), presence(0.94)],
          // The zoom step has to be the OUTERMOST expression -- MapLibre will
          // not take a ["zoom"] input nested inside a ["case"] -- so the
          // approximate/exact choice is made once per stop instead.
          "circle-stroke-width": [
            "step",
            ["zoom"],
            ["case", ["get", "approx"], 0, 1.7],
            5,
            ["case", ["get", "approx"], 0, 2.1],
          ],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-opacity": presence(1),
        },
      });

      // Feature-state cannot appear in a layer filter, so the highlight ring
      // draws over every point and hides all but the active one in paint. Two
      // rings, not one: a white gap between the dot and the accent ring is
      // what makes a selected marker read as lifted rather than as merely
      // outlined, and on a busy northeast it is the only thing that survives a
      // neighbour sitting four pixels away.
      instance.addLayer({
        id: "points-active-gap",
        type: "circle",
        source: "points",
        paint: {
          "circle-color": "rgba(0,0,0,0)",
          "circle-radius": zoomRadius(2.5),
          "circle-stroke-width": 2.5,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-opacity": [
            "case",
            ["boolean", ["feature-state", "active"], false],
            0.95,
            0,
          ],
        },
      });
      instance.addLayer({
        id: "points-active",
        type: "circle",
        source: "points",
        paint: {
          "circle-color": "rgba(0,0,0,0)",
          "circle-radius": zoomRadius(4.75),
          "circle-stroke-width": 2,
          "circle-stroke-color": colors.accentHover,
          "circle-stroke-opacity": [
            "case",
            ["boolean", ["feature-state", "active"], false],
            0.9,
            0,
          ],
        },
      });

      // The selected job's road, drawn ON TOP of the points: it is the one
      // thing on screen that is about a decision rather than an inventory.
      // A wide, very faint wash under the casing: without it the route is a
      // hard white-edged ribbon dropped on the map, and with it the road has a
      // shadow and belongs to the country it crosses.
      instance.addLayer({
        id: "route-glow",
        type: "line",
        source: "road",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": colors.ink, "line-width": 15, "line-opacity": 0.06, "line-blur": 6 },
      });
      instance.addLayer({
        id: "route-casing",
        type: "line",
        source: "road",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": 9.5, "line-opacity": 0.95 },
      });
      // Six pixels rather than four so the direction chevrons sit INSIDE the
      // stroke: a white arrow on a thin line bleeds into its own white casing
      // and the direction stops being readable, which is most of what the line
      // is for.
      //
      // Graded from --route-start to --route-end along its own length, so the
      // stroke carries the direction of travel even where the chevrons fall
      // between two tight turns.
      instance.addLayer({
        id: "route-road",
        type: "line",
        source: "road",
        filter: ["get", "road"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-width": 6,
          "line-gradient": [
            "interpolate",
            ["linear"],
            ["line-progress"],
            0,
            colors.routeStart,
            0.7,
            colors.accentHover,
            1,
            colors.routeEnd,
          ],
        },
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
    };

    instance.on("load", () => {
      try {
        build();
      } catch (err) {
        console.error("[LoadMap] could not build the style", err);
        setFailure(asError(err));
      }
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
    // One colour for every marker, guessed or not: the approximate ones are
    // told apart by being soft, not by being a different thing.
    m.setPaintProperty("points", "circle-color", solid);
    m.setPaintProperty("points-lift", "circle-color", solid);
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

    // The corridor's own box answers "what counts as on my way", which is the
    // question only while a route is set. The box is the BAND, not the two
    // endpoints it runs between: a corridor framed to its centre line puts
    // half its own width off screen at both edges, so the jobs nearest the
    // limit -- the ones a driver is deciding about -- are the ones cropped.
    // With no route the map has to frame the search instead, or an explicit
    // pickup/delivery filter draws nothing on it.
    const band = corridor
      ? bboxOf(corridorRing(corridor.origin, corridor.destination, corridor.miles))
      : null;
    if (band) {
      lastFit.current = fitKey;
      m.fitBounds(band, { padding, duration });
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

  /* ------------------------------ what is hovered --------------------------
   *
   * A hover names a PLACE -- the marker's group -- and, when that place holds
   * exactly one job, the job as well. Nothing is drawn for it beyond the
   * highlight the effect above applies and the card the effect below opens.
   *
   * A curve was tried here and taken back out. It is not that one arc looks
   * bad; it is that this map's plot is the points, and a line that appears and
   * vanishes as the pointer runs down a list of forty cards animates the whole
   * country while somebody is trying to read one row of it. The route the
   * board actually promises is the REAL one, from HERE's truck router, and it
   * is drawn for the job a driver opens -- deliberately, once, and it stays.
   */
  const hovered = useMemo(() => {
    const key = hoverKey ?? (hoveredId != null ? built.keyByJob.get(hoveredId) : undefined);
    const group = key ? built.byKey.get(key) : undefined;
    if (!group) return null;
    // One job gets its own line -- lane, size, price, readiness -- because that
    // is what the viewer is about to decide on. A place gets the tally.
    const single =
      group.ids.length === 1 ? (jobs.find((j) => j.id === group.ids[0]) ?? null) : null;
    return { key: group.key, group, single };
  }, [hoverKey, hoveredId, jobs, built]);

  // --- hover card ----------------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    popup.current?.remove();
    popup.current = null;
    if (!hovered) return;
    const { group, single } = hovered;

    // Two lines for one job -- the lane on top, the rest of the row beneath --
    // because a single 90-character sentence is not a card, it is a ticker.
    const box = document.createElement("div");
    box.className = "map-hover";
    const title = document.createElement("div");
    title.className = "t";
    const caption = document.createElement("div");
    caption.className = "s";

    if (single) {
      // `jobSummary` leads with "Kearny, NJ → FL 34957" and joins the rest
      // with the same separator; a place label never contains one, so the
      // first piece is the lane and everything after it is the detail.
      const line = jobSummary(single);
      const cut = line.indexOf(" · ");
      title.textContent = cut < 0 ? line : line.slice(0, cut);
      caption.textContent = cut < 0 ? "" : line.slice(cut + 3);
    } else {
      // "Rochester, MN · 11 jobs · 6,006 cf" is already the whole answer for a
      // place, and it is the tally the marker's size is drawn from.
      title.textContent = groupSummary(group);
      caption.textContent = "";
    }

    box.append(title);
    if (caption.textContent) box.append(caption);

    // Why this job is in a corridor search at all, in the two numbers the API
    // already computed and nothing rendered: how far off the route its pickup
    // stands, and what taking it adds to the drive. Only for a single job --
    // a place holding eleven of them has eleven different answers, and one of
    // them printed as if it were the place's is exactly the kind of tidy
    // half-truth this map keeps refusing to tell.
    if (single) {
      const off = single.off_route_miles;
      const detour = single.detour_miles;
      const parts: string[] = [];
      if (off != null) parts.push(`${off.toLocaleString("en-US")} mi off your route`);
      if (detour != null) parts.push(`+${detour.toLocaleString("en-US")} mi of driving`);
      if (parts.length) {
        const why = document.createElement("div");
        why.className = "s";
        why.textContent = parts.join(" · ");
        box.append(why);
      }
    }
    // The soft dots do not wear their caveat; this is where it is worn.
    if (group.approx) {
      const q = document.createElement("div");
      q.className = "q";
      q.textContent =
        group.ids.length === 1
          ? "Approximate location — no street address posted"
          : "Approximate locations — no street address posted";
      box.append(q);
    }

    popup.current = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      // Clear of the dot rather than 14 px clear of its centre: a 15,500 cf
      // marker is twenty pixels of radius, and a card pinned inside it covers
      // the mark the card is about.
      offset: Math.round(pointRadius(group.cf, m.getZoom())) + 9,
    })
      .setLngLat([group.lng, group.lat])
      .setDOMContent(box)
      .addTo(m);
  }, [hovered, ready]);

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

  // --- the route corridor --------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    const source = m.getSource("toward") as GeoJSONSource | undefined;
    if (!source) return;
    source.setData(corridor ? corridorFeatures(corridor, viewer, home) : EMPTY);
  }, [corridor, viewer, home, ready]);

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
      if (detailed) {
        // Zoomed in the badge is carrying the place's NAME as well, so it is
        // no longer a badge -- it joins the pill family, with the count in the
        // dot's own colour so the two halves stay legible as two facts.
        el.className = "map-pill map-place nums";
        const k = document.createElement("span");
        k.className = "k";
        k.textContent = group.label;
        const n = document.createElement("span");
        n.className = "n";
        n.textContent = String(group.ids.length);
        el.append(k, n);
      } else {
        // Zoomed out it is a count and nothing else, so it is drawn as one:
        // small, round, and in the colour of the dot it belongs to. As another
        // white lozenge it competed with the state totals at the same weight,
        // and two different kinds of fact looked like one kind.
        el.className = "map-count nums";
        el.textContent = String(group.ids.length);
      }
      el.dataset.end = end;
      if (group.approx) el.dataset.approx = "";
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
        // The dot this badge belongs to is between 4 and 24 px of radius
        // depending on zoom and freight; a fixed 12 px lift meant every marker
        // over 12 px swallowed its own count. The placer re-reads the radius
        // each frame instead.
        clearOf: group.cf,
        // Only the bare numeral is held on a short leash; once it has a box
        // and a place name it is a caption and can be nudged like one.
        tight: !detailed,
        weight: 1_000_000 + group.cf,
      });
    }
    setLabels("count", next);
  }, [built, detailed, end, ready, setLabels]);

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
      // Two spans, not one string: the state is the thing and the totals are
      // its measurement, and setting them in one weight made every pill a wall
      // of equal-value text. The separator between them is the gap.
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = st;
      const v = document.createElement("span");
      v.className = "v";
      // Zoomed all the way out the count is the least of the three: the dots
      // already show where the freight is and the badges already count the
      // piles, so the pill spends its width on the state and the volume.
      v.textContent = shortPills
        ? `${t.cf.toLocaleString("en-US")} cf`
        : `${t.jobs} job${t.jobs === 1 ? "" : "s"} · ${t.cf.toLocaleString("en-US")} cf`;
      el.append(k, v);
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

  // --- retrying just the tiles ---------------------------------------------
  // Pointing the raster source at its URL again is what makes MapLibre drop the
  // tiles it has already given up on and ask for them afresh. Nothing else is
  // touched: the map keeps its viewport, the markers stay where they are, and
  // the board is not re-fetched -- the jobs were never the thing that failed.
  const retryTiles = useCallback(() => {
    const m = map.current;
    if (!m) return;
    tileErrors.current = 0;
    setTilesDown(false);
    const source = m.getSource("basemap");
    if (source instanceof maplibregl.RasterTileSource) source.setTiles([BASEMAP_TILES]);
  }, []);

  const totalCf = inView?.cf ?? 0;
  const allShown = inView != null && inView.count >= jobs.length;
  const notPlotted = jobs.length - built.plotted;

  // Re-read on every write to the location record, which is what `setAt`
  // stamps -- and not on every render, which on this component means once per
  // card the pointer crosses.
  const locationStamp = viewer?.setAt ?? null;
  const freeCf = useMemo(() => (locationStamp ? readFreeSpaceCf() : null), [locationStamp]);
  /**
   * The one job the panel can say something about: the open one, or the one
   * under the pointer. Selection wins -- it is deliberate, and a fit line that
   * changed while the driver ran their eye down the list would be unreadable.
   */
  const focusJob = useMemo(() => {
    const id = selectedId ?? hoveredId;
    return id == null ? null : (jobs.find((j) => j.id === id) ?? null);
  }, [selectedId, hoveredId, jobs]);
  const noRoad = selectedId != null && route?.id === selectedId && route.road.path == null;

  // The map is not going to draw. Re-throwing here, rather than rendering a
  // message in place, hands the whole map subtree to `MapBoundary` in `Board`
  // in one piece -- so the "on screen" panel, the legend and the location nudge
  // go with it instead of floating over a dead rectangle, and the boundary's
  // `reset()` brings this component back mounted from scratch. Everything
  // outside the boundary -- the rows, the filters, the open job -- is untouched.
  //
  // A render throw is also the only reliable way to reach a boundary from here:
  // the failures above happen in an effect and in a MapLibre event callback,
  // and React catches neither of those the way it catches a render.
  if (failure) throw failure;

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
        /* On a phone this panel is on a map band 261 px tall at the sheet's
           default snap, and in landscape the whole board is 267 px, so it drops
           to one line and its own title: everything hidden here is printed
           again in the list header a thumb's width away, and neither screen
           can afford to say it twice. */
        className={`glass absolute left-[var(--sp-3)] top-[var(--sp-3)] max-w-[260px] ${compact ? "p-[var(--sp-2)]" : "p-[var(--sp-3)]"}`}
        title={`Jobs whose ${end} is on screen, and the cubic feet standing there. Hollow markers sit on a state centroid rather than a real address. Jobs without a stated size are counted but add nothing to the total.`}
      >
        {/* The list header counts the whole result; this counts the viewport.
            Saying which is which costs one small line and stops the two
            reading as the same number printed twice. */}
        {compact ? null : <div className="label">On screen</div>}
        {/* The map is ready long before the first search answers, so `inView`
            is a truthful 0 over an empty map -- and a confident "All 0 jobs"
            is the wrong thing to say to someone who is waiting.

            The board fetch FAILING is the same failure one step further on:
            `inView` is then a real measurement of a real empty map, which is
            how this panel came to answer "All 0 jobs · 0 cf" to a visitor
            whose board could not be read at all. Nothing is wrong with the
            arithmetic; the input is not a result. It takes a prop because the
            alternative -- inferring the failure from `filteredSummary == null`
            once loading is over -- reads a private detail of how the Board
            handles its own error, and would go back to lying, silently, the
            day that changes. */}
        {error ? (
          <div className="text-(length:--fs-sm)" style={{ color: "var(--approx)" }}>
            {compact ? "Jobs could not be loaded" : "Jobs could not be loaded — nothing to count."}
          </div>
        ) : inView == null || loading ? (
          <>
            <span className="skeleton h-[16px] w-[150px]" />
            {compact ? null : <span className="skeleton mt-[4px] h-[12px] w-[110px]" />}
          </>
        ) : (
          <>
            <div className={compact ? "big nums text-(length:--fs-md)" : "big nums text-(length:--fs-lg)"}>
              {`${allShown ? "All " : ""}${inView.count} job${inView.count === 1 ? "" : "s"} · ${totalCf.toLocaleString("en-US")} cf`}
              {compact && (
                <span className="font-normal" style={{ color: "var(--muted)" }}>
                  {" on screen"}
                </span>
              )}
            </div>
            {compact ? null : (
              <div className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
                {totalCf > 0
                  ? truckLine(totalCf, viewer?.truckCf ?? null)
                  : "No stated sizes on screen"}
                {/* Total capacity and free space are two different numbers and
                    this line has always quoted the first one. Saying the
                    second one next to it is the whole distinction: a truck is
                    how much you could ever carry, free space is how much of
                    this screenful you could actually take. */}
                {freeCf != null && ` · ${freeCf.toLocaleString("en-US")} cf free`}
                {inView.unsized > 0 && ` · ${inView.unsized} without size`}
              </div>
            )}
          </>
        )}

        {/* What one job does to the space that is actually left -- the
            question a driver with a half-full truck is asking, and the one a
            truckload divisor cannot answer. Shown only when they have said
            how much room they have; there is no honest default for it, and
            guessing one is how "≈ 28.3 truckloads" got written. */}
        {!compact && !error && freeCf != null && focusJob && (
          <div className="mt-[var(--sp-2)] border-t border-border pt-[var(--sp-2)]">
            <div className="text-(length:--fs-sm)" style={{ color: "var(--text-2)" }}>
              {focusJob.cubic_feet == null
                ? "This job never stated a size — nothing to measure"
                : `${formatCf(focusJob.cubic_feet)} · ${fitAgainstFreeSpace(focusJob.cubic_feet, freeCf)}`}
            </div>
            <div className="text-(length:--fs-xs)" style={{ color: "var(--muted-2)" }}>
              Volume only — dimensional fit, weight and loading order still decide.
            </div>
          </div>
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
        <label
          className={`check-row border-t border-border text-(length:--fs-sm) font-medium ${compact ? "mt-[var(--sp-1)] pt-[var(--sp-1)]" : "mt-[var(--sp-2)] pt-[var(--sp-2)]"}`}
        >
          <input
            type="checkbox"
            checked={searchAsMove}
            onChange={(e) => onSearchAsMoveChange(e.target.checked)}
          />
          Search as I move{compact ? "" : " the map"}
        </label>
      </div>

      {/* The two ways this map degrades without dying, stacked so they cannot
          land on top of each other. Both are ASYNC failures on somebody else's
          network -- a blocked tile host, a routing provider that timed out --
          and neither one is a reason to take the map away, let alone the board:
          the jobs are plotted either way. Each retries only itself. */}
      {(tilesDown || noRoad) && (
        <div className="absolute left-1/2 top-[var(--sp-3)] flex -translate-x-1/2 flex-col items-center gap-[var(--sp-2)]">
          {tilesDown && (
            <div
              data-map-chrome
              className="glass flex items-center gap-[var(--sp-3)] px-[var(--sp-3)] py-[var(--sp-2)] text-(length:--fs-sm)"
              style={{ color: "var(--approx)" }}
            >
              <span>Basemap unavailable — jobs are still plotted.</span>
              <button type="button" className="btn btn-sm" onClick={retryTiles}>
                Try again
              </button>
            </div>
          )}
          {noRoad && (
            <div
              data-map-chrome
              className="glass px-[var(--sp-3)] py-[var(--sp-2)] text-(length:--fs-sm)"
              style={{ color: "var(--approx)" }}
            >
              Road route unavailable — showing a straight line.
            </div>
          )}
        </div>
      )}

      {/* Hidden on a phone while a job is open, and only then. The visible map
          band is 261 px at the sheet's default snap, and the two labels naming
          the route's ends are placed near their points -- so they and this
          legend both want the bottom-left corner. The labels win: they are what
          the map is saying right now, and this is reference material. */}
      {compact && selectedId != null ? null : (
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
        {/* The road route earns a row only while a job is open: a legend line
            that appeared and vanished with the selection would resize this
            panel -- which the label placer treats as occupied ground -- and
            set every pill on the map jumping. It is stable because opening a
            job is deliberate, unlike a hover. */}
        {selectedId != null && (
          <b>
            <i className="road" /> road route
          </b>
        )}
        {/* The band has to say how wide it is, or it is a shape rather than a
            number. It earns its row for the same reason the road route does:
            a corridor is set deliberately and stays set, so this panel -- which
            the label placer treats as occupied ground -- is not resizing under
            a pointer.

            The `title` is where the band's honest limit is written. The
            corridor is one of three tests the search runs, and a driver
            reading a shape on a map would reasonably assume it was the only
            one. */}
        {corridor && (
          <b
            title={
              `Jobs whose pickup stands within ${corridor.miles} miles of your route.` +
              " They also have to move you further along it and keep the extra" +
              " driving under a cap, so the band is not the whole test."
            }
          >
            <i
              style={{
                width: 18,
                height: 9,
                borderRadius: 2,
                border: "1px solid var(--you)",
                background: "var(--you)",
                opacity: 0.32,
                boxShadow: "none",
              }}
            />{" "}
            ±{corridor.miles} mi of your route
          </b>
        )}
      </div>
      )}
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
  // The one label on this map allowed to be opaque: while a job is open these
  // two are what the map is asserting, and a veil over a road route reads as
  // an accident.
  el.dataset.endLabel = "";
  el.textContent = text;
  const marker = new maplibregl.Marker({ element: el, anchor: "left", offset: [10, 0] })
    .setLngLat(at)
    .addTo(m);
  return { marker, el };
}

/**
 * The corridor: the driver's route, and the band around it the search
 * actually matched inside.
 *
 * Three geometries, all from the same great circle the server projects onto
 * (`corridorRing` / `intermediatePoint` in `geo/math`), so what is drawn is
 * what was filtered rather than a straight-line approximation of it:
 *
 *  - the route itself, dashed, because it is a line the driver stated and not
 *    a road anyone has checked;
 *  - the capsule around it, filled and outlined;
 *  - a dot on each end, but ONLY where there is not already a marker -- the
 *    viewer's own two slots are drawn as "you are here" and the little house,
 *    and a second dot under either one is a second claim about one place.
 */
function corridorFeatures(
  corridor: Corridor,
  viewer: StoredLocation | null,
  home: StoredLocation | null,
): FeatureCollection {
  const { origin, destination, miles } = corridor;
  const steps = 48;
  const centre: [number, number][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const p = intermediatePoint(origin, destination, i / steps);
    centre.push([p.lng, p.lat]);
  }

  const ends = [origin, destination].filter(
    (p) => !samePlace(p, viewer) && !samePlace(p, home),
  );

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: centre },
      },
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [corridorRing(origin, destination, miles)] },
      },
      ...ends.map((p) => ({
        type: "Feature" as const,
        properties: {},
        geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
      })),
    ],
  };
}
