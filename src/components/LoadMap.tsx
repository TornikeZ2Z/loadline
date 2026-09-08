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
 *  - **Clicking a pile opens it, and how depends on the pile.** Aggregation
 *    hides two completely different situations behind one dot, and they need
 *    opposite answers:
 *
 *      * *One real position.* Eleven jobs out of one Rochester warehouse share
 *        a coordinate because they genuinely share a warehouse. No amount of
 *        zoom separates them, and fanning them out would draw eleven positions
 *        that do not exist. What actually differs between those eleven jobs is
 *        **where they go**, so the map draws that: the other end of each one,
 *        with the warehouse kept on screen as the anchor.
 *      * *Several real positions that merely round together.* Markers group at
 *        three decimals (~110 m), so two separate addresses can land on one
 *        dot. Those **fan out** on leader lines and become separately
 *        hoverable and clickable -- honest, because every position drawn is a
 *        position the data asserts.
 *
 *    `PointGroup.spots` is the one thing that decides which: length 1 is the
 *    first case, more is the second.
 *
 *  - **The camera never claims more precision than the row.** A city centroid
 *    framed at street zoom is a lie told by the viewport rather than by the
 *    dot, so every zoom this component chooses is capped by
 *    `maxZoomFor(precision)` -- z10.5 for a city, z5.5 for a state centroid.
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
import type { PublicLoadRow, PublicTruckRow } from "@/lib/loads/publicView";
import { LOCATION_KEYS, type StoredLocation } from "@/lib/location";
import { STATE_BY_ABBR } from "@/lib/geo/states";
import { api } from "@/lib/basePath";
import { formatCf, jobSummary, truckLine } from "@/lib/loads/present";
import {
  NO_DESTINATION_STATED,
  SPACE_NOT_STATED,
  departureLabel,
  freeSpaceLabel,
  truckPlaceLabel,
} from "@/lib/loads/truckPresent";
import { boardDay } from "@/lib/loads/present";
import {
  alongTrackFraction,
  corridorRing,
  crossTrackMiles,
  haversineMiles,
  intermediatePoint,
  type Point as LatLng,
} from "@/lib/geo/math";
import {
  buildGroups,
  endLabelText,
  endPoint,
  groupSummary,
  idsOf,
  maxZoomFor,
  maxZoomOver,
  pointRadius,
  RADIUS_STOPS,
  RADIUS_ZOOM,
  type PointGroup,
  type PointSpot,
} from "@/lib/geo/points";
import {
  jobMarks,
  truckGroupSummary,
  truckMarks,
  truckPoints,
  type TruckGroupFacts,
} from "@/lib/geo/marks";

