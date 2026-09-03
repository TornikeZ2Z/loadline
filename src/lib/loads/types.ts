export type LoadStatus = "available" | "pending" | "taken" | "expired" | "cancelled";

export interface LoadRow {
  id: number;
  status: LoadStatus;

  pickup_label: string;
  pickup_city: string | null;
  pickup_state: string | null;
  pickup_zip: string | null;
  pickup_lat: number | null;
  pickup_lng: number | null;
  pickup_precision: string | null;

  delivery_label: string;
  delivery_city: string | null;
  delivery_state: string | null;
  delivery_zip: string | null;
  delivery_lat: number | null;
  delivery_lng: number | null;
  delivery_precision: string | null;

  trip_miles: number | null;
  pickup_date: string | null;
  pickup_time: string | null;
  pickup_time_note: string | null;
  delivery_date: string | null;

  load_type: string | null;
  weight_lbs: number | null;
  pallets: number | null;
  pieces: number | null;
  rate_usd: number | null;

  contact_name: string | null;
  contact_phone: string | null;
  notes: string | null;

  confidence: number;
  needs_review: boolean;
  dup_group_id: string | null;
  is_canonical: boolean;
  dup_count: number;

  group_name: string | null;
  source_message_id: number | null;
  created_at: string;
  expires_at: string | null;

  /** Populated when the search supplied a reference point. */
  distance_miles?: number | null;
  /** Corridor searches only: perpendicular distance from the driver's route. */
  off_route_miles?: number | null;
  /** Corridor searches only: extra miles versus driving straight through. */
  detour_miles?: number | null;
  /** Corridor searches only: 0..1 progress along the route. */
  route_progress?: number | null;
}

export type DatePreset = "any" | "today" | "tomorrow" | "week" | "next3" | "custom";
export type SortKey = "newest" | "pickup_date" | "distance" | "trip_miles" | "rate";

export interface GeoPoint {
  lat: number;
  lng: number;
  label?: string;
}

export interface BoundsInput {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface LoadSearchParams {
  datePreset?: DatePreset;
  dateFrom?: string | null;
  dateTo?: string | null;

  pickupStates?: string[];
  pickupCity?: string | null;
  pickupZip?: string | null;

  deliveryStates?: string[];
  deliveryCity?: string | null;
  deliveryZip?: string | null;

  /** Radius search around the pickup point. */
  origin?: GeoPoint | null;
  radiusMiles?: number | null;

  /** Radius search around the delivery point. */
  destination?: GeoPoint | null;
  destRadiusMiles?: number | null;

  /**
   * With both origin and destination set, "corridor" finds loads along the way
   * instead of requiring both endpoints to match their own radius.
   */
  routeMode?: "endpoints" | "corridor";
  corridorMiles?: number | null;

  /** Map viewport ("search this area"). */
  bounds?: BoundsInput | null;

  statuses?: LoadStatus[];
  loadTypes?: string[];
  minWeight?: number | null;
  maxWeight?: number | null;
  q?: string | null;

  includeDuplicates?: boolean;
  needsReviewOnly?: boolean;

  /** Reference point for the "distance from you" column. */
  viewer?: GeoPoint | null;

  sort?: SortKey;
  limit?: number;
  offset?: number;
}

export interface LoadSearchResult {
  rows: LoadRow[];
  total: number;
  /** Echo of how the search was actually interpreted, for the UI to display. */
  applied: {
    origin?: GeoPoint | null;
    destination?: GeoPoint | null;
    radiusMiles?: number | null;
    corridorMiles?: number | null;
    routeMode?: "endpoints" | "corridor";
    dateFrom?: string | null;
    dateTo?: string | null;
    truncated?: boolean;
  };
}
