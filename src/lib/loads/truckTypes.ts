/**
 * Row and search shapes for available truck space.
 *
 * A sibling of `./types.ts`, never an extension of it. The two files share the
 * geography helpers (`GeoPoint`, `BoundsInput`) and the question of who is
 * asking (`LoadAudience`), and share NOTHING that carries a quantity: a truck's
 * numbers are free space and a job's are freight, and a shape that let them mix
 * would make `summary.totalCf + summary.totalFreeCf` compile.
 *
 * Nothing here imports the database; these types cross the wire and are safe in
 * a client component.
 *
 * `contact_phone_raw` is deliberately ABSENT from `TruckRow`, exactly as it is
 * from `LoadRow`: the column exists in db/schema.sql and is kept out of the wire
 * shape and out of TRUCK_SELECT_COLUMNS so the number as it was typed can never
 * enter a response body. See npm run check:redact (R2), which asserts every
 * `trucks` column matching /phone/ is either absent from this interface or
 * nulled by `redactTruck`.
 */
import type { BoundsInput, GeoPoint, LoadAudience } from "./types";

export type TruckStatus = "available" | "booked" | "departed" | "expired" | "cancelled";
export type TruckVisibility = "public" | "pending" | "rejected" | "hidden";
export type FreeSource = "stated" | "empty_phrase" | "form";
export type AvailSource = "line" | "header" | "form";
export type TruckShape = "C1" | "C2" | "C3" | "C4" | "C5" | "form";
export type TruckSortKey = "depart" | "last_seen" | "newest" | "distance" | "free_cf" | "leg_miles";

/**
 * Who is asking. The same question the job board asks, so the same type: a
 * second definition would be a second place for "may this caller see this row?"
 * to drift. Omitting it means anonymous, which hides every demo-posted row --
 * forgetting it costs rows, never leaks them.
 *
 * This is NOT the same thing as `scope`. `scope` decides whether unreviewed
 * rows exist at all and is required and positional; the audience decides whose
 * demo scratch work is whose. Both predicates are ANDed in SQL.
 */
export type TruckAudience = LoadAudience;

export interface TruckRow {
  id: number;
  source_message_id: number | null;
  group_id: number | null;
  posted_by: number | null;
  sender_key: string | null;
  truck_key: string | null;

  status: TruckStatus;
  status_source: "derived" | "manual";
  visibility: TruckVisibility;

  origin_label: string;
  origin_city: string | null;
  origin_state: string | null;
  origin_zip: string | null;
  origin_lat: number;
  origin_lng: number;
  origin_precision: string | null;

  dest_label: string | null;
  dest_city: string | null;
  dest_state: string | null;
  dest_zip: string | null;
  dest_lat: number | null;
  dest_lng: number | null;
  dest_precision: string | null;

  leg_miles: number | null;
  road_miles: number | null;
  road_minutes: number | null;

  /** What is on offer. NEVER summed with a job's `cubic_feet`. */
  free_cf: number | null;
  truck_cf: number | null;
  free_source: FreeSource | null;
  /** The words, e.g. "26 ft box truck". Never converted into cubic feet. */
  truck_text: string | null;

  avail_now: boolean;
  avail_from: string | null; // ISO date
  avail_to: string | null; // ISO date
  avail_source: AvailSource | null;

  corridor_miles: number;

  has_dot_mc: boolean | null;
  has_hhg_authority: boolean | null;
  has_coi: boolean | null;
  equipment: string[];
  cannot: string[];
  equipment_notes: string | null;
  requirements: string | null;
  notes: string | null;

  /** Public wire: passed through redactPhones; null when the name is itself a phone. */
  contact_name: string | null;
  /** Always null on the public wire (PublicTruckRow); server-side and admin payloads only. */
  contact_phone: string | null;
  contact_mode: "public" | "dm";
  contact_phone_source: "post" | "sender" | null;