export interface LoadMapProps {
  jobs: PublicLoadRow[];
  /**
   * The SECOND population. Never merged with `jobs`, never counted with them,
   * never plotted on the freight size scale -- see the truck block below and
   * SPEC 14. Empty on day one, which is the state this map ships in.
   */
  trucks: PublicTruckRow[];
  selectedTruckId: number | null;
  hoveredTruckId: number | null;
  onSelectTruck(id: number | null): void;
  onHoverTruck(id: number | null): void;
  /**
   * The truck search hit its page limit, so what is drawn is a prefix of what
   * matched. Said out loud in the panel, in the same words the job list uses:
   * a map that is quietly showing some of the answer is worse than one that
   * says which part it is showing.
   */
  truckTruncated?: boolean;
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
  /**
   * The list is currently narrowed to one place. The map opens that state and
   * the list's own chip can close it, so the map has to follow when it does --
   * otherwise dismissing the chip leaves the map looking inside a marker with
   * a full list behind it and no way back that agrees with what is on screen.
   */
  placeActive?: boolean;
  /** The map is done looking inside a marker: show every job again. */
  onPlaceClear?(): void;
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

/* There used to be a second tier here: under z 4.6 a state pill dropped its
 * job count and read "FL · 4,900 cf". It is gone with V10 -- the pill now
 * reads "FL · 9 jobs" at every zoom it is drawn at, and the volume comes back
 * under the pointer -- so there is one string per pill instead of two, and no
 * label on this map rewrites its own words while somebody drags the country. */

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

type LabelKind = "route" | "count" | "state" | "focus" | "truck";

interface MapLabel {
  kind: LabelKind;
  marker: maplibregl.Marker;
  el: HTMLElement;
  lng: number;
  lat: number;
  /**
   * How the element hangs off its point, matching the Marker's own anchor.
   *
   * `top` arrived with the truck labels: the arrow sits ABOVE its coordinate to
   * clear a co-located job's dot, so the free space goes below, which is the
   * one direction nothing else on this marker is using.
   */
  anchor: "center" | "bottom" | "top" | "left";
  /** The offset the marker was built with; slots are added to it. */
  base: [number, number];
  /**
   * Cubic feet of the marker this label has to sit clear of. Present only on
   * the count badges: their vertical base offset is the dot's drawn radius,
   * which changes with the zoom, so it is read per frame rather than baked in.
   */
  clearOf?: number;
  /**
   * `clearOf` measures DOWNWARD from the coordinate rather than upward.
   *
   * A truck label's neighbour is the job disc it may be standing on, and the
   * space above that disc is already spoken for twice over -- by the arrow,
   * which sits 14 px up to clear the disc, and by the disc's own count badge.
   * Below it is the one direction free at a place holding both.
   */
  below?: boolean;
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
 * Inside the CAPSULE, not inside the infinite band around the great circle.
 *
 * `crossTrackMiles` measures against a line with no ends, so a point six
 * hundred miles past the destination but dead on the bearing measures zero off
 * the route. The rounded ends are what `corridorRing` draws, and the shape a
 * driver is looking at has to be the shape being tested.
 */
function inCapsule(p: LatLng, origin: LatLng, destination: LatLng, miles: number): boolean {
  const f = alongTrackFraction(p, origin, destination);
  if (f <= 0) return haversineMiles(p, origin) <= miles;
  if (f >= 1) return haversineMiles(p, destination) <= miles;
  return crossTrackMiles(p, origin, destination) <= miles;
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
  /** The second population's one colour; see --truck in globals.css. */
  truck: string;
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
  truck: "#be2d74",
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
    truck: pick("--truck", FALLBACK.truck),
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
function presence(base: number, scale = 1): maplibregl.ExpressionSpecification {
  // The emphasis control multiplies the whole population down rather than
  // hiding it: a de-emphasised job is still on the map, still counted in the
  // panel, and still where a driver can see it beside the truck they came for.
  const weight = base * scale;
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

/* --------------------- SHAPE, NOT ONLY COLOUR (V10) ------------------------
 *
 * Three marks a driver has to be able to tell apart at a glance, and the
 * review's acceptance criterion is the third one: "approximate locations
 * cannot look like precise street addresses."
 *
 *   one job, placed      a filled disc with a white ring
 *   several jobs, placed the same disc with a white pip through its middle
 *   placed only to a     the disc, out of focus, inside a DASHED ring
 *   state or a region
 *
 * The dash is not a new idea on this map: a truck whose post never said how
 * much room it has is already drawn with a dashed outline, so on this board a
 * broken edge already means "the post did not say". An approximate position is
 * the same sentence about a different field, and it now looks like it.
 *
 * What this deliberately does NOT do is bring back the amber ring. That mark
 * was built twice and rejected twice (`.design/impl/map-beauty.md` §3): a warm
 * halo bleeding round a cool core reads as a rust stain, and in Deliveries mode
 * -- where most ends resolve to a ZIP or a state centroid -- it turned the
 * whole country into a field of orange rings shouting about our uncertainty
 * louder than the freight it was qualifying. The ring here is the mark's OWN
 * colour and carries the same white paper every other mark on this map carries.
 * Softness still says "we guessed"; the dashes say it in a second register, so
 * it survives being small.
 */

/** The ring bitmap's box, in CSS px, and where the ring sits inside it. */
const APPROX_RING_BOX = 64;
const APPROX_RING_R = 27;
/** Drawn at 2x, so a 2 px dashed stroke has real edges when it is scaled up. */
const APPROX_RING_SCALE = 2;
/** How far outside the disc the ring stands, in CSS px. */
const APPROX_RING_GAP = 3.5;

function approxRingImage(color: string): ImageData | null {
  if (typeof document === "undefined") return null;
  const px = APPROX_RING_BOX * APPROX_RING_SCALE;
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(APPROX_RING_SCALE, APPROX_RING_SCALE);
  const c = APPROX_RING_BOX / 2;
  // Paper first and wider, exactly as `truckGlyph` does it: the ground under
  // this ring is woodland, or water, or a town, and a mark with no paper
  // behind it is only as legible as whatever it is parked on.
  ctx.setLineDash([5.5, 4.5]);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(c, c, APPROX_RING_R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(c, c, APPROX_RING_R, 0, Math.PI * 2);
  ctx.stroke();
  return ctx.getImageData(0, 0, px, px);
}

/**
 * `icon-size` for a bitmap whose drawn feature sits at `unit` CSS px, scaled so
 * it lands `extra` px outside the disc this mark is drawn as.
 *
 * The zoom interpolation has to be the OUTERMOST expression -- MapLibre will
 * not take a `["zoom"]` input nested inside anything, and a rejected paint or
 * layout expression makes it drop the whole layer with one line on the console
 * (`map-beauty.md`, "one bug found on the way"). So the arithmetic goes inside
 * each stop, exactly as `zoomRadius` does it.
 */
function zoomIconSize(extra: number, unit: number): maplibregl.ExpressionSpecification {
  const at = (scale: number): maplibregl.ExpressionSpecification => [
    "/",
    ["+", ["*", RADIUS_BY_CF, scale], extra],
    unit,
  ];
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
 * The pip through the middle of a marker that holds more than one job.
 *
 * Proportional to the disc, so it reads as a hole in the mark rather than as a
 * second mark, and clamped at both ends: under 1.6 px it is a smudge, over
 * 4.5 px it starts eating the freight the disc is drawing.
 */
function zoomPip(): maplibregl.ExpressionSpecification {
  const at = (scale: number): maplibregl.ExpressionSpecification => [
    "max",
    1.6,
    ["min", 4.5, ["*", RADIUS_BY_CF, scale * 0.3]],
  ];
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

/** The soft ground under a job marker, graded by freight. */
function liftOpacity(scale = 1): maplibregl.ExpressionSpecification {
  return [
    "case",
    ["boolean", ["feature-state", "dim"], false],
    0.03 * scale,
    [
      "interpolate",
      ["linear"],
      ["sqrt", ["max", 0, ["coalesce", ["get", "cf"], 0]]],
      0,
      0.05 * scale,
      40,
      0.13 * scale,
      110,
      0.22 * scale,
    ],
  ];
}

/** The job dots' three opacities, at one emphasis. */
function pointsOpacity(scale = 1): maplibregl.ExpressionSpecification {
  return ["case", ["get", "approx"], presence(0.72, scale), presence(0.94, scale)];
}

/**
 * How present a truck arrow is.
 *
 * Flat, not graded: `presence` grades a job by freight because area is the
 * job's own scale and a small dot needs the help. A truck has no scale to be
 * graded on -- that is the point of drawing it at one size -- so the only
 * things that move this number are the hover dim and the emphasis control.
 * An approximate origin is drawn fainter, which is this map's existing word
 * for "we had to guess where this is".
 */
function truckOpacity(scale = 1): maplibregl.ExpressionSpecification {
  return [
    "case",
    ["boolean", ["feature-state", "dim"], false],
    0.34 * scale,
    ["case", ["get", "approx"], 0.66 * scale, 0.96 * scale],
  ];
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

/* ------------------------------ the truck mark ----------------------------
 *
 * A JOB IS A DISC WHOSE AREA IS ITS FREIGHT. A TRUCK IS AN ARROW AT ONE FIXED
 * SIZE, AND THAT IS A RULE RATHER THAN AN OVERSIGHT. On this map area encodes
 * volume, so a 700 cf truck drawn the size of a 700 cf job would invite the eye
 * to compare supply against demand as though they were the same quantity --
 * precisely the confusion this whole feature exists to avoid. Shape and hue
 * carry "truck"; size carries "how much freight". Free space is in words, on
 * the label and on the hover card.
 *
 * Four glyphs, because two facts can each be missing:
 *
 *              space stated              space never stated
 *   heading    solid arrow               dashed-outline arrow
 *   no heading solid ring                dashed-outline ring
 *
 * The ring is the honest mark for a truck whose post never said where it is
 * going: there is nothing to point at, and an arrow aimed at a compass
 * direction nobody stated would be the map inventing the one fact a driver
 * would act on. The dashes are the same idea for the size.
 *
 * They are BAKED BITMAPS, not SDFs. MapLibre's `icon-color` needs an SDF, and
 * an SDF drawn from a binary mask has no gradient outside the shape for
 * `icon-halo-width` to threshold -- so the white outline that lifts every mark
 * on this map off the basemap simply would not render. The colour is read once
 * from `--truck` at init, which is exactly when `colors.pickup` is read, and
 * nothing on this map recolours at runtime.
 */

/** The glyph box in CSS px. The arrow is 18 tall inside it. */
const TRUCK_GLYPH = 24;
/** Drawn at 2x so a 14 px arrowhead has real edges. */
const TRUCK_GLYPH_SCALE = 2;

/**
 * How far the arrow sits above the coordinate, in screen pixels.
 *
 * A place holding both a job and a truck draws TWO MARKS AND NEVER MERGES
 * THEM: a merged marker would need one number and there are two of them, and
 * they are not the same kind of number. This is the lift that keeps the arrow
 * off the disc.
 *
 * Applied as `icon-translate`, a PAINT property in screen space, and not as
 * `icon-offset`. `icon-offset` lives inside the symbol quad, so it is rotated
 * by `icon-rotate` along with everything else -- a truck bound for Miami would
 * have had its "clearance" pushed south-west, straight back onto the dot.
 */
const TRUCK_LIFT_PX = 14;

/**
 * Above this many truck markers in view, the truck LABELS go and the arrows
 * stay.
 *
 * Dropping labels rather than marks is what makes this work above
 * PILL_MAX_ZOOM, where the state pills are suppressed entirely and a
 * pill-based fallback would render nothing at all.
 *
 * SIXTY IS A GUESS WITH NO MEASUREMENT BEHIND IT (SPEC 14.6). It is one named
 * constant on purpose, and the first real volume of supply should replace it.
 */
const TRUCK_LABEL_MAX_GROUPS = 60;

/**
 * Which population the map is leaning on. EMPHASIS, NOT FILTERING: the other
 * one stays drawn and stays counted, at a quarter opacity and out of reach of
 * the pointer. A dispatcher still sees a truck heading their way NEXT TO the
 * job that needs it, which is the entire point of putting both on one map.
 *
 * A client-side preference, in localStorage and NOT in the URL: it is not a
 * search, nothing about the result set changes, and `map=delivery` set the
 * precedent that a view choice is search-neutral.
 */
type Emphasis = "both" | "loads" | "trucks";
const EMPHASIS_KEY = "loadline.mapmarks.v1";
/** What a de-emphasised population is multiplied down to. */
const EMPHASIS_DIM = 0.25;

function readEmphasis(): Emphasis {
  if (typeof window === "undefined") return "both";
  try {
    const raw = window.localStorage.getItem(EMPHASIS_KEY);
    return raw === "loads" || raw === "trucks" ? raw : "both";
  } catch {
    // Private mode or blocked storage: the default is the honest one anyway.
    return "both";
  }
}

/** The arrow, pointing north, in a 24 px box. `icon-rotate` does the rest. */
function arrowPath(ctx: CanvasRenderingContext2D): void {
  const c = TRUCK_GLYPH / 2;
  ctx.beginPath();
  ctx.moveTo(c, 3);
  ctx.lineTo(c + 7.5, 20);
  ctx.lineTo(c, 15.5);
  ctx.lineTo(c - 7.5, 20);
  ctx.closePath();
}

function ringPath(ctx: CanvasRenderingContext2D): void {
  const c = TRUCK_GLYPH / 2;
  ctx.beginPath();
  ctx.arc(c, c, 6.5, 0, Math.PI * 2);
  ctx.closePath();
}

/**
 * One truck glyph as pixels.
 *
 * The white is drawn FIRST and wider, so every variant carries the same ring of
 * paper the job dots carry -- the ground under these marks is woodland, or
 * water, or a town, and a mark with no paper behind it is only as legible as
 * whatever it happens to be parked on.
 */
function truckGlyph(
  shape: "arrow" | "ring",
  variant: "solid" | "open",
  color: string,
): ImageData | null {
  if (typeof document === "undefined") return null;
  const px = TRUCK_GLYPH * TRUCK_GLYPH_SCALE;
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(TRUCK_GLYPH_SCALE, TRUCK_GLYPH_SCALE);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const draw = shape === "arrow" ? arrowPath : ringPath;

  // The paper.
  draw(ctx);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = variant === "solid" ? 3.4 : 3.8;
  ctx.stroke();

  draw(ctx);
  if (variant === "solid" && shape === "arrow") {
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    // A ring is hollow by definition; an "open" mark is hollow because the post
    // never said how much room is on the truck. Both are strokes, and the
    // second one is dashed.
    if (variant === "open") ctx.setLineDash([3, 2.2]);
    ctx.strokeStyle = color;
    ctx.lineWidth = variant === "open" ? 1.9 : 2.4;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  return ctx.getImageData(0, 0, px, px);
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

/* ------------------------- looking inside a marker ------------------------
 *
 * See the two cases in the file header. `Focus` is what the viewer clicked;
 * everything else is derived from it and from the current result set, so a new
 * search cannot leave the map inside a marker that no longer exists.
 */
interface Focus {
  /** The marker that was clicked. */
  key: string;
  /**
   * Which real position inside it, once the fan is open and a leaf has been
   * chosen. Null while the fan itself is what is on screen.
   */
  spot: string | null;
}

/** What is on screen because a marker was opened. */
type FocusView =
  | { mode: "fan"; group: PointGroup; label: string; ids: number[] }
  | {
      mode: "outward";
      group: PointGroup;
      /** The one real position the jobs leave from; the group itself when it holds only one. */
      at: { lng: number; lat: number; approx: boolean; precision: string | null };
      label: string;
      ids: number[];
    };

/** Properties on a fanned-out leaf; the same flat shape `PointProps` uses. */
interface LeafProps {
  role: "leaf";
  key: string;
  label: string;
  count: number;
  cf: number;
  unsized: number;
  approx: boolean;
  ids: string;
}

function leafProps(spot: PointSpot): LeafProps {
  return {
    role: "leaf",
    key: spot.key,
    label: spot.label,
    count: spot.ids.length,
    cf: spot.cf,
    unsized: spot.unsized,
    approx: spot.approx,
    ids: spot.ids.join(","),
  };
}

/**
 * The fan: every real position under one marker, pushed out to where a finger
 * can hit it, each still tied to the coordinate it actually has.
 *
 * Screen space, not geography -- the whole reason these need separating is
 * that they are within ~110 m of each other, so any fixed geographic offset
 * would either overlap at one zoom or fly apart at another. Recomputed while
 * the map moves; the LEADER LINE is what keeps it honest, because it runs from
 * the position the data asserts to the disc that stands in for it.
 */
function fanFeatures(m: maplibregl.Map, group: PointGroup): FeatureCollection {
  const centre = m.project([group.lng, group.lat]);
  const n = group.spots.length;
  // Enough arc between neighbours to hit one without hitting the next, and
  // capped so the fan stays a thing hanging off one dot rather than a
  // constellation of its own.
  const radius = Math.min(92, 30 + n * 8);
  const features: FeatureCollection["features"] = [];
  group.spots.forEach((spot, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const at = m.unproject([
      centre.x + radius * Math.cos(angle),
      centre.y + radius * Math.sin(angle),
    ]);
    features.push({
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        // From where it really is, to where it is being shown. Both ends
        // matter: the first is the claim, the second is only the handle.
        coordinates: [
          [spot.lng, spot.lat],
          [at.lng, at.lat],
        ],
      },
    });
    features.push({
      type: "Feature",
      id: spot.key,
      properties: leafProps(spot),
      geometry: { type: "Point", coordinates: [at.lng, at.lat] },
    });
  });
  return { type: "FeatureCollection", features };
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
  trucks,
  end,
  selectedId,
  hoveredId,
  selectedTruckId,
  hoveredTruckId,
  onSelect,
  onHover,
  onSelectTruck,
  onHoverTruck,
  truckTruncated = false,
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
  placeActive = false,
  onPlaceClear,
}: LoadMapProps) {
  const container = useRef<HTMLDivElement>(null);
  /** The canvas plus everything floating over it; the declutter frame. */
  const shell = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  /* TWO STATE OBJECTS AND TWO REFS, AND THAT IS THE WHOLE POINT (SPEC 14.5).
   *
   * There used to be one `inView` accumulating `{count, cf, unsized}` over one
   * `groups` ref, and the panel divided its `cf` by a truck size to print
   * "= 28.3 truckloads". Pushing trucks into that ref would have added free
   * space to freight and then divided the result by a truck -- the exact lie
   * this feature exists not to tell, on the surface a dispatcher looks at most.
   * The two shapes deliberately share no field name that carries a volume, so
   * there is no line anywhere that could add them by accident. */
  const [inViewJobs, setInViewJobs] = useState<{
    count: number;
    cf: number;
    unsized: number;
  } | null>(null);
  const [inViewTrucks, setInViewTrucks] = useState<{
    count: number;
    /** Free space. Never "cf". Never added to anything. */
    freeCf: number;
    unstated: number;
    /** Markers, not trucks: what the label-collapse rule counts. */
    marks: number;
  } | null>(null);
  const [zoom, setZoom] = useState(4);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  /** A truck marker under the pointer. Its own key: the two sources' keys collide. */
  const [hoverTruckKey, setHoverTruckKey] = useState<string | null>(null);
  const [emphasis, setEmphasis] = useState<Emphasis>("both");
  /** A marker the viewer opened: see `Focus` and the file header. */
  const [focus, setFocus] = useState<Focus | null>(null);
  /**
   * One fanned-out leaf under the pointer, and the spot on screen it was
   * pushed out to -- the card is pinned to the disc the pointer is on, not to
   * the coordinate it stands for, which is up to 92 px away under the marker.
   */
  const [hoverLeaf, setHoverLeaf] = useState<{ spot: PointSpot; at: [number, number] } | null>(
    null,
  );
  const [route, setRoute] = useState<{ key: string; road: RoadRouteResponse } | null>(null);
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

  /* --- V08: the map's own furniture, folded up on a phone -------------------
   *
   * On a 390 px screen the "on screen" panel and the legend were two opaque
   * cards on a 261 px band of map, and at 320 they overlapped each other: the
   * panel measured y 125-205 and the legend y 165-198, so a third of the key
   * was printed underneath the statistics. They are both reference material,
   * both duplicated in words a thumb's width away in the list, and neither is
   * what a driver opened the board to look at.
   *
   * So on compact each becomes ONE control that opens. Nothing is deleted --
   * every line is one tap away, and the collapsed panel says how many notes it
   * is holding rather than swallowing them silently. On the desktop, where
   * there is room, both are open and this state is never read.
   */
  const [statsOpen, setStatsOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  /** The map's own box, so the chrome can be told how much room it has. */
  const [shellH, setShellH] = useState(0);

  // Callbacks are held in refs so the map is built once and never torn down by
  // a parent re-render; a remount would drop the viewport the user set.
  const cb = useRef({
    onSelect,
    onHover,
    onSelectTruck,
    onHoverTruck,
    onStateClick,
    onGroupClick,
    onBoundsChange,
    searchAsMove,
    // The emphasis control's other half: paint says which population is quiet,
    // and this says which one the pointer may reach. A mark at 25 % opacity
    // that still swallowed clicks would be worse than one that was hidden.
    emphasis,
  });
  cb.current = {
    onSelect,
    onHover,
    onSelectTruck,
    onHoverTruck,
    onStateClick,
    onGroupClick,
    onBoundsChange,
    searchAsMove,
    emphasis,
  };
  /** How much of the canvas the phone's bottom sheet is covering, for the same reason. */
  const pad = useRef(bottomPadding);
  pad.current = bottomPadding;
  const narrow = useRef(compact);
  narrow.current = compact;

  const stateMarkers = useRef<maplibregl.Marker[]>([]);
  const placeMarkers = useRef<maplibregl.Marker[]>([]);
  const countMarkers = useRef<maplibregl.Marker[]>([]);
  /** One label per truck marker: the place, the count, and the free space. */
  const truckMarkers = useRef<maplibregl.Marker[]>([]);
  /** The name of the place a marker was opened from, pinned to its anchor. */
  const focusMarkers = useRef<maplibregl.Marker[]>([]);
  const labelMarkers = useRef<maplibregl.Marker[]>([]);
  /** Everything the declutter pass places, across all three marker groups. */
  const labels = useRef<MapLabel[]>([]);
  /** Rendered size per element class + text; a pan must not read layout. */
  const labelSize = useRef(new Map<string, [number, number]>());
  const popup = useRef<maplibregl.Popup | null>(null);
  /** Every feature-state we have set, and where, so it can be cleared exactly. */
  const stated = useRef<Array<{ source: string; key: string }>>([]);
  /**
   * The truck marker the pointer is on, held in a ref as well as in state.
   *
   * The hit test runs on every `mousemove` over the whole canvas rather than on
   * a layer's own enter/leave, so it needs to know whether anything actually
   * changed -- setting React state on every pixel of a pan is the one thing
   * that makes this map feel slow.
   */
  const truckHover = useRef<string | null>(null);
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
  const roadCache = useRef(new Map<string, RoadRouteResponse>());

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

  const built = useMemo(() => buildGroups(jobMarks(jobs, end)), [jobs, end]);

  /**
   * The trucks, grouped by the same code and NEVER in the same call.
   *
   * `buildGroups` runs once per population. A mixed array would put a job's
   * freight and a truck's free space into one marker's `cf`, and the marker
   * would then carry one number where there are two of them.
   */
  const truckBuilt = useMemo(() => truckPoints(truckMarks(trucks, end)), [trucks, end]);

  /**
   * Trucks that ARE in the result but are not on this view, because they never
   * said where they are going and this is the map of arrivals.
   *
   * Printed, never swallowed. The alternative -- plotting them at their origin
   * anyway -- would put a standing vehicle on a map of deliveries.
   */
  const truckNoDest = end === "delivery" ? trucks.length - truckBuilt.points.plotted : 0;

  /**
   * What a click on a marker opened, resolved against the CURRENT result set.
   *
   * Derived rather than stored, so a search that no longer contains the place
   * simply stops focusing it instead of leaving the map inside a marker that
   * is not on it any more.
   */
  const focused = useMemo<FocusView | null>(() => {
    if (!focus) return null;
    const group = built.byKey.get(focus.key);
    if (!group) return null;
    if (focus.spot) {
      const spot = group.spots.find((s) => s.key === focus.spot);
      return spot
        ? { mode: "outward", group, at: spot, label: spot.label, ids: spot.ids }
        : null;
    }
    // The fan is only drawn where the positions really do differ. One position
    // holding eleven jobs is the other case, and fanning it would invent ten
    // coordinates -- which is the false precision this whole board avoids.
    return group.spots.length > 1
      ? { mode: "fan", group, label: group.label, ids: group.ids }
      : { mode: "outward", group, at: group, label: group.label, ids: group.ids };
  }, [focus, built]);

  /** Which end the map is DRAWING: the other one, while looking out of a place. */
  const drawnEnd: MapEnd =
    focused?.mode === "outward" ? (end === "pickup" ? "delivery" : "pickup") : end;

  /**
   * Where the focused jobs go -- the far end of each one, grouped the same way
   * the board's own markers are, so a warehouse sending eleven loads to nine
   * towns draws nine dots with their own tallies.
   */
  const outward = useMemo(() => {
    if (focused?.mode !== "outward") return null;
    const wanted = new Set(focused.ids);
    return buildGroups(
      jobMarks(jobs.filter((j) => wanted.has(j.id)), end === "pickup" ? "delivery" : "pickup"),
    );
  }, [focused, jobs, end]);

  /** The markers actually on screen: the board's, or the focused place's. */
  const drawn = outward ?? built;
  /** The source those markers live in, for feature-state and hit-testing. */
  const drawnSource = outward ? "focus" : "points";

  // Read by the map's own event handlers, which are registered once and must
  // not close over a stale result set.
  const jobGroups = useRef(drawn.groups);
  jobGroups.current = drawn.groups;
  const byKey = useRef(built.byKey);
  byKey.current = built.byKey;
  /** The truck markers, in their own ref for the same reason as their own state. */
  const truckGroups = useRef(truckBuilt.points.groups);
  truckGroups.current = truckBuilt.points.groups;
  const truckByKey = useRef(truckBuilt.points.byKey);
  truckByKey.current = truckBuilt.points.byKey;
  const focusRef = useRef<FocusView | null>(focused);
  focusRef.current = focused;

  // A single boolean rather than the raw zoom: `zoom` ticks on every frame of
  // every wheel gesture, and rebuilding a screenful of HTML markers per frame
  // is the one thing that makes this map feel slow.
  const detailed = zoom > PILL_MAX_ZOOM;
  /**
   * Too many trucks on screen to name them all.
   *
   * 98 jobs collapse to roughly 40 markers because real posts are batch
   * inventories out of a handful of warehouses. Trucks do not collapse that
   * way -- one truck is one company at one place -- so N trucks is close to N
   * markers, and past a point the labels are a smudge over the arrows they are
   * labelling. The arrows stay; the words go; the panel says so.
   */
  const truckLabelsHidden = (inViewTrucks?.marks ?? 0) > TRUCK_LABEL_MAX_GROUPS;

  /* --------------------------- the open listing -----------------------------
   *
   * ONE listing is open at a time -- the list column holds one drawer, and the
   * Board closes a job when a truck opens -- so one `road` source and one set
   * of route layers serve both kinds. What changes is which endpoint is asked:
   * `/api/loads/:id/route` or `/api/trucks/:id/route`, the same HERE truck
   * router behind both, the same one-billable-call-per-listing-ever cache on
   * the row.
   *
   * The key is `kind:id` rather than a bare number, because job 12 and truck 12
   * are two different lanes and one cache keyed on 12 would draw one of them
   * for the other.
   */
  const open = useMemo<{ kind: "job" | "truck"; id: number } | null>(
    () =>
      selectedTruckId != null
        ? { kind: "truck", id: selectedTruckId }
        : selectedId != null
          ? { kind: "job", id: selectedId }
          : null,
    [selectedId, selectedTruckId],
  );
  const openKey = open ? `${open.kind}:${open.id}` : null;

  const openTruck = useMemo(
    () => (open?.kind === "truck" ? (trucks.find((t) => t.id === open.id) ?? null) : null),
    [open, trucks],
  );

  /**
   * The open truck's own swing, at its own `corridor_miles`.
   *
   * A truck with no stated destination gets NO BAND. A corridor is a distance
   * from a LINE and there is no line: a circle of the same radius around the
   * origin would be a different claim in the same colour, and it is not the one
   * the matcher makes -- such a truck is "near you, not on a route".
   */
  const truckCorridor = useMemo(() => {
    if (!openTruck || openTruck.dest_lat == null || openTruck.dest_lng == null) return null;
    return {
      origin: { lat: openTruck.origin_lat, lng: openTruck.origin_lng },
      destination: { lat: openTruck.dest_lat, lng: openTruck.dest_lng },
      miles: openTruck.corridor_miles,
    };
  }, [openTruck]);

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
    for (const group of jobGroups.current) {
      if (!box.contains([group.lng, group.lat])) continue;
      count += group.ids.length;
      cf += group.cf;
      unsized += group.unsized;
    }
    setInViewJobs({ count, cf, unsized });

    // A SECOND WALK OVER A SECOND SET, into a second shape. Not a second branch
    // of the loop above with a different accumulator: one loop with two totals
    // is one edit away from being one loop with one total.
    let trucksInView = 0;
    let freeCf = 0;
    let unstated = 0;
    let marks = 0;
    for (const group of truckGroups.current) {
      if (!box.contains([group.lng, group.lat])) continue;
      marks += 1;
      trucksInView += group.ids.length;
      freeCf += group.cf;
      unstated += group.unsized;
    }
    setInViewTrucks({ count: trucksInView, freeCf, unstated, marks });
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
    for (const group of jobGroups.current) {
      const at = m.project([group.lng, group.lat]);
      if (at.x < -60 || at.y < -60 || at.x > vw + 60 || at.y > vh + 60) continue;
      const r = pointRadius(group.cf, z) + 2;
      taken.push([at.x - r, at.y - r, at.x + r, at.y + r]);
    }

    // AND SO ARE THE ARROWS. This is what keeps the co-location offset honest:
    // a place holding a job and a truck draws the disc, the arrow 14 px above
    // it, and then the HTML place pill has to find somewhere that is neither.
    // Without this reservation the pill lands on the arrow at exactly the zooms
    // where a marker carries a name (SPEC 18 MAP4).
    const half = TRUCK_GLYPH / 2 + 2;
    for (const group of truckGroups.current) {
      const at = m.project([group.lng, group.lat]);
      if (at.x < -60 || at.y < -60 || at.x > vw + 60 || at.y > vh + 60) continue;
      const cy = at.y - TRUCK_LIFT_PX;
      taken.push([at.x - half, cy - half, at.x + half, cy + half]);
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
          : l.below
            ? [l.base[0], pointRadius(l.clearOf, m.getZoom()) + 7]
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
        const top = l.anchor === "bottom" ? cy - h : l.anchor === "top" ? cy : cy - h / 2;
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

      for (const shape of ["arrow", "ring"] as const) {
        for (const variant of ["solid", "open"] as const) {
          const id = `truck-${shape}${variant === "open" ? "-open" : ""}`;
          const glyph = truckGlyph(shape, variant, colors.truck);
          if (glyph && !instance.hasImage(id)) {
            instance.addImage(id, glyph, { pixelRatio: TRUCK_GLYPH_SCALE });
          }
        }
      }

      // ONE DASHED RING PER END, baked rather than tinted. `icon-color` needs
      // an SDF, and an SDF has no gradient outside its mask for the white
      // paper under this ring to come from -- the same reason the truck glyphs
      // are bitmaps. Two images, and the layer swaps between them when the
      // board switches between Pickups and Deliveries.
      for (const [id, color] of [
        ["approx-ring-pickup", colors.pickup],
        ["approx-ring-delivery", colors.delivery],
      ] as const) {
        const ring = approxRingImage(color);
        if (ring && !instance.hasImage(id)) {
          instance.addImage(id, ring, { pixelRatio: APPROX_RING_SCALE });
        }
      }

      instance.addSource("points", { type: "geojson", data: EMPTY, promoteId: "key" });
      // THE SECOND POPULATION, IN ITS OWN SOURCE. Not a second layer over the
      // first: `cf` is freight on a job feature and free space on a truck one,
      // and one source holding both would be one number where there are two.
      instance.addSource("trucks", { type: "geojson", data: EMPTY, promoteId: "key" });
      // Where a hovered truck is headed, and the lane of the one that is open.
      instance.addSource("truck-leg", { type: "geojson", data: EMPTY });
      // The swing an open truck said it would take, at its own width.
      instance.addSource("truck-corridor", { type: "geojson", data: EMPTY });
      // `lineMetrics` is what makes `line-gradient` legal on the road: it
      // darkens from the pickup toward the delivery, and a gradient needs to
      // know how far along the line each pixel is.
      instance.addSource("road", { type: "geojson", data: EMPTY, lineMetrics: true });
      instance.addSource("toward", { type: "geojson", data: EMPTY });
      // What a marker holds, once it has been opened: either the fan of real
      // positions under it, or the far end of every job standing at it.
      instance.addSource("focus", { type: "geojson", data: EMPTY, promoteId: "key" });

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

      /* ------------------ the open truck's own swing ---------------------
       *
       * The same capsule the board's corridor filter draws, at the TRUCK's own
       * `corridor_miles` rather than the viewer's. A driver sees, geometrically,
       * exactly which freight is inside their swing -- and the jobs outside it
       * dim, which is the part that turns a shape into an answer.
       *
       * Its own colour, not --you: --you is where the person looking at the
       * screen is standing, and this band belongs to a truck somebody else
       * posted.
       */
      instance.addLayer({
        id: "truck-corridor-fill",
        type: "fill",
        source: "truck-corridor",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": colors.truck, "fill-opacity": 0.06 },
      });
      instance.addLayer({
        id: "truck-corridor-edge",
        type: "line",
        source: "truck-corridor",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "line-color": colors.truck, "line-width": 1, "line-opacity": 0.35 },
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
          "circle-opacity": liftOpacity(),
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
          "circle-opacity": pointsOpacity(),
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

      /* ------------------- and what SHAPE each disc is (V10) ---------------
       *
       * Two layers over the disc, both driven entirely by properties the
       * source already carries -- `count` and `approx` -- so `buildGroups`
       * and its frozen GeoJSON (T-A3, `npm run check:equiv`) are untouched.
       */

      // More than one job standing here: a pip through the middle. Not drawn
      // on an approximate mark, which is soft on purpose and would turn a
      // white dot inside a cloud into mush.
      instance.addLayer({
        id: "points-multi",
        type: "circle",
        source: "points",
        filter: ["all", [">", ["get", "count"], 1], ["!", ["get", "approx"]]],
        paint: {
          "circle-color": "#ffffff",
          "circle-radius": zoomPip(),
          "circle-opacity": presence(0.8),
        },
      });

      // Placed no more finely than a state or a region: a dashed ring around
      // the soft disc, in the mark's own colour. See the note above the image.
      instance.addLayer({
        id: "points-approx",
        type: "symbol",
        source: "points",
        filter: ["get", "approx"],
        layout: {
          "icon-image": "approx-ring-pickup",
          "icon-size": zoomIconSize(APPROX_RING_GAP, APPROX_RING_R),
          // Never dropped for collision: a ring that vanished because a label
          // wanted its pixels would leave a soft dot claiming to be exact,
          // which is the one thing this mark exists to stop.
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-opacity": presence(0.8) },
      });

      /* ----------------------- the trucks ---------------------------------
       *
       * Layer order, and it is the order SPEC 14.2 asks for:
       *   points-lift -> points -> [the truck block] -> points-active-* ->
       *   focus-* -> route-*
       *
       * The leg first, because it is context for the arrow rather than a claim
       * of its own: a DASHED STRAIGHT LINE, never a routed one. A hover must
       * never cost money, and a hover that quietly bought a road route would
       * bill the product once per card a pointer crossed.
       */
      instance.addLayer({
        id: "truck-leg",
        type: "line",
        source: "truck-leg",
        layout: { "line-cap": "round" },
        paint: {
          "line-color": colors.truck,
          "line-width": 1.6,
          "line-dasharray": [2, 2.5],
          "line-opacity": 0.6,
        },
      });
      // The selected truck's two rings, the same white-gap-then-accent pair a
      // selected job wears -- but at a FIXED radius, because the arrow they are
      // ringing is at a fixed size and a ring that grew with free space would
      // put the truck back on the freight scale by the back door.
      instance.addLayer({
        id: "trucks-active-gap",
        type: "circle",
        source: "trucks",
        paint: {
          "circle-color": "rgba(0,0,0,0)",
          "circle-radius": 12,
          "circle-translate": [0, -TRUCK_LIFT_PX],
          "circle-stroke-width": 2.5,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-opacity": ["case", ["boolean", ["feature-state", "active"], false], 0.95, 0],
        },
      });
      instance.addLayer({
        id: "trucks-active",
        type: "circle",
        source: "trucks",
        paint: {
          "circle-color": "rgba(0,0,0,0)",
          "circle-radius": 14.5,
          "circle-translate": [0, -TRUCK_LIFT_PX],
          "circle-stroke-width": 2,
          "circle-stroke-color": colors.truck,
          "circle-stroke-opacity": ["case", ["boolean", ["feature-state", "active"], false], 0.9, 0],
        },
      });
      instance.addLayer({
        id: "trucks",
        type: "symbol",
        source: "trucks",
        layout: {
          "icon-image": [
            "case",
            ["get", "directed"],
            ["case", ["get", "unstated"], "truck-arrow-open", "truck-arrow"],
            ["case", ["get", "unstated"], "truck-ring-open", "truck-ring"],
          ],
          // PINNED TO 1, and it stays pinned. Every truck is the same size on
          // this map; the moment this becomes a function of anything, area is
          // encoding two different quantities.
          "icon-size": 1,
          "icon-rotate": ["get", "bearing"],
          "icon-rotation-alignment": "map",
          // Never dropped for collision: an arrow that vanishes because a state
          // pill wanted its pixels is a truck the board did not mention. The
          // TEXT is what gets decluttered, by the HTML pass below.
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: {
          "icon-opacity": truckOpacity(),
          // See TRUCK_LIFT_PX: a paint translate in screen space, because
          // `icon-offset` would have been rotated by `icon-rotate`.
          "icon-translate": [0, -TRUCK_LIFT_PX],
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

      /* ------------------- what is inside an opened marker ------------------
       *
       * The leader line first, so a leaf always sits on top of its own tether.
       * It is thin, dashed and quiet on purpose: it is not a lane, not a road
       * and not a claim about travel. It says only "the disc you are about to
       * click really stands here", which is the one thing that makes fanning a
       * marker apart honest rather than decorative.
       */
      instance.addLayer({
        id: "focus-leader",
        type: "line",
        source: "focus",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: {
          // The mark's own colour, not a neutral hairline: a 1 px grey thread
          // measured out at 0.45 over OpenStreetMap's road web at city zoom is
          // invisible, and an invisible tether turns an honest fan back into
          // three dots in places nothing stands. Dashed, because it is a
          // pointer and not a route.
          "line-color": colors.pickup,
          "line-width": 1.5,
          "line-dasharray": [2, 2],
          "line-opacity": 0.75,
        },
      });
      // The place the viewer opened, while its jobs' far ends are on screen.
      // Hollow and ringed rather than filled: it is not one of the marks being
      // counted, it is where they are being counted FROM.
      instance.addLayer({
        id: "focus-anchor",
        type: "circle",
        source: "focus",
        filter: ["==", ["get", "role"], "anchor"],
        paint: {
          "circle-radius": 8,
          "circle-color": "#ffffff",
          "circle-opacity": 0.9,
          "circle-stroke-width": 3,
          "circle-stroke-color": colors.accentHover,
        },
      });
      // The same mark the board uses, at the same sizes, so a destination
      // holding 1,900 cf reads against a pickup holding 6,006 cf without
      // anybody having to learn a second vocabulary. Two extra pixels of
      // radius because a leaf is a hit target as well as a mark.
      instance.addLayer({
        id: "focus-points",
        type: "circle",
        source: "focus",
        filter: ["==", ["get", "role"], "leaf"],
        paint: {
          "circle-color": colors.pickup,
          "circle-radius": zoomRadius(2),
          "circle-blur": APPROX_BLUR,
          "circle-opacity": ["case", ["get", "approx"], presence(0.72), presence(0.94)],
          "circle-stroke-width": [
            "case",
            ["boolean", ["feature-state", "active"], false],
            3,
            2,
          ],
          "circle-stroke-color": [
            "case",
            ["boolean", ["feature-state", "active"], false],
            colors.accentHover,
            "#ffffff",
          ],
          "circle-stroke-opacity": presence(1),
        },
      });

      // The same two shape rules inside an opened marker (V10). A destination
      // known only to a state centroid is exactly as approximate here as it is
      // on the board, and the fan is where false precision would hurt most --
      // its whole point is telling the viewer where things really are.
      instance.addLayer({
        id: "focus-multi",
        type: "circle",
        source: "focus",
        filter: [
          "all",
          ["==", ["get", "role"], "leaf"],
          [">", ["get", "count"], 1],
          ["!", ["get", "approx"]],
        ],
        paint: {
          "circle-color": "#ffffff",
          "circle-radius": zoomPip(),
          "circle-opacity": presence(0.8),
        },
      });
      instance.addLayer({
        id: "focus-approx",
        type: "symbol",
        source: "focus",
        filter: ["all", ["==", ["get", "role"], "leaf"], ["get", "approx"]],
        layout: {
          "icon-image": "approx-ring-pickup",
          "icon-size": zoomIconSize(APPROX_RING_GAP + 2, APPROX_RING_R),
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-opacity": presence(0.8) },
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

      /* ------------------ WHICH MARK IS UNDER THE POINTER -------------------
       *
       * The arrow is lifted 14 px off its coordinate by `icon-translate`, which
       * is a PAINT property: MapLibre's symbol hit-testing does not know about
       * it, so `map.on("click", "trucks")` answered for a box still sitting on
       * the coordinate -- which at a place holding both is exactly where the
       * job's disc is. Clicking Rochester's eleven-job pile opened the job
       * group AND the truck standing on it in one gesture, and the camera flew
       * to the truck's lane. (Found by the wave-2 map integration walk, which
       * is why that script is a permanent ratchet and not a formality.)
       *
       * So the truck's hit box is computed HERE, from the same projected centre
       * and the same lift the mark is drawn with and the declutter pass
       * reserves as occupied ground. One source of truth for where the arrow
       * is, and nothing has to agree with MapLibre's idea of it.
       *
       * The truck wins a contested pixel, because it is the thing drawn on top.
       */
      const truckUnder = (point: { x: number; y: number }): PointGroup | null => {
        if (cb.current.emphasis === "loads") return null;
        const half = TRUCK_GLYPH / 2;
        let best: PointGroup | null = null;
        let bestDistance = Infinity;
        for (const group of truckGroups.current) {
          const at = instance.project([group.lng, group.lat]);
          const cy = at.y - TRUCK_LIFT_PX;
          if (Math.abs(point.x - at.x) > half || Math.abs(point.y - cy) > half) continue;
          const d = Math.hypot(point.x - at.x, point.y - cy);
          if (d < bestDistance) {
            bestDistance = d;
            best = group;
          }
        }
        return best;
      };

      instance.on("mousemove", (e: MapLayerMouseEvent) => {
        const hit = truckUnder(e.point);
        if (!hit) {
          if (truckHover.current !== null) {
            truckHover.current = null;
            // Registered BEFORE the `points` listener, so a pointer moving from
            // an arrow straight onto a disc has its cursor cleared here and set
            // again there, in that order.
            instance.getCanvas().style.cursor = "";
            setHoverTruckKey(null);
            cb.current.onHoverTruck(null);
          }
          return;
        }
        instance.getCanvas().style.cursor = "pointer";
        if (truckHover.current === hit.key) return;
        truckHover.current = hit.key;
        setHoverTruckKey(hit.key);
        cb.current.onHoverTruck(hit.ids.length === 1 ? hit.ids[0]! : null);
      });
      instance.on("mouseout", () => {
        truckHover.current = null;
        setHoverTruckKey(null);
        cb.current.onHoverTruck(null);
      });
      instance.on("click", (e: MapLayerMouseEvent) => {
        const hit = truckUnder(e.point);
        if (!hit) return;
        // A marker holding several trucks opens the FIRST of them rather than
        // looking inside itself. The fan and the outward view answer "what is
        // at this warehouse and where does it go", which are questions about a
        // pile of FREIGHT; a pile of trucks at one yard is a list, and the list
        // is two hundred pixels away with all of them in it.
        cb.current.onSelectTruck(hit.ids[0]!);
      });

      instance.on("mousemove", "points", (e: MapLayerMouseEvent) => {
        if (cb.current.emphasis === "trucks") return;
        // The arrow is drawn over the disc, so it answers first.
        if (truckUnder(e.point)) return;
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
        if (cb.current.emphasis === "trucks") return;
        if (truckUnder(e.point)) return;
        const feature = e.features?.[0];
        const ids = idsOf(feature?.properties?.ids);
        if (!ids.length) return;
        if (ids.length === 1) {
          cb.current.onSelect(ids[0]!);
          return;
        }
        // A group is not a job. Clicking it says "show me these" -- and then
        // shows what is inside it, which is one of two completely different
        // pictures depending on whether those jobs share a real position or
        // merely share a rounding. See the file header.
        const key = String(feature?.properties?.key ?? "");
        const group = byKey.current.get(key);
        if (!group) return;
        cb.current.onGroupClick(ids, group.label);
        setFocus({ key, spot: null });

        // The camera may never claim more than the datum. This is the
        // overshoot the CTO hit: the old line was an unbounded +2.5, so a
        // marker clicked from a city zoom flew to individual driveways for a
        // coordinate known only to the city.
        const cap = maxZoomFor(group.precision);
        const here = instance.getZoom();
        const target = Math.min(Math.max(here + 2.5, 9), Math.max(cap, here));
        // The fan needs room to open; the outward view frames its own
        // destinations a moment later and must not be fought for the camera.
        if (group.spots.length > 1) {
          instance.easeTo({
            center: [group.lng, group.lat],
            zoom: target,
            // Into the middle of what can actually be SEEN, which on a phone
            // is neither the middle of the canvas nor the middle of the
            // window. The sheet floats over the lower half of the canvas, so
            // the fan would open behind it; the "on screen" panel holds the
            // left 234 px of a 390 px map, so a 54 px fan centred in what is
            // left would put two of its three leaves under a glass card.
            offset: [narrow.current ? 90 : 0, -pad.current / 2],
            duration: 600,
          });
        }
      });

      /* ---------------- the fan's leaves, and the far ends ----------------- */
      instance.on("mousemove", "focus-points", (e: MapLayerMouseEvent) => {
        if (truckUnder(e.point)) return;
        instance.getCanvas().style.cursor = "pointer";
        const props = e.features?.[0]?.properties;
        const key = props?.key as string | undefined;
        const ids = idsOf(props?.ids);
        const view = focusRef.current;
        if (view?.mode === "fan") {
          // A leaf is a position inside a marker and has no group of its own,
          // so it carries its own card.
          const spot = view.group.spots.find((s) => s.key === key);
          const at = (e.features?.[0]?.geometry as GeoPoint | undefined)?.coordinates as
            | [number, number]
            | undefined;
          setHoverLeaf(spot && at ? { spot, at } : null);
        } else {
          // In the outward view a leaf IS a group -- of the far end -- so the
          // ordinary hover card already knows how to describe it.
          setHoverKey(key ?? null);
        }
        cb.current.onHover(ids.length === 1 ? ids[0]! : null);
      });
      instance.on("mouseleave", "focus-points", () => {
        instance.getCanvas().style.cursor = "";
        setHoverLeaf(null);
        setHoverKey(null);
        cb.current.onHover(null);
      });
      instance.on("click", "focus-points", (e: MapLayerMouseEvent) => {
        if (truckUnder(e.point)) return;
        const props = e.features?.[0]?.properties;
        const ids = idsOf(props?.ids);
        if (!ids.length) return;
        if (ids.length === 1) {
          cb.current.onSelect(ids[0]!);
          return;
        }
        const key = String(props?.key ?? "");
        const label = String(props?.label ?? "this place");
        cb.current.onGroupClick(ids, label);
        // A leaf of the fan is one of the real positions: opening it is the
        // first case all over again, one level down. A far-end marker is
        // already the answer to "where do these go", so clicking it only
        // narrows the list.
        if (focusRef.current?.mode === "fan") {
          setFocus((f) => (f ? { ...f, spot: key } : f));
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
      for (const list of [
        stateMarkers,
        placeMarkers,
        labelMarkers,
        countMarkers,
        focusMarkers,
        truckMarkers,
      ]) {
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
    (m.getSource("trucks") as GeoJSONSource | undefined)?.setData(truckBuilt.features);
    // A new result set changes the totals even when the viewport does not --
    // and so does opening a place, which swaps the whole set of marks the
    // panel is counting without the camera moving at all.
    measureInView();
  }, [built, drawn, truckBuilt, ready, measureInView]);

  /* --------------------------- emphasis ------------------------------------
   *
   * Opacity and hit-testing, and nothing else. No request is made, no filter
   * changes, the URL is untouched, and both counts in the panel stay exactly
   * where they were: the de-emphasised population is quieter, not gone.
   * (SPEC 18 MAP5.)
   *
   * The preference is read once on mount rather than in `useState`'s
   * initialiser, so the server render and the first client render agree.
   */
  useEffect(() => setEmphasis(readEmphasis()), []);

  useEffect(() => {
    const m = map.current;
    if (!ready || !m || !m.getLayer("points")) return;
    const jobs = emphasis === "trucks" ? EMPHASIS_DIM : 1;
    const trucksScale = emphasis === "loads" ? EMPHASIS_DIM : 1;
    m.setPaintProperty("points", "circle-opacity", pointsOpacity(jobs));
    m.setPaintProperty("points", "circle-stroke-opacity", presence(1, jobs));
    m.setPaintProperty("points-lift", "circle-opacity", liftOpacity(jobs));
    // The two shape layers are part of the job mark, so they go quiet with it:
    // a pip and a dashed ring left at full strength over a de-emphasised disc
    // would be the loudest thing left on the map.
    if (m.getLayer("points-multi")) {
      m.setPaintProperty("points-multi", "circle-opacity", presence(0.8, jobs));
    }
    if (m.getLayer("points-approx")) {
      m.setPaintProperty("points-approx", "icon-opacity", presence(0.8, jobs));
    }
    if (m.getLayer("trucks")) {
      m.setPaintProperty("trucks", "icon-opacity", truckOpacity(trucksScale));
    }
    // The HTML labels are markers, not paint, so they fade in CSS. The count
    // badges and the state pills belong to the jobs; the truck pills to the
    // trucks.
    const fade = (kind: LabelKind, scale: number) => {
      for (const l of labels.current) {
        if (l.kind === kind) l.el.style.opacity = scale === 1 ? "" : String(scale);
      }
    };
    fade("count", jobs);
    fade("state", jobs);
    fade("truck", trucksScale);
    // A state pill is a JOB aggregate carrying a truck row, so it fades with
    // the jobs -- except that row, which is the trucks' and goes quiet with
    // them. Half a label at each strength, because it is two facts.
    for (const l of labels.current) {
      if (l.kind !== "state") continue;
      const row = l.el.querySelector<HTMLElement>(".t");
      if (row) row.style.opacity = trucksScale === 1 ? "" : String(trucksScale);
    }
  }, [emphasis, ready]);

  /**
   * The same fade, applied to a label the moment it is built.
   *
   * The effect above walks the labels that exist; the label effects rebuild
   * theirs whenever the data or the zoom tier changes, and a marker created
   * after an emphasis change would otherwise come back at full strength.
   */
  const fadeLabel = useCallback((el: HTMLElement, kind: "job" | "truck") => {
    const e = cb.current.emphasis;
    const quiet = kind === "job" ? e === "trucks" : e === "loads";
    el.style.opacity = quiet ? String(EMPHASIS_DIM) : "";
    // A state pill's truck row belongs to the other population; see above.
    const row = kind === "job" ? el.querySelector<HTMLElement>(".t") : null;
    if (row) row.style.opacity = e === "loads" ? String(EMPHASIS_DIM) : "";
  }, []);

  const chooseEmphasis = useCallback((next: Emphasis) => {
    setEmphasis(next);
    try {
      window.localStorage.setItem(EMPHASIS_KEY, next);
    } catch {
      // Private mode: the choice still holds for this page.
    }
  }, []);

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
    // The dashed ring is a baked bitmap and cannot be repainted, so the layer
    // swaps to the image baked in the other end's colour.
    if (m.getLayer("points-approx")) {
      m.setLayoutProperty(
        "points-approx",
        "icon-image",
        end === "pickup" ? "approx-ring-pickup" : "approx-ring-delivery",
      );
    }
  }, [end, ready]);

  /* ------------------- what is inside the opened marker --------------------
   *
   * One source, two pictures, and the layer order does the rest. The fan is
   * recomputed while the map moves because its leaves are placed in SCREEN
   * space (see `fanFeatures`); the outward view is real geography and is set
   * once per focus.
   */
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    const source = m.getSource("focus") as GeoJSONSource | undefined;
    if (!source) return;

    // The board's own dots are the OTHER end while the outward view is up, and
    // a map showing pickups and deliveries in one frame answers neither
    // question. The place itself stays, as the anchor.
    const hideBoard = focused?.mode === "outward";
    for (const id of [
      "points",
      "points-lift",
      "points-active",
      "points-active-gap",
      "points-multi",
      "points-approx",
    ]) {
      if (m.getLayer(id)) {
        m.setLayoutProperty(id, "visibility", hideBoard ? "none" : "visible");
      }
    }
    const mark = drawnEnd === "pickup" ? palette.current.pickup : palette.current.delivery;
    if (m.getLayer("focus-points")) m.setPaintProperty("focus-points", "circle-color", mark);
    if (m.getLayer("focus-leader")) m.setPaintProperty("focus-leader", "line-color", mark);
    if (m.getLayer("focus-approx")) {
      m.setLayoutProperty(
        "focus-approx",
        "icon-image",
        drawnEnd === "pickup" ? "approx-ring-pickup" : "approx-ring-delivery",
      );
    }

    for (const marker of focusMarkers.current) marker.remove();
    focusMarkers.current = [];
    setLabels("focus", []);

    if (!focused) {
      source.setData(EMPTY);
      return;
    }

    if (focused.mode === "outward") {
      // The ring says "not one of these"; only a name says which place it is.
      // Without it the bar at the top of the map is the only thing tying nine
      // scattered dots to the warehouse they came out of, and the bar is not
      // where the eye is.
      const { marker, el } = endMarker(m, [focused.at.lng, focused.at.lat], focused.label);
      focusMarkers.current.push(marker);
      setLabels("focus", [
        {
          kind: "focus",
          marker,
          el,
          lng: focused.at.lng,
          lat: focused.at.lat,
          anchor: "left",
          base: [14, 0],
          // The subject of the whole view: nothing on screen outranks it
          // except the two ends of an open job.
          weight: Number.MAX_SAFE_INTEGER - 1,
          fixed: true,
        },
      ]);

      source.setData({
        type: "FeatureCollection",
        features: [
          ...(outward?.features.features ?? []).map((f) => ({
            ...f,
            id: f.properties.key,
            properties: { ...f.properties, role: "leaf" },
          })),
          {
            type: "Feature",
            properties: { role: "anchor" },
            geometry: { type: "Point", coordinates: [focused.at.lng, focused.at.lat] },
          },
        ],
      });
      return;
    }

    // The fan: laid out now, and again on every frame the camera moves.
    const paint = () => source.setData(fanFeatures(m, focused.group));
    paint();
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        paint();
      });
    };
    m.on("move", schedule);
    return () => {
      m.off("move", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [focused, outward, drawnEnd, ready, setLabels]);

  /* ---------------------- framing what was opened -------------------------
   *
   * The outward view is the only thing on this map whose subject is off
   * screen by default: a warehouse in Minnesota sending loads to nine states
   * is not visible in the frame that was showing the warehouse. So it fits to
   * the destinations AND the place they leave from -- and remembers what the
   * viewer was looking at, because closing this has to give it back.
   */
  const focusPrior = useRef<maplibregl.LngLatBounds | null>(null);
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    if (focused?.mode !== "outward" || !outward) {
      if (focusPrior.current) {
        m.fitBounds(focusPrior.current, { duration: 500 });
        focusPrior.current = null;
      }
      return;
    }
    const coords: [number, number][] = outward.groups.map((g) => [g.lng, g.lat]);
    coords.push([focused.at.lng, focused.at.lat]);
    const box = bboxOf(coords);
    if (!box) return;
    if (!focusPrior.current) focusPrior.current = m.getBounds();
    m.fitBounds(box, {
      padding: { top: 70, right: 60, bottom: 60 + bottomPadding, left: 60 },
      duration: 600,
      // Every destination here is a real row with a real precision, and one
      // job going one town over must not frame that town at street zoom.
      maxZoom: Math.min(11, maxZoomOver(outward.groups.map((g) => g.precision))),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, outward, ready]);

  /**
   * The list's chip and the map's own Back button close the same state, so
   * whichever is pressed, both come back. A new search clears `place` in the
   * Board, which lands here as the same signal.
   */
  useEffect(() => {
    if (!placeActive && focus) setFocus(null);
  }, [placeActive, focus]);

  /** Escape is the other obvious way out, and costs nothing to offer. */
  useEffect(() => {
    if (!focus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setFocus(null);
      onPlaceClear?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, onPlaceClear]);

  const leaveFocus = useCallback(() => {
    setFocus(null);
    setHoverLeaf(null);
    onPlaceClear?.();
  }, [onPlaceClear]);

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
    m.fitBounds(box ?? CONUS, {
      padding,
      duration,
      // 9 was the only cap here, which is the right ceiling for a busy search
      // and the wrong one for a search that narrowed to a single job placed on
      // a state centroid: fitBounds on one point takes the cap literally, and
      // z9 over a state centroid draws a neighbourhood the row never claimed.
      // The cap only ever binds on a small box, so a national frame is
      // untouched by the precisions inside it.
      maxZoom: Math.min(9, maxZoomOver(built.groups.map((g) => g.precision))),
    });
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
    const focusKey = hoverKey ?? (focusId != null ? drawn.keyById.get(focusId) : undefined);

    // Whichever source is carrying the marks right now: while a place is open
    // outward, the board's own dots are hidden and the far ends are the map.
    for (const { source, key } of stated.current) {
      m.setFeatureState({ source, id: key }, { dim: false, active: false });
    }
    stated.current = [];

    // A marker whose fan is open has handed its jobs to the leaves. It stays
    // on screen as the hub the tethers run from -- take it away and three
    // discs are left floating over nothing -- but it recedes, because the
    // marks that mean something now are the three real positions.
    if (focused?.mode === "fan") {
      m.setFeatureState({ source: "points", id: focused.group.key }, { dim: true, active: false });
      stated.current.push({ source: "points", key: focused.group.key });
    }

    // A fanned-out leaf highlights itself rather than the whole marker: it is
    // the thing under the pointer, and its siblings are 40 px away.
    if (hoverLeaf) {
      m.setFeatureState({ source: "focus", id: hoverLeaf.spot.key }, { active: true });
      stated.current.push({ source: "focus", key: hoverLeaf.spot.key });
      return;
    }

    /* THE OPEN TRUCK'S SWING, AS AN ANSWER RATHER THAN A SHAPE.
     *
     * The capsule is drawn under the marks; this is what makes it mean
     * something. A job outside the band goes quiet, so a driver sees which
     * freight is inside their own stated corridor without reading a number.
     * Only for a SELECTED truck: a hover is a glance, and dimming ninety-eight
     * dots because a pointer crossed a card is the failure the arcs had. */
    if (truckCorridor && selectedTruckId != null) {
      for (const group of drawn.groups) {
        const inside = inCapsule(
          { lat: group.lat, lng: group.lng },
          truckCorridor.origin,
          truckCorridor.destination,
          truckCorridor.miles,
        );
        if (inside) continue;
        m.setFeatureState({ source: drawnSource, id: group.key }, { dim: true, active: false });
        stated.current.push({ source: drawnSource, key: group.key });
      }
    }

    // The truck under the pointer, or the one that is open. Its own key space:
    // job 12 and truck 12 are two listings, and one lookup holding both would
    // light the wrong mark.
    const truckFocusId = hoveredTruckId ?? selectedTruckId;
    const truckFocusKey =
      hoverTruckKey ??
      (truckFocusId != null ? truckBuilt.points.keyById.get(truckFocusId) : undefined);
    if (truckFocusKey) {
      for (const group of truckBuilt.points.groups) {
        m.setFeatureState(
          { source: "trucks", id: group.key },
          { dim: group.key !== truckFocusKey, active: group.key === truckFocusKey },
        );
        stated.current.push({ source: "trucks", key: group.key });
      }
    }

    if (!focusKey) return;
    for (const group of drawn.groups) {
      m.setFeatureState(
        { source: drawnSource, id: group.key },
        { dim: group.key !== focusKey, active: group.key === focusKey },
      );
      stated.current.push({ source: drawnSource, key: group.key });
    }
  }, [
    hoveredId,
    hoverKey,
    hoverLeaf,
    selectedId,
    hoveredTruckId,
    hoverTruckKey,
    selectedTruckId,
    truckBuilt,
    truckCorridor,
    drawn,
    drawnSource,
    focused,
    ready,
  ]);

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
    // A fanned-out leaf is a real position with no group of its own; it wears
    // the same card, pinned to the disc rather than to the coordinate, because
    // the disc is what the pointer is on.
    if (hoverLeaf) {
      const spot = hoverLeaf.spot;
      const single = spot.ids.length === 1 ? (jobs.find((j) => j.id === spot.ids[0]) ?? null) : null;
      return { key: spot.key, group: spot, single, at: hoverLeaf.at };
    }
    const key = hoverKey ?? (hoveredId != null ? drawn.keyById.get(hoveredId) : undefined);
    const group = key ? drawn.byKey.get(key) : undefined;
    if (!group) return null;
    // One job gets its own line -- lane, size, price, readiness -- because that
    // is what the viewer is about to decide on. A place gets the tally.
    const single =
      group.ids.length === 1 ? (jobs.find((j) => j.id === group.ids[0]) ?? null) : null;
    return { key: group.key, group, single, at: [group.lng, group.lat] as [number, number] };
  }, [hoverKey, hoverLeaf, hoveredId, jobs, drawn]);

  /**
   * The truck under the pointer -- from the map, or from a card in the list.
   *
   * Its own memo over its own `keyById`, because ids are unique only WITHIN a
   * population: job 12 and truck 12 are two different listings, and one lookup
   * table holding both would answer the wrong one.
   */
  const hoveredTruck = useMemo(() => {
    const key =
      hoverTruckKey ??
      (hoveredTruckId != null ? truckBuilt.points.keyById.get(hoveredTruckId) : undefined);
    const group = key ? truckBuilt.points.byKey.get(key) : undefined;
    if (!group) return null;
    const single =
      group.ids.length === 1 ? (trucks.find((t) => t.id === group.ids[0]) ?? null) : null;
    return { key: group.key, group, single, facts: truckBuilt.facts.get(group.key) };
  }, [hoverTruckKey, hoveredTruckId, trucks, truckBuilt]);

  // --- hover card ----------------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    popup.current?.remove();
    popup.current = null;
    if (!hovered && !hoveredTruck) return;

    const box = document.createElement("div");
    box.className = "map-hover";

    /* A PLACE HOLDING BOTH GETS TWO LINES AND NEVER ONE.
     *
     * The two marks are separate hit targets -- the arrow sits 14 px above the
     * disc -- but whichever one the pointer is on, the card names both, because
     * "4 jobs here" and "1 truck here" are the two things a dispatcher standing
     * on this coordinate wants and there is no number that is both of them.
     * Nothing on this card is added to anything else on it. (SPEC 18 MAP4.) */
    const truckAt = hoveredTruck ?? (hovered ? truckSidecar(hovered.key) : null);
    const jobAt = hovered ?? (hoveredTruck ? jobSidecar(hoveredTruck.key) : null);

    if (!jobAt && !truckAt) return;

    if (jobAt) appendJobLines(box, jobAt);
    // A card naming one coordinate says its name once. The second line is the
    // other population standing at the SAME place, so it drops the label and
    // keeps everything that differs.
    if (truckAt) {
      appendTruckLines(box, truckAt, boardDay(new Date()), jobAt != null && !jobAt.single);
    }

    // Anchored on whichever mark the pointer is actually on: a card pinned to
    // the disc while the pointer is on the arrow reads as belonging to the disc.
    const anchorOn = hoveredTruck ?? hovered!;
    const at: [number, number] =
      hoveredTruck && !hoverLeaf
        ? [hoveredTruck.group.lng, hoveredTruck.group.lat]
        : (hovered?.at ?? [anchorOn.group.lng, anchorOn.group.lat]);

    popup.current = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      // Clear of the mark rather than of its centre. For a truck that is the
      // arrow's own lift plus half its box; for a job it is the drawn radius,
      // which at 15,500 cf is twenty pixels.
      offset: hoveredTruck
        ? TRUCK_LIFT_PX + TRUCK_GLYPH / 2 + 4
        : Math.round(pointRadius(hovered!.group.cf, m.getZoom())) + 9,
    })
      .setLngLat(at)
      .setDOMContent(box)
      .addTo(m);

    function truckSidecar(key: string) {
      const group = truckBuilt.points.byKey.get(key);
      if (!group) return null;
      const single =
        group.ids.length === 1 ? (trucks.find((t) => t.id === group.ids[0]) ?? null) : null;
      return { key, group, single, facts: truckBuilt.facts.get(key) };
    }

    function jobSidecar(key: string) {
      const group = drawn.byKey.get(key);
      if (!group) return null;
      const single =
        group.ids.length === 1 ? (jobs.find((j) => j.id === group.ids[0]) ?? null) : null;
      return { key, group, single, at: [group.lng, group.lat] as [number, number] };
    }
  }, [hovered, hoveredTruck, hoverLeaf, drawn, jobs, trucks, truckBuilt, ready]);

  // --- the hovered truck's leg --------------------------------------------
  /**
   * Where a hovered truck is going, as a DASHED STRAIGHT LINE.
   *
   * Never a routed one, and that is a rule about money as much as about
   * drawing: a hover fires once per card a pointer crosses, and a hover that
   * bought a road route would bill the product forty times for a glance down a
   * list. The real road is drawn for the truck somebody OPENS, once, and it
   * stays.
   */
  useEffect(() => {
    const m = map.current;
    const source = m?.getSource("truck-leg") as GeoJSONSource | undefined;
    if (!ready || !source) return;
    if (!hoveredTruck) {
      source.setData(EMPTY);
      return;
    }
    const lines: FeatureCollection["features"] = [];
    for (const id of hoveredTruck.group.ids) {
      const mark = truckBuilt.markById.get(id);
      if (!mark?.other) continue;
      lines.push({
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [mark.lng, mark.lat],
            [mark.other.lng, mark.other.lat],
          ],
        },
      });
    }
    source.setData({ type: "FeatureCollection", features: lines });
  }, [hoveredTruck, truckBuilt, ready]);

  useEffect(() => {
    if (!open || !openKey) {
      setRoute(null);
      return;
    }
    // A truck that never said where it is going has no lane to route. Asking
    // for one would be a billable call about a fact nobody stated.
    if (open.kind === "truck") {
      const truck = trucks.find((t) => t.id === open.id);
      if (truck && truck.dest_lat == null) {
        setRoute(null);
        return;
      }
    }
    const cached = roadCache.current.get(openKey);
    if (cached) {
      setRoute({ key: openKey, road: cached });
      return;
    }

    let live = true;
    setRoute(null);
    const path = open.kind === "truck" ? `/api/trucks/${open.id}/route` : `/api/loads/${open.id}/route`;
    void fetch(api(path))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: RoadRouteResponse) => {
        const road: RoadRouteResponse = {
          path: Array.isArray(body?.path) && body.path.length > 1 ? body.path : null,
          miles: body?.miles ?? null,
          minutes: body?.minutes ?? null,
          unavailable: Boolean(body?.unavailable),
        };
        // Only a real answer is remembered; a network blip should be retryable.
        roadCache.current.set(openKey, road);
        if (live) setRoute({ key: openKey, road });
      })
      .catch(() => {
        if (live) {
          setRoute({
            key: openKey,
            road: { path: null, miles: null, minutes: null, unavailable: true },
          });
        }
      });
    return () => {
      live = false;
    };
    // `trucks` is read only to spot a destination-less truck; a new result set
    // that leaves the open truck unchanged must not re-ask for its road.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, openKey]);

  // --- draw it, and ease back when the selection closes --------------------
  useEffect(() => {
    const m = map.current;
    const source = m?.getSource("road") as GeoJSONSource | undefined;
    if (!ready || !m || !source) return;

    for (const marker of labelMarkers.current) marker.remove();
    labelMarkers.current = [];
    setLabels("route", []);

    if (open == null) {
      source.setData(EMPTY);
      if (priorBounds.current) {
        m.fitBounds(priorBounds.current, { duration: 600 });
        priorBounds.current = null;
      }
      return;
    }

    /* The lane's two ends and the two words that go on them, for whichever kind
     * is open. A truck's delivery label carries its FREE SPACE where a job's
     * carries its freight -- the same slot on the map, deliberately different
     * words, because "800 cf free" and "800 cf" are not the same fact. */
    const job = open.kind === "job" ? (jobs.find((j) => j.id === open.id) ?? null) : null;
    const truck = open.kind === "truck" ? (trucks.find((t) => t.id === open.id) ?? null) : null;

    let from: { lng: number; lat: number; precision: string | null } | null = null;
    let to: { lng: number; lat: number; precision: string | null } | null = null;
    let fromText = "";
    let toText = "";

    if (job) {
      from = endPoint(job, "pickup");
      to = endPoint(job, "delivery");
      fromText = endLabelText(job, "pickup");
      toText =
        job.cubic_feet != null
          ? `${endLabelText(job, "delivery")} · ${formatCf(job.cubic_feet)}`
          : endLabelText(job, "delivery");
    } else if (truck) {
      from = {
        lng: truck.origin_lng,
        lat: truck.origin_lat,
        precision: truck.origin_precision,
      };
      to =
        truck.dest_lat != null && truck.dest_lng != null
          ? { lng: truck.dest_lng, lat: truck.dest_lat, precision: truck.dest_precision }
          : null;
      fromText = truckPlaceLabel(truck, "origin").text;
      const free = freeSpaceLabel(truck);
      toText = to ? `${truckPlaceLabel(truck, "dest").text} · ${free.text}` : "";
    }

    const road = route?.key === openKey ? route.road.path : null;
    const coords: [number, number][] | null = road
      ? road
      : from && to
        ? [
            [from.lng, from.lat],
            [to.lng, to.lat],
          ]
        : null;

    if ((!job && !truck) || !coords) {
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
        // A short job -- Miami to Fort Lauderdale -- fits inside the old flat
        // 11, and both its ends may be city centroids. The frame is capped by
        // whichever end is known least precisely.
        maxZoom: Math.min(11, maxZoomOver([from?.precision, to?.precision])),
      });
    }

    if (from && to) {
      const ends: Array<{ at: [number, number]; text: string }> = [
        { at: [from.lng, from.lat], text: fromText },
        { at: [to.lng, to.lat], text: toText },
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
  }, [route, open, openKey, jobs, trucks, ready]);

  useEffect(() => {
    const m = map.current;
    const source = m?.getSource("truck-corridor") as GeoJSONSource | undefined;
    if (!ready || !source) return;
    if (!truckCorridor) {
      source.setData(EMPTY);
      return;
    }
    source.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              corridorRing(truckCorridor.origin, truckCorridor.destination, truckCorridor.miles),
            ],
          },
        },
      ],
    });
  }, [truckCorridor, ready]);

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

  /**
   * Whether the STATE totals are the aggregation on screen right now.
   *
   * The state effect below draws them when the zoom is under PILL_MAX_ZOOM and
   * no marker is open outward; this is the same condition, hoisted, because the
   * count badges have to be its exact complement (V10).
   */
  const statesAggregating = !detailed && focused?.mode !== "outward";

  // --- counts on the markers that hold more than one job -------------------
  // Only the groups that need it: a singleton's name is on its card and in its
  // hover, and a label per dot would bury the map in text.
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    for (const marker of countMarkers.current) marker.remove();
    countMarkers.current = [];

    /* ONE CLUSTERING STRATEGY AT A TIME (V10).
     *
     * These badges and the state totals are two different aggregations of the
     * same jobs -- this dot holds 8, that state holds 22 -- and until now both
     * were drawn at the national view. They did not overlap, because the
     * placer would not let them; what they did instead was take each other's
     * slots. Measured at 1440 over the seeded board at z 3.7: 25 labels
     * placed, 14 state pills and 11 badges, with two states and fourteen piles
     * silently unlabelled because the other family had already claimed the
     * pixels. A map that hides half of each of two answers is worse than one
     * that gives all of one.
     *
     * So the zoom picks the aggregation and the other one stands down. Under
     * PILL_MAX_ZOOM the state is the cluster; over it the place is, and the
     * badge picks up the place's name and becomes the place pill. Nothing is
     * lost at the national view that the map was not already saying: the
     * disc's AREA is the freight standing there, which is the number this
     * board says a driver is actually filling a truck against, and the pile's
     * own tally is one hover away and in the dot's `title`.
     *
     * Inside an opened marker there are no state pills to compete with -- they
     * are suppressed there for their own reasons -- so the badges stay, and
     * the rule holds: one aggregation on screen, whatever the zoom.
     */
    if (statesAggregating) {
      setLabels("count", []);
      return;
    }

    const next: MapLabel[] = [];
    // The markers actually drawn, which while a place is open outward are the
    // far ends of its jobs -- a badge counting pickups over a delivery dot
    // would be the map contradicting itself.
    for (const group of drawn.groups) {
      if (group.ids.length < 2) continue;
      // Its own fan is open: the count is now spread across the leaves, and a
      // badge reading 8 over three discs holding 6, 1 and 1 is arithmetic the
      // viewer has to do to disbelieve. The bar says which place this is.
      if (focused?.mode === "fan" && group.key === focused.group.key) continue;
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
      el.dataset.end = drawnEnd;
      if (group.approx) el.dataset.approx = "";
      el.title = groupSummary(group);
      fadeLabel(el, "job");
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
  }, [drawn, detailed, drawnEnd, focused, ready, setLabels, fadeLabel, statesAggregating]);

