/**
 * What the board's map plots: one marker per PLACE, not one per job.
 *
 * This replaces `arc.ts`, which fanned a curve out of every job. Arcs were
 * right when the board held a dozen jobs and wrong the moment it held a
 * hundred, and the reason is in the data rather than in the drawing: real posts
 * are batch inventories, so one WhatsApp message is eleven jobs out of one
 * warehouse in Rochester and another is fifteen out of one yard in Los Angeles.
 * Plotting a dot per job puts eleven dots on one coordinate, which is the same
 * unreadable pile as the arcs in a different shape.
 *
 * So jobs are grouped by their rounded coordinate before anything is drawn, and
 * the marker carries the tally: "Rochester, MN · 11 jobs · 6,006 cf".
 *
 * Pure and client-safe: no map, no MapLibre, no DOM. `LoadMap` turns what comes
 * out of here into layers.
 */

import type { Feature, FeatureCollection, Point as GeoPoint } from "geojson";
import type { PublicLoadRow } from "@/lib/loads/publicView";
import type { MapEnd } from "@/lib/loads/types";
import { STATE_BY_ABBR } from "@/lib/geo/states";
import { formatCf, placeLabel } from "@/lib/loads/present";
// Type-only, so the projection helpers in ./marks can go on importing
// `endPoint` and `endLabelText` from here without a runtime cycle.
import type { MapMark } from "./marks";

/**
 * One real position inside a marker: every job whose end resolved to the SAME
 * coordinate, not merely to a coordinate within the marker's rounding.
 *
 * The distinction is the whole of it. Eleven jobs out of one Rochester
 * warehouse resolve to one city centroid and are one spot; two different ZIPs
 * eighty metres apart are two spots that happen to round into one marker. The
 * first cannot be pulled apart without inventing eleven positions; the second
 * can, because both positions are real.
 */
export interface PointSpot {
  /** Full-precision "lng,lat"; unique within its group. */
  key: string;
  lng: number;
  lat: number;
  ids: number[];
  cf: number;
  unsized: number;
  label: string;
  approx: boolean;
  /** Coarsest precision any member here carries; caps how far a click may zoom. */
  precision: string | null;
}

/** One drawn marker: every job whose selected end sits on the same spot. */
export interface PointGroup {
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
  /** Every member of this group is a state-centroid guess, not a real address. */
  approx: boolean;
  /**
   * The distinct real coordinates under this marker, biggest first.
   *
   * Length 1 means the jobs genuinely share one position. Length > 1 means the
   * rounding put separate places on one dot, and they can honestly be fanned
   * apart. Nothing else on the map needs to ask which case it is.
   */
  spots: PointSpot[];
  /** Coarsest precision under this marker; caps how far a click may zoom. */
  precision: string | null;
}

/** The group, flattened onto a GeoJSON feature MapLibre can style. */
export interface PointProps {
  key: string;
  label: string;
  count: number;
  cf: number;
  unsized: number;
  approx: boolean;
  /** Comma-joined ids: feature properties survive round trips best flat. */
  ids: string;
}

export interface BuiltPoints {
  groups: PointGroup[];
  byKey: Map<string, PointGroup>;
  features: FeatureCollection<GeoPoint, PointProps>;
  /**
   * Group key for a mark's id, so hover and selection can sync both ways.
   *
   * Ids are unique within one population, which is the other reason
   * `buildGroups` is called once per kind: job 12 and truck 12 in one map would
   * be one entry here.
   */
  keyById: Map<number, string>;
  /** How many marks were placed; what could not be placed is counted out loud. */
  plotted: number;
}

/**
 * Where a job's chosen end goes: its own coordinate, or its state's centroid.
 *
 * The centroid fallback is flagged approximate and drawn as such. It exists
 * because a post that says "delivering to FL" is real inventory a driver may
 * want, and hiding it would make the board quietly incomplete.
 */
export function endPoint(
  job: PublicLoadRow,
  end: MapEnd,
): { lng: number; lat: number; approx: boolean; precision: string | null } | null {
  const lat = end === "pickup" ? job.pickup_lat : job.delivery_lat;
  const lng = end === "pickup" ? job.pickup_lng : job.delivery_lng;
  const precision = end === "pickup" ? job.pickup_precision : job.delivery_precision;
  if (lat != null && lng != null) {
    return { lng, lat, approx: precision === "state" || precision === "region", precision };
  }
  const st = end === "pickup" ? job.pickup_state : job.delivery_state;
  const info = st ? STATE_BY_ABBR.get(st) : null;
  // A state centroid stood in for a coordinate nobody geocoded: the row's own
  // precision column has nothing to do with where this dot ended up.
  return info ? { lng: info.lng, lat: info.lat, approx: true, precision: "state" } : null;
}

