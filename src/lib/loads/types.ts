/**
 * Row and search shapes for the job board.
 *
 * The table is still called `loads` and the identifiers still say Load, but the
 * user-facing word is "job" -- hence `export type Job = LoadRow`. Nothing here
 * imports the database; these types cross the wire and are safe in a client
 * component.
 */
export type LoadStatus = "available" | "delisted" | "pending" | "taken" | "expired" | "cancelled";
/**
 * Which end of a lane the map plots. Not a search parameter -- it changes
 * nothing about which jobs match -- but it travels in the URL beside them, so
 * it lives with the shapes rather than inside a component.
 */
export type MapEnd = "pickup" | "delivery";
export type StatusSource = "derived" | "manual";
export type ReadySource = "line" | "header" | "footer" | "title" | "assumed";
export type ContactMode = "public" | "dm";

export interface LoadRow {
  id: number;
  status: LoadStatus;
  status_source: StatusSource;

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

  /** The job itself. */
  cubic_feet: number | null;
  price_per_cf: number | null;
  price_flat: number | null;
  /** COALESCE(price_flat, price_per_cf * cubic_feet); null when neither is known. */
  rate_usd: number | null;
  ready_now: boolean;
  ready_date: string | null;            // ISO date
  ready_source: ReadySource | null;
  deliver_by: string | null;            // ISO date
  tags: string[];
  flags: string[];
  job_notes: string | null;
  line_text: string | null;
  requirements: string | null;

  /** Sender + freshness. */
  /** "phone:<E.164>" embeds the author's phone: always null on the public wire (B's PublicLoadRow adds is_web instead); present only server-side and in admin/test-console payloads. */
  sender_key: string | null;
  job_key: string | null;
  ordinal: number;
  /** Public wire: passed through redactPhones -- null when the name is itself a phone (WhatsApp's fallback for unknown contacts). */
  contact_name: string | null;
  /** Always null on the public wire (B's PublicLoadRow); present only server-side and in admin/test-console payloads. */
  contact_phone: string | null;
  contact_mode: ContactMode;
  first_seen_at: string | null;
  last_seen_at: string | null;
  seen_count: number;
  relist_count: number;
  delisted_at: string | null;
  snapshot_message_id: number | null;

  confidence: number;
  needs_review: boolean;
  dup_group_id: string | null;
  is_canonical: boolean;
  dup_count: number;

  /**
   * Published from a demo account, and therefore visible only to the account
   * that posted it (see `LoadAudience` and db/schema.sql). Anonymous callers
   * and other accounts never receive a row where this is true, so on their wire
   * it is always false -- it is here so the poster's own copy can say so.
   */
  is_demo: boolean;

  group_name: string | null;
  source_message_id: number | null;
  posted_by: number | null;
  created_at: string;
  expires_at: string | null;

  /** Legacy, nullable, never written by the batch path. */
  pickup_date: string | null;           // = ready_date
  pickup_time: string | null;
  pickup_time_note: string | null;
  delivery_date: string | null;
  weight_lbs: number | null;
  pieces: number | null;
  notes: string | null;

  /** Populated when the search supplied a reference point. */
  distance_miles?: number | null;
  /** Corridor searches only. */
  off_route_miles?: number | null;
  detour_miles?: number | null;
  route_progress?: number | null;
}
export type Job = LoadRow;

export type SortKey =
  | "newest"
  | "last_seen"
  | "ready"
  | "distance"
  | "trip_miles"
  | "rate"
  | "cf"
  | "deliver_by";

export interface GeoPoint {
  lat: number;
  lng: number;
  label?: string;
  /**
   * How precisely the place resolved. Carried through to the UI so a whole-state
   * destination can be drawn as such instead of masquerading as a pinpoint.
   */
  precision?: string | null;
}

export interface BoundsInput {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface LoadSearchParams {
  pickupStates?: string[];
  pickupCity?: string | null;
  pickupZip?: string | null;

  deliveryStates?: string[];
  deliveryCity?: string | null;
  deliveryZip?: string | null;

  /** Radius search around the pickup point (engine kept; UI may not expose it). */
  origin?: GeoPoint | null;
  radiusMiles?: number | null;
  destination?: GeoPoint | null;
  destRadiusMiles?: number | null;
  routeMode?: "endpoints" | "corridor";
  corridorMiles?: number | null;
  bounds?: BoundsInput | null;

  /** Size. */
  minCf?: number | null;
  maxCf?: number | null;
  /** default true: jobs with no cubic_feet pass the size filter */
  includeUnsized?: boolean;

  /** Readiness / deadline. */
  readyOnly?: boolean;                  // (ready_now OR ready_date <= CURRENT_DATE)
  readyBy?: string | null;              // ISO date: (ready_now OR ready_date <= $d)
  deliverBy?: string | null;            // ISO date: (deliver_by IS NULL OR deliver_by <= $d)

  /** Freshness: last_seen_at > now() - N days (1..30). */
  seenDays?: number | null;

  hasPrice?: boolean;                   // (price_per_cf IS NOT NULL OR price_flat IS NOT NULL)
  statuses?: LoadStatus[];
  senderKey?: string | null;
  q?: string | null;

  includeDuplicates?: boolean;
  needsReviewOnly?: boolean;

  /** Reference point for the "distance from you" column. */
  viewer?: GeoPoint | null;

  sort?: SortKey;
  limit?: number;
  offset?: number;
}

/**
 * Who is asking -- the one thing that decides whether a demo-posted row exists.
 *
 * Deliberately NOT part of `LoadSearchParams`. That shape is built by
 * `parseSearchParams` out of a URL, and anything in it can be typed by the
 * caller; an audience that could arrive in a query string would be no gate at
 * all. It travels as a separate argument to `searchLoads` / `getLoad` instead,
 * where the only thing that can produce one is a route reading the session
 * cookie.
 *
 * Omitting it entirely means "anonymous", which is the strictest answer: a
 * caller who forgets this parameter sees fewer rows, never more.
 */
export interface LoadAudience {
  /** `users.id` of the signed-in caller; null for a visitor with no session. */
  userId: number | null;
  /**
   * A REAL admin (`isAdminActor`, never a demo one) asked to see demo listings
   * as well -- `GET /api/loads?demo=1`. Off by default so the counts an admin
   * reads on the board describe the real corpus.
   */
  includeDemo?: boolean;
}

export interface LoadSummary {
  count: number;                 // rows matching the full WHERE (not the page)
  totalCf: number;               // sum(cubic_feet)
  withCf: number;                // rows with cubic_feet
  readyNow: number;              // rows where ready_now OR ready_date <= CURRENT_DATE
  freshToday: number;            // rows where last_seen_at > now() - 24h
  priced: number;                // rows with price_per_cf or price_flat
  medianPricePerCf: number | null;
}

export interface LoadSearchResult {
  rows: LoadRow[];
  total: number;
  summary: LoadSummary;
  /** Echo of how the search was actually interpreted, for the UI to display. */
  applied: {
    origin?: GeoPoint | null;
    destination?: GeoPoint | null;
    radiusMiles?: number | null;
    corridorMiles?: number | null;
    routeMode?: "endpoints" | "corridor";
    readyBy?: string | null;
    deliverBy?: string | null;
    truncated?: boolean;
  };
}