  /* ------------------------- the truck labels ------------------------------
   *
   * Through the SAME HTML-marker declutter pass the state totals and the count
   * badges go through, and deliberately not through a symbol layer's
   * `text-field`. MapLibre's collision boxes cannot see an HTML marker, so a
   * truck label placed by MapLibre would be placed against a map it can only
   * see half of -- and every other label on this map is HTML. The arrow ICON is
   * a symbol layer; only the text is not. (There is also no glyph source in
   * this style, and adding one is a runtime dependency on a font server.)
   *
   * FREE SPACE IS ON THE LABEL, IN WORDS, because it is not on the mark: the
   * arrow is one fixed size and always will be. The unit phrase is "cf free",
   * never a bare "cf".
   */
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    for (const marker of truckMarkers.current) marker.remove();
    truckMarkers.current = [];

    // Not while a place is open outward: the map is then answering "where do
    // this warehouse's jobs go", and a truck standing somewhere else is not
    // part of that answer.
    // And not above the collapse threshold: the arrows stay, the words go.
    if (focused?.mode === "outward" || truckLabelsHidden) {
      setLabels("truck", []);
      return;
    }

    const next: MapLabel[] = [];
    for (const group of truckBuilt.points.groups) {
      const facts = truckBuilt.facts.get(group.key);
      const n = group.ids.length;
      const free = group.cf > 0 ? `${formatCf(group.cf)} free` : SPACE_NOT_STATED;

      const el = document.createElement("div");
      el.className = "map-pill map-truck nums";
      if (group.cf === 0) el.dataset.unstated = "";
      const k = document.createElement("span");
      k.className = "k";
      const v = document.createElement("span");
      v.className = "v";
      if (detailed) {
        // Room for the place as well: at this zoom the state totals are gone
        // and a label can afford to say which yard it is standing in.
        k.textContent = n > 1 ? `${group.label} · ${n} trucks` : group.label;
        v.textContent = free;
      } else {
        // Zoomed out the label is pinned to an arrow a driver can see, so the
        // place is the one thing it can spend nothing on. What cannot go is the
        // number and its unit: without them the arrow says a truck is here and
        // nothing at all about whether it is any use.
        k.textContent = n > 1 ? `${n} trucks` : "";
        v.textContent = free;
      }
      if (k.textContent) el.append(k);
      el.append(v);
      el.title = truckGroupSummary(group, facts);
      fadeLabel(el, "truck");

      const marker = new maplibregl.Marker({ element: el, anchor: "top", offset: [0, 6] })
        .setLngLat([group.lng, group.lat])
        .addTo(m);
      truckMarkers.current.push(marker);
      next.push({
        kind: "truck",
        marker,
        el,
        lng: group.lng,
        lat: group.lat,
        anchor: "top",
        // Under the arrow, not over it: the arrow already sits 14 px ABOVE the
        // coordinate to clear a job's dot, so the space under the coordinate is
        // the one place on this marker nothing else is using.
        base: [0, 6],
        // And under the DISC, when a job is standing on the same coordinate.
        // At Kearny that disc holds eight jobs and is 29 px across at z9; a
        // flat six-pixel drop put the truck's free space inside it, the placer
        // bumped the label, and the biggest offer on the map lost its words.
        clearOf: byKey.current.get(group.key)?.cf ?? 0,
        below: true,
        // Below a job's count badge, which orphans a mark when it is hidden,
        // and above a state total, which is an aggregate the list also prints.
        // The bigger offer keeps its words when two trucks collide.
        weight: 400_000 + group.cf,
      });
    }
    setLabels("truck", next);
    // `built` is a dependency because `clearOf` above reads the job disc this
    // label has to sit under, and that disc changes size with the result set.
  }, [truckBuilt, built, detailed, focused, ready, setLabels, fadeLabel, truckLabelsHidden]);

  // --- state-total pills ---------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    for (const marker of stateMarkers.current) marker.remove();
    stateMarkers.current = [];
    // Not while a place is open outward: these pills total the WHOLE result on
    // the end the board is filtering, and the map underneath them is showing
    // one warehouse's nine destinations. Two different sets, one screen -- and
    // a pill that filters the board is the wrong control to offer somebody who
    // is inside a marker.
    if (detailed || focused?.mode === "outward") {
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

    /* The state's TRUCKS, counted separately and printed on a row of their own.
     *
     * NEVER A MERGED COUNT. "FL · 14 jobs" and "2 trucks" are answers to two
     * different questions and there is no number that is both -- and counted on
     * the same end the pill's jobs are, from the marks that were actually
     * plotted, so a truck with no stated destination is absent from the
     * Deliveries pills exactly as it is absent from the map. */
    const truckTotals = new Map<string, number>();
    for (const group of truckBuilt.points.groups) {
      if (!group.state) continue;
      truckTotals.set(group.state, (truckTotals.get(group.state) ?? 0) + group.ids.length);
    }

    const noun = end === "pickup" ? "pickups" : "deliveries";
    const next: MapLabel[] = [];
    for (const [st, t] of totals) {
      const info = STATE_BY_ABBR.get(st);
      if (!info) continue;
      const trucksHere = truckTotals.get(st) ?? 0;
      const el = document.createElement("button");
      el.type = "button";
      el.className = trucksHere > 0 ? "map-pill map-state-2 nums" : "map-pill nums";
      const full = `${st} · ${t.jobs} job${t.jobs === 1 ? "" : "s"} · ${t.cf.toLocaleString("en-US")} cf`;
      // Two spans, not one string: the state is the thing and the totals are
      // its measurement, and setting them in one weight made every pill a wall
      // of equal-value text. The separator between them is the gap.
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = st;
      const v = document.createElement("span");
      v.className = "v";
      /* VOLUME ON DEMAND, NOT ON EVERY PILL FOREVER (V10).
       *
       * Sixteen of these used to print "FL · 9 jobs · 4,900 cf" over the
       * country at once -- three facts each, forty-eight readings of a number
       * nobody had asked for, and the pill wide enough that the placer had to
       * hide several of them to fit the rest. The volume that IS asked for on
       * arrival is the one the panel gives: the total on screen.
       *
       * So the pill carries the state and its count, and the cubic feet come
       * back the moment somebody asks about this state -- a pointer on it or
       * the keyboard focus. The full sentence is on the `title` at all times,
       * which is what a screen reader and a long hover both read.
       *
       * Swapping the text rather than un-hiding a second span is deliberate:
       * the placer caches a label's measured box under its class and its text,
       * so a changed string is a new measurement rather than a stale one.
       */
      const quiet = `${t.jobs} job${t.jobs === 1 ? "" : "s"}`;
      const loud = `${quiet} · ${t.cf.toLocaleString("en-US")} cf`;
      v.textContent = quiet;
      const show = () => {
        v.textContent = loud;
      };
      const hide = () => {
        v.textContent = quiet;
      };
      el.addEventListener("pointerenter", show);
      el.addEventListener("focus", show);
      el.addEventListener("pointerleave", hide);
      el.addEventListener("blur", hide);
      if (trucksHere > 0) {
        // Two rows in one pill, not two facts in one sentence.
        const row = document.createElement("span");
        row.className = "r";
        row.append(k, v);
        const trucksRow = document.createElement("span");
        trucksRow.className = "t";
        trucksRow.textContent = `${trucksHere} truck${trucksHere === 1 ? "" : "s"}`;
        el.append(row, trucksRow);
      } else {
        el.append(k, v);
      }
      fadeLabel(el, "job");
      el.title =
        `${full} — click to filter ${noun} to ${st}` +
        (trucksHere > 0
          ? `. ${trucksHere} truck${trucksHere === 1 ? " is" : "s are"} standing here as well; that is a separate count and the two are never added.`
          : "");
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
  }, [jobs, end, detailed, focused, ready, setLabels, truckBuilt, fadeLabel]);

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

  // --- how much map there actually is ---------------------------------------
  // The shell is full height and the sheet floats over its lower part, so the
  // BAND a viewer can see is the shell less whatever the sheet is covering.
  // The key below is placed against that number rather than against the
  // viewport, because at 320 x 568 those two are 455 px and 143 px.
  useEffect(() => {
    const el = shell.current;
    if (!el) return;
    const measure = () => setShellH(Math.round(el.getBoundingClientRect().height));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

  /* TWO TOTALS, TWO NOUNS, TWO BLOCKS, AND NOTHING SUMS ACROSS (SPEC 14.5).
   *
   * `totalCf` is FREIGHT and feeds `truckLine()` -- the "= 28.3 truckloads"
   * figure, which divides a volume of freight by the size of a truck.
   * `totalFreeCf` is FREE SPACE and feeds nothing but its own sentence: divided
   * by a truck size it would print how many trucks fit in your trucks. */
  const totalCf = inViewJobs?.cf ?? 0;
  const totalFreeCf = inViewTrucks?.freeCf ?? 0;
  // While a place is open outward the panel is counting ITS jobs, not the
  // board's -- `inViewJobs` is measured over whatever `drawn` holds, so the
  // denominators here have to move with it or the panel would report a
  // fraction of one set as a fraction of another.
  const plottable = focused?.mode === "outward" ? focused.ids.length : jobs.length;
  const allShown = inViewJobs != null && inViewJobs.count >= plottable;
  const notPlotted = plottable - drawn.plotted;
  /** The map is showing trucks at all: day one has none, and says nothing. */
  const anyTrucks = truckBuilt.points.groups.length > 0 || truckNoDest > 0;
  /** At least one mark on screen is a ring rather than an arrow. */
  const hasUndirectedTruck = truckBuilt.points.groups.some(
    (g) => truckBuilt.facts.get(g.key)?.bearing == null,
  );
  /** At least one drawn marker is a pile, so the pip key has something to key. */
  const anyMulti = drawn.groups.some((g) => g.ids.length > 1 && !g.approx);

  /* --- V08: what the folded panel says, and how much it is holding --------- */

  /** The one line the compact control shows before anybody opens it. */
  const compactSummary = error
    ? "No count — the board did not load"
    : inViewJobs == null || loading
      ? null
      : `${allShown ? "All " : ""}${inViewJobs.count} job${
          inViewJobs.count === 1 ? "" : "s"
        } · ${totalCf.toLocaleString("en-US")} cf on screen`;

  /**
   * How many CAVEATS are folded away -- never how many facts.
   *
   * The distinction is the whole reason this number exists. A statistic behind
   * a disclosure is a statistic somebody can go and get; a caveat behind one is
   * a thing the board knows and did not say, and this board's one claim is that
   * it does not quietly leave things out. So the collapsed row carries the
   * count in amber, and every one of them is a tap away.
   */
  const compactNotes = [
    truckNoDest > 0,
    truckLabelsHidden,
    notPlotted > 0,
    (inViewJobs?.unsized ?? 0) > 0,
    inViewTrucks != null && inViewTrucks.unstated > 0,
  ].filter(Boolean).length;

  /**
   * Is there enough map left for a key to stand on?
   *
   * Measured, not assumed. The statistics control is 60 px, the key is 44,
   * MapLibre's attribution is 34, and the three of them want two gaps: 174 px
   * of chrome. At 320 x 568 with the sheet at its default snap the visible
   * band is 143 px, which is how the key came to be printed inside the
   * statistics panel -- the panel measured y 125-205 and the key y 154-198.
   *
   * The key is what goes, because of the three it is the only one that is
   * reference material: the statistics are about THIS view and the attribution
   * is a licence condition. It comes back the moment the sheet drops, which is
   * one tap on the Map control the same board now carries.
   */
  const mapBand = Math.max(0, shellH - bottomPadding);
  const roomForKey = !compact || mapBand >= 200;

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
  // A truck with no stated destination has no lane, so nothing was asked for
  // and nothing is missing: `route` stays null and this notice must not fire.
  const noRoad =
    openKey != null && route?.key === openKey && route.road.path == null;

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
        className={`glass absolute left-[var(--sp-3)] max-w-[260px] ${compact ? "p-[var(--sp-2)]" : "p-[var(--sp-3)]"}`}
        /* The bar that says which marker is open takes the top strip while it
           is there, and this panel goes under it. Unconditional rather than
           measured: the bar is centred and this panel is 260 px on the left,
           so whether they collide depends on the width of the map, and a
           layout that is correct at 1440 and overlapping at 1024 is the kind
           of thing nobody sees until a customer does. */
        style={{ top: focused ? "calc(var(--sp-3) + 72px)" : "var(--sp-3)" }}
        title={`Jobs whose ${drawnEnd} is on screen, and the cubic feet standing there. Hollow markers sit on a state centroid rather than a real address. Jobs without a stated size are counted but add nothing to the total.`}
      >
        {/* V08: ON A PHONE THIS PANEL IS ONE CONTROL.
            Collapsed it is a single row -- the count, the volume, and how many
            caveats are waiting underneath -- and opening it brings back every
            line the desktop panel prints. It is a button rather than a card
            with a chevron in the corner because the whole row is the target,
            and at 320 px the two cards this replaces were printing over each
            other (the panel measured y 125-205 and the legend y 165-198). */}
        {compact && (
          <button
            type="button"
            aria-expanded={statsOpen}
            onClick={() => setStatsOpen((v) => !v)}
            className="flex w-full items-center gap-[var(--sp-2)] text-left"
            style={{ background: "none", minHeight: "var(--tap-min)", color: "var(--text)" }}
            title="What is on this view, and the controls for it"
          >
            {compactSummary == null ? (
              <span className="skeleton h-[16px] w-[150px]" />
            ) : (
              <span
                className="big nums text-(length:--fs-md)"
                style={error ? { color: "var(--approx)" } : undefined}
              >
                {compactSummary}
              </span>
            )}
            {/* Folded, never dropped: a caveat that is one tap away is still
                disclosed, a caveat nobody is told about is not. */}
            {!statsOpen && compactNotes > 0 && (
              <span className="text-(length:--fs-xs)" style={{ color: "var(--approx)" }}>
                {compactNotes} note{compactNotes === 1 ? "" : "s"}
              </span>
            )}
            <span aria-hidden className="ml-auto" style={{ color: "var(--muted)" }}>
              {statsOpen ? "▴" : "▾"}
            </span>
          </button>
        )}

        {(!compact || statsOpen) && (
          <>
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
          // Said in the panel's own voice, not as a second announcement of the
          // outage: the Board already prints "Could not load jobs to plot."
          // over the middle of the map with the retry on it, and two notices
          // saying the same sentence in one rectangle is the failure this
          // map's error states were arranged to avoid. This one only has to
          // explain the missing number.
          // On compact the collapsed control above already says it, so this
          // would be the same sentence twice in a 231 px box.
          compact ? null : (
            <div className="text-(length:--fs-sm)" style={{ color: "var(--approx)" }}>
              No count — the board did not load.
            </div>
          )
        ) : inViewJobs == null || loading ? (
          compact ? null : (
            <>
              <span className="skeleton h-[16px] w-[150px]" />
              <span className="skeleton mt-[4px] h-[12px] w-[110px]" />
            </>
          )
        ) : (
          <>
            {!compact && (
              <div className="big nums text-(length:--fs-lg)">
                {`${allShown ? "All " : ""}${inViewJobs.count} job${inViewJobs.count === 1 ? "" : "s"} · ${totalCf.toLocaleString("en-US")} cf`}
              </div>
            )}
            {/* Compact used to drop this line entirely; now it is behind the
                disclosure with everything else, which is where V08 asks for
                it -- one control, and the statistics inside it. */}
            <div className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
                {/* `truckLine` is fed from the JOB total and from nothing else,
                    for ever. It says "= 28.3 truckloads", which is a statement
                    about how much freight is on screen; handed a count of free
                    space it would divide free space by a truck size and print
                    how many trucks fit in your trucks.

                    V04, AND THE REASON IT IS BEHIND A DISCLOSURE HERE TOO.
                    The list header moved this line one click back because
                    1,500 cf is a reference vehicle this board invented and the
                    reader does not own one. That argument does not stop at the
                    edge of the map: leaving it printed here left the same
                    assumption standing, unqualified, in the other summary on
                    the same screen. Counts stay on the face of the panel;
                    anything computed from an assumption goes inside, with the
                    assumption named next to it -- the same words the list
                    header uses, so the two cannot drift apart.

                    On compact the whole PANEL is already that one disclosure
                    (V08), so a second one inside it would be two taps to a
                    caveat. There it stays inline. */}
                {totalCf <= 0 ? (
                  "No stated sizes on screen"
                ) : compact ? (
                  truckLine(totalCf, viewer?.truckCf ?? null)
                ) : (
                  <details className="inline">
                    <summary className="inline cursor-pointer" style={{ color: "var(--accent)" }}>
                      Statistics
                    </summary>
                    <div
                      className="mt-[var(--sp-2)] rounded-[var(--radius-sm)] px-[var(--sp-3)] py-[var(--sp-2)] text-(length:--fs-xs)"
                      style={{ background: "var(--surface-2)" }}
                    >
                      {truckLine(totalCf, viewer?.truckCf ?? null)} —{" "}
                      {viewer?.truckCf && viewer.truckCf > 0
                        ? "against the truck size you stored."
                        : "against an assumed reference vehicle. It is not the space in your truck; store yours in Truck empty at and this line changes."}
                    </div>
                  </details>
                )}
                {/* Total capacity and free space are two different numbers and
                    this line has always quoted the first one. Saying the
                    second one next to it is the whole distinction: a truck is
                    how much you could ever carry, free space is how much of
                    this screenful you could actually take. */}
                {freeCf != null && ` · ${freeCf.toLocaleString("en-US")} cf free`}
                {inViewJobs.unsized > 0 && ` · ${inViewJobs.unsized} without size`}
            </div>

            {/* THE SECOND BLOCK. A blank line, a second noun, a second total,
                and no arithmetic between them: "61 jobs · 24,110 cf" and
                "4 trucks · 3,100 cf free" are two answers and there is no
                number that is both. It renders only when there is a truck on
                screen -- on day one this whole block is absent rather than
                printing a nought (SPEC 2, 15.3). */}
            {inViewTrucks != null && inViewTrucks.count > 0 && (
              <div
                className="mt-[var(--sp-1)]"
                title="Free space on trucks standing on this view. A separate quantity from the freight above it; the two are never added."
              >
                <div
                  className={compact ? "big nums text-(length:--fs-sm)" : "big nums text-(length:--fs-md)"}
                  style={{ color: "var(--truck)" }}
                >
                  {`${inViewTrucks.count} truck${inViewTrucks.count === 1 ? "" : "s"}`}
                  {totalFreeCf > 0 ? ` · ${totalFreeCf.toLocaleString("en-US")} cf free` : ""}
                  {/* The same words the job list uses when its own search hits
                      the page limit. A map drawing a prefix of the answer has
                      to say which part it is drawing. */}
                  {truckTruncated && (
                    <span className="font-normal" style={{ color: "var(--muted)" }}>
                      {" · showing first 500"}
                    </span>
                  )}
                </div>
                {inViewTrucks.unstated > 0 && (
                  <div className="text-(length:--fs-xs)" style={{ color: "var(--approx)" }}>
                    {inViewTrucks.unstated} space{inViewTrucks.unstated === 1 ? "" : "s"} not stated
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Trucks that are IN the result and not on this view, because they
            never said where they are going and this is the map of arrivals.
            Printed rather than swallowed: the alternative is a driver reading
            a truck count that quietly excludes some of them. */}
        {truckNoDest > 0 && (
          <div className="mt-[2px] text-(length:--fs-xs)" style={{ color: "var(--approx)" }}>
            {truckNoDest} truck{truckNoDest === 1 ? "" : "s"} with no stated destination{" "}
            {truckNoDest === 1 ? "isn't" : "aren't"} on this view.
          </div>
        )}
        {truckLabelsHidden && (
          <div className="mt-[2px] text-(length:--fs-xs)" style={{ color: "var(--muted-2)" }}>
            Truck labels hidden — zoom in.
          </div>
        )}

        {/* What one job does to the space that is actually left -- the
            question a driver with a half-full truck is asking, and the one a
            truckload divisor cannot answer. Shown only when they have said
            how much room they have; there is no honest default for it, and
            guessing one is how "≈ 28.3 truckloads" got written. */}
        {!error && freeCf != null && focusJob && (
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
            {notPlotted} job{notPlotted === 1 ? " has" : "s have"} no mappable {drawnEnd}
          </div>
        )}
        {/* Not while a place is open outward: the number on the line above is
            then a count of that place's destinations, and "of 98 filtered"
            beneath it invites reading one set as a fraction of the other. The
            bar at the top of the map already says which set is on screen. */}
        {/* Job counts only, on both sides. `filteredSummary` is a LoadSummary
            and `inViewJobs` counts job marks; a truck has never been in either
            number and this comparison is not the place to start. */}
        {focused?.mode !== "outward" &&
          filteredSummary &&
          inViewJobs &&
          filteredSummary.count !== inViewJobs.count && (
            <div className="text-(length:--fs-xs)" style={{ color: "var(--muted-2)" }}>
              of {filteredSummary.count} filtered
            </div>
          )}

        {/* BOTH · LOADS · TRUCKS.
            Emphasis, not filtering: the quiet population stays drawn at a
            quarter opacity, stays counted on the lines above, and only stops
            taking the pointer. A dispatcher still sees a truck heading their
            way NEXT TO the job that needs it, which is the whole reason both
            are on one map. Nothing here is a search: no request is made and
            the URL does not change. */}
        {anyTrucks && (
          <div
            /* On a phone this control is 26 px inside a panel that is already
               taking more than half a 267 px map band, so it takes the tighter
               row and the smaller gap above it. */
            className={`seg map-emphasis ${compact ? "map-emphasis-sm mt-[var(--sp-1)]" : "mt-[var(--sp-2)]"}`}
            role="group"
            aria-label="Which marks to emphasise"
          >
            {(
              [
                ["both", "Both"],
                ["loads", "Loads"],
                ["trucks", "Trucks"],
              ] as Array<[Emphasis, string]>
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className="seg-option"
                data-kind={value}
                data-on={emphasis === value ? "" : undefined}
                aria-pressed={emphasis === value}
                onClick={() => chooseEmphasis(value)}
                title={
                  value === "both"
                    ? "Draw both populations at full strength"
                    : value === "loads"
                      ? "Keep the trucks on the map, quiet and out of the way"
                      : "Keep the jobs on the map, quiet and out of the way"
                }
              >
                {label}
              </button>
            ))}
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
          </>
        )}
      </div>

      {/* The two ways this map degrades without dying, stacked so they cannot
          land on top of each other. Both are ASYNC failures on somebody else's
          network -- a blocked tile host, a routing provider that timed out --
          and neither one is a reason to take the map away, let alone the board:
          the jobs are plotted either way. Each retries only itself. */}
      {(focused || tilesDown || noRoad) && (
        /* Full width and centred, not `left-1/2` with a translate: an
           absolutely positioned box with only `left` set shrinks to fit the
           space from that edge to the right of the map, which on a 390 px
           phone is 195 px -- and a bar half the screen wide wrapped "Where 11
           jobs at Rochester, MN go" onto four lines. The strip lets pointer
           events through; only what is drawn in it takes them. */
        <div className="pointer-events-none absolute inset-x-0 top-[var(--sp-3)] flex flex-col items-center gap-[var(--sp-2)] px-[var(--sp-3)]">
          {/* Looking inside a marker is a mode, and a mode with no visible way
              out is a trap -- the CTO's complaint began with a click that
              changed the map and left nothing on screen saying what had
              happened. So this says what is being shown, in the words of the
              two cases, and carries the way back. Escape does the same, and so
              does the list's own chip; all three clear one piece of state. */}
          {focused && (
            <div
              data-map-chrome
              /* Capped in vw rather than in per cent: on a phone the map is
                 the viewport and this has to leave the "on screen" panel its
                 corner; on the desktop board the map is 1019 px of 1440 and
                 the cap is the 420 px, not the ratio. */
              className="glass pointer-events-auto flex max-w-[min(90vw,420px)] items-center gap-[var(--sp-3)] px-[var(--sp-3)] py-[var(--sp-2)] text-(length:--fs-sm)"
            >
              <div className="min-w-0">
                <div className="font-semibold" style={{ color: "var(--text)" }}>
                  {focused.mode === "fan"
                    ? `${focused.group.spots.length} places on one marker`
                    : // In Deliveries the marker is where freight ARRIVES, so
                      // the other end is where it started: "go" would have the
                      // country pointing the wrong way.
                      `Where ${focused.ids.length} job${focused.ids.length === 1 ? "" : "s"} at ${focused.label} ${end === "pickup" ? "go" : "come from"}`}
                </div>
                {!compact && (
                  <div className="text-(length:--fs-xs)" style={{ color: "var(--muted)" }}>
                    {focused.mode === "fan"
                      ? // Said plainly, because the fan's discs are NOT where
                        // the jobs are: the leader lines are, and a viewer who
                        // has not been told that will read the ring as data.
                        `${focused.label} — pulled apart on lines to where each really is`
                      : outward && outward.groups.length > 0
                        ? `${outward.groups.length} ${drawnEnd === "delivery" ? "destination" : "origin"}${outward.groups.length === 1 ? "" : "s"}` +
                          (notPlotted > 0
                            ? ` · ${notPlotted} with no mappable ${drawnEnd}`
                            : "")
                        : // Nothing to draw, said as nothing to draw. The list
                          // beside this still holds the jobs.
                          `No ${drawnEnd} on any of these could be placed on a map`}
                  </div>
                )}
              </div>
              {/* On a phone the map band is 261 px tall at the sheet's default
                  snap and this bar is at the top of it, so the words that can
                  go, go. What may not go is the button: it is the way out. */}
              <button type="button" className="btn btn-sm shrink-0" onClick={leaveFocus}>
                {compact ? "Back" : "Back to all jobs"}
              </button>
            </div>
          )}
          {tilesDown && (
            <div
              data-map-chrome
              className="glass pointer-events-auto flex items-center gap-[var(--sp-3)] px-[var(--sp-3)] py-[var(--sp-2)] text-(length:--fs-sm)"
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
              className="glass pointer-events-auto px-[var(--sp-3)] py-[var(--sp-2)] text-(length:--fs-sm)"
              style={{ color: "var(--approx)" }}
            >
              Road route unavailable — showing a straight line.
            </div>
          )}
        </div>
      )}

      {/* Hidden on a phone while a job is open, and while a marker is open --
          and only then. The visible map band is 261 px at the sheet's default
          snap, and both of those states put something on it that IS the map's
          current sentence: the route's two end labels, or a fan of discs on
          leader lines. This is reference material, and reference material
          loses. */}
      {/* V08: on a phone the key is asked for, not printed.
          It is reference material -- the same four rows on every screen of
          every session -- and on a 390 px board it was a 249 px opaque card
          permanently parked on a 261 px band of map, which at 320 landed
          inside the statistics panel above it. Collapsed it is a 44 px "Key"
          button in the same corner; open it is exactly the panel it was. On
          the desktop nothing changes: there is room, and it stays open. */}
      {compact && roomForKey && !legendOpen && !(open != null || focused) && (
        <button
          type="button"
          data-map-chrome
          aria-expanded={false}
          className="glass point-legend px-[var(--sp-3)]"
          style={{ minHeight: "var(--tap-min)", color: "var(--muted)" }}
          onClick={() => setLegendOpen(true)}
          title="What the marks on this map mean"
        >
          Key
        </button>
      )}
      {compact && (open != null || focused) ? null : compact &&
        (!legendOpen || !roomForKey) ? null : (
      <div
        data-map-chrome
        className="glass point-legend px-[var(--sp-3)] py-[var(--sp-2)]"
        style={
          {
            "--map-point": drawnEnd === "pickup" ? "var(--pickup)" : "var(--delivery)",
          } as React.CSSProperties
        }
      >
        {compact && (
          <button
            type="button"
            aria-expanded
            onClick={() => setLegendOpen(false)}
            style={{ background: "none", color: "var(--muted)", minHeight: "var(--tap-min)" }}
            title="Hide the key"
          >
            Key ✕
          </button>
        )}
        <b>
          <i className="sm" />
          <i className="lg" /> size = cubic feet
        </b>
        {/* A key is only worth having if it is the mark the map draws, so it
            gets the pip the map now puts through a pile (V10). Earned, not
            permanent: on a board where every marker holds one job this row
            would be explaining something that is not on screen. */}
        {anyMulti && (
          <b title="More than one job standing at this place. The disc's size is still the freight, not the count; the number is on the label and on the hover.">
            <span
              style={{
                position: "relative",
                display: "inline-flex",
                width: 14,
                height: 14,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <i style={{ width: 14, height: 14 }} />
              <span
                style={{
                  position: "absolute",
                  width: 4.5,
                  height: 4.5,
                  borderRadius: "50%",
                  background: "#fff",
                  opacity: 0.85,
                }}
              />
            </span>{" "}
            {compact ? "2+" : "2+ jobs here"}
          </b>
        )}
        {/* The dashed ring, drawn the way the map draws it: the soft dot
            inside its own broken edge. The swatch used to be the blurred dot
            alone, which stopped being the whole mark the moment V10 gave an
            approximate position a shape of its own. */}
        <b title="Placed no more finely than a state or a region — the post never gave an address. The dot is soft and the ring is broken because we are guessing, and the map says so rather than drawing a street.">
          <span
            style={{
              position: "relative",
              display: "inline-flex",
              width: 19,
              height: 19,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <i className="approx" />
            <span
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: "50%",
                border: "1.5px dashed var(--map-point, var(--pickup))",
                opacity: 0.8,
              }}
            />
          </span>{" "}
          approximate
        </b>
        {/* Only once there is a truck in the source. On day one the map is
            unchanged and says nothing about a population that is not there --
            a legend key for an empty set is a promise the board cannot keep
            (SPEC 2). The arrow is NOT on the size scale beside it, which is
            the one thing these rows have to make obvious.

            ON A PHONE THE TWO TRUCK KEYS ARE ONE KEY. Four keys wrapped this
            panel onto three lines and 51 px of a 267 px map band, and its
            bottom edge landed 10 px inside the "on screen" panel above it
            (measured, `truck-stage3-390.mjs`). Both swatches, one noun: the
            ring's own sentence is on the hover card, where somebody asking
            about that particular mark will read it. */}
        {anyTrucks && (
          <b title="Available truck space. Always this size — area on this map means freight, and a truck's free space is in words on its label, never in its area. A ring is a truck whose post never said where it is headed: nothing to point at.">
            <i className="truck" />
            {compact && hasUndirectedTruck ? <i className="truck-ring" /> : null}
            {compact ? " trucks" : " truck space"}
          </b>
        )}
        {/* Earned separately, and only when one is on screen: a truck that
            never said where it is going has nothing to point at. */}
        {!compact && anyTrucks && hasUndirectedTruck && (
          <b title="A truck whose post never said where it is headed. Drawn as a ring because there is nothing to point at — not aimed at a guess.">
            <i className="truck-ring" /> no destination
          </b>
        )}
        {/* The road route earns a row only while a listing is open: a legend
            line that appeared and vanished with the selection would resize this
            panel -- which the label placer treats as occupied ground -- and
            set every pill on the map jumping. It is stable because opening a
            job or a truck is deliberate, unlike a hover. */}
        {open != null && (
          <b>
            <i className="road" /> road route
          </b>
        )}
        {/* The open truck's own swing, in the number the driver set. Same
            reason the viewer's corridor earns a row: a band with no width on it
            is a shape rather than a claim. */}
        {truckCorridor && (
          <b
            title={
              `Jobs whose pickup stands within ${truckCorridor.miles} miles of this truck's line.` +
              " The driver set that width themselves; jobs outside it are dimmed."
            }
          >
            <i
              style={{
                width: 18,
                height: 9,
                borderRadius: 2,
                border: "1px solid var(--truck)",
                background: "var(--truck)",
                opacity: 0.32,
                boxShadow: "none",
              }}
            />{" "}
            {compact ? `±${truckCorridor.miles} mi` : `±${truckCorridor.miles} mi swing`}
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
            {/* Three keys will not fit on one line at 390 px, and a legend
                that wraps to two lines on a map band 261 px tall is taking a
                tenth of the phone to explain itself. The words the swatch can
                carry alone are the ones that go. */}
            {compact ? `±${corridor.miles} mi` : `±${corridor.miles} mi of your route`}
          </b>
        )}
      </div>
      )}
    </div>
  );
}

/* ------------------------------ the hover card ----------------------------
 *
 * Two builders, one card, and they never speak to each other. A place holding
 * both populations gets the job's lines and then the truck's lines, in that
 * order, with no arithmetic between them: a hover card is exactly where
 * "4 jobs · 2,550 cf" and "1 truck · 800 cf free" would be tempting to merge
 * into a single reassuring number, and there is no number that is both.
 */

/**
 * The shape rather than the type, so a MARKER and one real position inside a
 * fanned-out marker are described by the same sentence -- which is the same
 * reason `groupSummary` takes a shape.
 */
interface MarkerTally {
  label: string;
  ids: number[];
  cf: number;
  unsized: number;
  approx: boolean;
}

interface HoveredJob {
  group: MarkerTally;
  single: PublicLoadRow | null;
}

interface HoveredTruck {
  group: MarkerTally;
  single: PublicTruckRow | null;
  facts: TruckGroupFacts | undefined;
}

function line(box: HTMLElement, className: string, text: string): void {
  if (!text) return;
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  box.append(el);
}

function appendJobLines(box: HTMLElement, hit: HoveredJob): void {
  const { group, single } = hit;
  if (single) {
    // `jobSummary` leads with "Kearny, NJ → FL 34957" and joins the rest with
    // the same separator; a place label never contains one, so the first piece
    // is the lane and everything after it is the detail. Two lines for one job,
    // because a single 90-character sentence is not a card, it is a ticker.
    const text = jobSummary(single);
    const cut = text.indexOf(" · ");
    line(box, "t", cut < 0 ? text : text.slice(0, cut));
    if (cut >= 0) line(box, "s", text.slice(cut + 3));
  } else {
    // "Rochester, MN · 11 jobs · 6,006 cf" is already the whole answer for a
    // place, and it is the tally the marker's size is drawn from.
    line(box, "t", groupSummary(group));
  }

  // Why this job is in a corridor search at all, in the two numbers the API
  // already computed and nothing rendered: how far off the route its pickup
  // stands, and what taking it adds to the drive. Only for a single job -- a
  // place holding eleven of them has eleven different answers, and one of them
  // printed as if it were the place's is exactly the kind of tidy half-truth
  // this map keeps refusing to tell.
  if (single) {
    const parts: string[] = [];
    const off = single.off_route_miles;
    const detour = single.detour_miles;
    // Both numbers arrive already rounded, so a zero is "under half a mile" and
    // not "exactly none" -- said in words, because "0 mi off your route" reads
    // as a measurement precise to the foot.
    if (off != null) {
      parts.push(off === 0 ? "on your route" : `${off.toLocaleString("en-US")} mi off your route`);
    }
    if (detour != null) {
      parts.push(detour === 0 ? "no extra driving" : `+${detour.toLocaleString("en-US")} mi of driving`);
    }
    if (parts.length) line(box, "s", parts.join(" · "));
  }

  // The soft dots do not wear their caveat; this is where it is worn.
  if (group.approx) {
    line(
      box,
      "q",
      group.ids.length === 1
        ? "Approximate location — no street address posted"
        : "Approximate locations — no street address posted",
    );
  }
}

function appendTruckLines(
  box: HTMLElement,
  hit: HoveredTruck,
  todayIso: string,
  placeAlreadyNamed = false,
): void {
  const { group, single, facts } = hit;
  const summary = truckGroupSummary(group, facts);
  line(
    box,
    "tk",
    placeAlreadyNamed && summary.startsWith(`${group.label} · `)
      ? summary.slice(group.label.length + 3)
      : summary,
  );

  if (single) {
    const dest = truckPlaceLabel(single, "dest");
    const depart = departureLabel(single, todayIso);
    // Every unknown printed as the unknown it is. NOT "0 cf", not today, not a
    // compass direction: a driver reading this line is reading a promise, and a
    // post that did not make one has not made one.
    line(
      box,
      "s",
      [dest.stated ? `→ ${dest.text}` : NO_DESTINATION_STATED, depart.text].join(" · "),
    );
  } else if (facts) {
    const parts: string[] = [];
    if (facts.destinations > 0) {
      parts.push(`${facts.destinations} destination${facts.destinations === 1 ? "" : "s"}`);
    }
    if (facts.noDestination > 0) {
      parts.push(
        facts.noDestination === 1
          ? `1 with ${NO_DESTINATION_STATED.toLowerCase()}`
          : `${facts.noDestination} with no stated destination`,
      );
    }
    if (parts.length) line(box, "s", parts.join(" · "));
  }

  if (group.approx) {
    line(box, "q", "Approximate location — the post named no more than a state");
  }
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