/* ------------------------------ how far in --------------------------------
 *
 * How far a click may zoom, by the precision the row actually carries.
 *
 * A city centroid drawn at street zoom is a lie told by a camera: the dot has
 * not moved, but the frame around it now says "this building", and the CTO hit
 * exactly that -- clicking a Rochester marker known only to city precision
 * flew the map down to driveways. The stops are the size of the thing the
 * coordinate stands for, so the frame never claims more than the datum:
 *
 *   address  z15   a street
 *   zip      z12   ~20 km across -- a postcode's own spread
 *   city     z10.5 ~60 km across -- the town and its outskirts
 *   region   z7
 *   state    z5.5  the state fills the frame, which is all we know
 *
 * Unknown precision is treated as a city: it is the coarsest thing the
 * geocoder writes for a placed point, so guessing finer is the one direction
 * that could mislead.
 */
export const ZOOM_BY_PRECISION: Record<string, number> = {
  address: 15,
  zip: 12,
  city: 10.5,
  region: 7,
  state: 5.5,
};

/** Precision unknown: assume the coarsest thing a placed point is ever written at. */
export const UNKNOWN_MAX_ZOOM = ZOOM_BY_PRECISION.city!;

/** The furthest in a point of this precision may honestly be framed. */
export function maxZoomFor(precision: string | null | undefined): number {
  return (precision ? ZOOM_BY_PRECISION[precision] : undefined) ?? UNKNOWN_MAX_ZOOM;
}

/** The tightest cap over a set of precisions -- the coarsest datum wins. */
export function maxZoomOver(precisions: Array<string | null | undefined>): number {
  let cap = Infinity;
  for (const p of precisions) cap = Math.min(cap, maxZoomFor(p));
  return Number.isFinite(cap) ? cap : UNKNOWN_MAX_ZOOM;
}

/** Coarser of two precisions, by the same ladder the zoom caps use. */
function coarser(a: string | null, b: string | null): string | null {
  return maxZoomFor(a) <= maxZoomFor(b) ? a : b;
}

/**
 * "Rochester, MN" -- the place, not the post's raw wording.
 *
 * A marker stands for a coordinate, and every job at that coordinate resolved
 * to the same city, so the city is the honest name for it. The post's own
 * wording ("NJ 07032") stays on the job's card, where it belongs.
 */
export function endLabelText(job: PublicLoadRow, end: MapEnd): string {
  const city = end === "pickup" ? job.pickup_city : job.delivery_city;
  const state = end === "pickup" ? job.pickup_state : job.delivery_state;
  if (city && state) return `${city}, ${state}`;
  if (city) return city;
  return placeLabel(job, end).text;
}

/**
 * Marks -> markers.
 *
 * Grouped on three decimal places (~110 m): five decimals would split a city
 * from its own ZIP centroid into two dots sitting on each other, which is the
 * pile this view exists to remove.
 *
 * Takes marks rather than jobs so the truck source can be built by the same
 * code -- `jobMarks(rows, end)` and, later, `truckMarks(rows, end)` in
 * `./marks` do the projecting. Call it ONCE PER POPULATION and never over a
 * mixed array: `cf` is freight on a job and free space on a truck, and a
 * marker holding both would carry one number where there are two.
 */