  line_text: string | null;
  supply_phrase: string | null;
  shape: TruckShape | null;
  confidence: number;
  needs_review: boolean;
  flags: string[];

  first_seen_at: string | null;
  last_seen_at: string | null;
  seen_count: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;

  /**
   * Posted from a demo account, and visible only to the account that posted it
   * (see `TruckAudience` and db/schema.sql). Anonymous callers and other
   * accounts never receive a row where this is true, so on their wire it is
   * always false -- it is here so the poster's own copy can say so.
   */
  is_demo: boolean;

  group_name?: string | null;
  /** Populated when the search supplied a reference point. */
  distance_miles?: number | null;
  /** Corridor searches only. */
  off_route_miles?: number | null;
  detour_miles?: number | null;
  route_progress?: number | null;
}

/**
 * Deliberately shares NO numeric field name with LoadSummary.
 *
 * `boardHeadline(jobs, trucks)` returns two strings because these two shapes
 * cannot be added: there is no `totalCf` here and no `totalFreeCf` there, so a
 * combined figure has to be typed by someone who meant it. npm run check:sums
 * (stage 2) asserts no source line mentions both.
 */
export interface TruckSummary {
  count: number;
  /** Sum over trucks that STATED a free size -- never "totalCf". */
  totalFreeCf: number;
  withFreeCf: number;
  departingToday: number;
  noDestination: number;
  freshToday: number;
  medianCorridorMiles: number | null;
}

/**
 * There is NO `visibility` field here and no `visibility` key in
 * `parseTruckSearchParams`. Public visibility is pinned inside `searchTrucks`
 * by its required `scope` argument; a field on this shape would be a filter
 * axis parsed out of a URL, which is exactly what sank the one-table design.
 */
export interface TruckSearchParams {
  originStates?: string[];
  originCity?: string | null;
  originZip?: string | null;
  destStates?: string[];
  destCity?: string | null;
  destZip?: string | null;

  origin?: GeoPoint | null;
  radiusMiles?: number | null;
  destination?: GeoPoint | null;
  destRadiusMiles?: number | null;
  routeMode?: "endpoints" | "corridor";
  corridorMiles?: number | null;
  bounds?: BoundsInput | null;

  /** Free space, NOT freight volume: a separate control from the job board's minCf/maxCf. */
  minFreeCf?: number | null;
  maxFreeCf?: number | null;
  /** default true: a truck that never stated its free space passes the size filter */
  includeUnsized?: boolean;

  /** ISO date. The truck control; `readyBy`/`deliverBy` are job words and are refused. */
  departsBy?: string | null;
  /** true = only trucks whose post did not say where they are headed */
  noDestOnly?: boolean | null;
  seenDays?: number | null;

  /** default ['available'] */
  statuses?: TruckStatus[];
  /** ADMIN ONLY, stripped by the route */
  senderKey?: string | null;
  /** ADMIN ONLY, stripped by the route */
  needsReviewOnly?: boolean;
  q?: string | null;

  viewer?: GeoPoint | null;

  sort?: TruckSortKey;
  limit?: number;
  offset?: number;
}

export interface TruckSearchResult {
  rows: TruckRow[];
  total: number;
  summary: TruckSummary;
  /** Mirrors LoadSearchResult.applied, with the truck's own date word. */
  applied: {
    origin?: GeoPoint | null;
    destination?: GeoPoint | null;
    radiusMiles?: number | null;
    corridorMiles?: number | null;
    routeMode?: "endpoints" | "corridor";
    departsBy?: string | null;
    truncated?: boolean;
    /**
     * Corridor mode only: how many otherwise-matching trucks were dropped for
     * having no stated destination. Never silently ignored -- the Trucks tab
     * prints it (SPEC §15.2), because a filter that quietly removes rows a
     * driver can see on the map is the deliver-by lesson from wave 1.
     */
    noDestExcluded?: number;
  };
}
