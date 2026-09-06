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
  /** group key for a job id, so hover and selection can sync both ways. */
  keyByJob: Map<number, string>;
  /** How many jobs could be placed at all; the rest are counted out loud. */
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
 * Jobs -> markers.
 *
 * Grouped on three decimal places (~110 m): five decimals would split a city
 * from its own ZIP centroid into two dots sitting on each other, which is the
 * pile this view exists to remove.
 */
export function buildGroups(jobs: PublicLoadRow[], end: MapEnd): BuiltPoints {
  const byKey = new Map<string, PointGroup>();
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
    byKey,
    features: { type: "FeatureCollection", features },
    keyByJob,
    plotted,
  };
}

/** "Rochester, MN · 11 jobs · 6,006 cf" */
export function groupSummary(g: PointGroup): string {
  const jobs = `${g.ids.length} job${g.ids.length === 1 ? "" : "s"}`;
  const size = g.cf > 0 ? formatCf(g.cf) : "size not stated";
  const unsized = g.unsized > 0 && g.cf > 0 ? ` (${g.unsized} without a size)` : "";
  return `${g.label} · ${jobs} · ${size}${unsized}`;
}

/** "12,15,19" -> [12, 15, 19]; anything else -> []. */
export function idsOf(raw: unknown): number[] {
  if (typeof raw !== "string" || !raw) return [];
  return raw
    .split(",")
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
}