export function buildGroups(marks: MapMark[]): BuiltPoints {
  const byKey = new Map<string, PointGroup>();
  const spotsByKey = new Map<string, Map<string, PointSpot>>();
  const keyById = new Map<number, string>();
  let plotted = 0;

  for (const mark of marks) {
    plotted += 1;

    const key = `${mark.lng.toFixed(3)},${mark.lat.toFixed(3)}`;
    keyById.set(mark.id, key);

    /* Five decimals -- about a metre. Finer than that is not a distinction any
     * geocoder is making, and two rows differing in the ninth decimal are one
     * place with a floating-point history, not two addresses. */
    const spotKey = `${mark.lng.toFixed(5)},${mark.lat.toFixed(5)}`;
    let spots = spotsByKey.get(key);
    if (!spots) {
      spots = new Map();
      spotsByKey.set(key, spots);
    }
    const spot = spots.get(spotKey);
    if (spot) {
      spot.ids.push(mark.id);
      spot.cf += mark.cf ?? 0;
      if (mark.cf == null) spot.unsized += 1;
      spot.approx &&= mark.approx;
      spot.precision = coarser(spot.precision, mark.precision);
    } else {
      spots.set(spotKey, {
        key: spotKey,
        lng: mark.lng,
        lat: mark.lat,
        ids: [mark.id],
        cf: mark.cf ?? 0,
        unsized: mark.cf == null ? 1 : 0,
        label: mark.label,
        approx: mark.approx,
        precision: mark.precision,
      });
    }

    const existing = byKey.get(key);
    if (existing) {
      existing.ids.push(mark.id);
      existing.cf += mark.cf ?? 0;
      if (mark.cf == null) existing.unsized += 1;
      // Only a group where EVERY member is a guess is drawn as one.
      existing.approx &&= mark.approx;
      existing.precision = coarser(existing.precision, mark.precision);
      continue;
    }

    byKey.set(key, {
      key,
      lng: mark.lng,
      lat: mark.lat,
      ids: [mark.id],
      cf: mark.cf ?? 0,
      unsized: mark.cf == null ? 1 : 0,
      label: mark.label,
      state: mark.state,
      approx: mark.approx,
      spots: [],
      precision: mark.precision,
    });
  }

  const groups = [...byKey.values()];
  for (const g of groups) {
    // Biggest pile first, then by key so the fan is laid out the same way on
    // every render rather than in whatever order the rows happened to arrive.
    g.spots = [...(spotsByKey.get(g.key)?.values() ?? [])].sort(
      (a, b) => b.cf - a.cf || b.ids.length - a.ids.length || a.key.localeCompare(b.key),
    );
  }
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
    byKey,
    features: { type: "FeatureCollection", features },
    keyById,
    plotted,
  };
}

/**
 * "Rochester, MN · 11 jobs · 6,006 cf"
 *
 * Takes the shape rather than the type, so a marker and one real position
 * inside a fanned-out marker are described by the same sentence.
 */
export function groupSummary(g: {
  label: string;
  ids: number[];
  cf: number;
  unsized: number;
}): string {
  const jobs = `${g.ids.length} job${g.ids.length === 1 ? "" : "s"}`;
  const size = g.cf > 0 ? formatCf(g.cf) : "size not stated";
  const unsized = g.unsized > 0 && g.cf > 0 ? ` (${g.unsized} without a size)` : "";
  return `${g.label} · ${jobs} · ${size}${unsized}`;
}

/* ------------------------------ marker size -------------------------------
 *
 * The radius lives here rather than only inside LoadMap's paint expression
 * because two things need the same number: the circle layer, and whatever has
 * to sit clear of the circle -- today the count badge, which used a fixed
 * 12 px offset and so was swallowed by any marker bigger than that.
 *
 * On the square root, so the AREA of the dot tracks the volume: a marker twice
 * the radius of another reads as four times the freight, which is what the eye
 * actually compares.
 */

/** `sqrt(cf)` -> radius in px at zoom 4, as [input, output] pairs. */
export const RADIUS_STOPS: Array<[number, number]> = [
  [0, 5],
  [20, 8],
  [45, 11],
  [80, 15],
  [120, 19],
];

/** Radius grows with zoom over this span, matching the layer's own curve. */
export const RADIUS_ZOOM: Array<[number, number]> = [
  [3, 0.85],
  [7, 1.25],
];

function lerpStops(stops: Array<[number, number]>, at: number): number {
  const first = stops[0]!;
  if (at <= first[0]) return first[1];
  for (let i = 1; i < stops.length; i++) {
    const [x1, y1] = stops[i]!;
    const [x0, y0] = stops[i - 1]!;
    if (at <= x1) return y0 + ((at - x0) / (x1 - x0)) * (y1 - y0);
  }
  return stops[stops.length - 1]![1];
}

/** The drawn radius of a group's marker, in CSS px, at a given zoom. */
export function pointRadius(cf: number, zoom: number): number {
  return lerpStops(RADIUS_STOPS, Math.sqrt(Math.max(0, cf))) * lerpStops(RADIUS_ZOOM, zoom);
}

/** "12,15,19" -> [12, 15, 19]; anything else -> []. */
export function idsOf(raw: unknown): number[] {
  if (typeof raw !== "string" || !raw) return [];
  return raw
    .split(",")
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
}
