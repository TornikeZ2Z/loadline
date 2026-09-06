/**
 * Jobs posted through the website rather than scraped out of WhatsApp.
 *
 * A website post has no sender snapshot, so supersession never touches it: it
 * lives until its own `expires_at` or until the poster marks it Taken.
 * Ownership is `posted_by`, which is also what B's PATCH /status gate checks --
 * `sender_key` stays NULL, and the public row reports that as `is_web`.
 */
import { query, queryOne } from "@/lib/db";
import { computeExpiry } from "@/lib/extract/dates";
import { normalizePhone } from "@/lib/extract/phone";
import { geocode, geocodeDestination } from "@/lib/geo/geocode";
import { haversineMiles } from "@/lib/geo/math";

export interface WebJobBody {
  pickup: string;                                   // required label as typed or picked
  pickupLat?: string;
  pickupLng?: string;
  pickupState?: string;
  pickupZip?: string;
  pickupPrecision?: string;                         // how exact the picked place is
  deliveryState: string;                            // required 2-letter
  deliveryZip?: string;                             // 5 digits
  deliveryCity?: string;                            // one of deliveryZip / deliveryCity required
  cubicFeet: string;                                // 10..5000
  priceMode?: "percf" | "flat" | "";
  pricePerCf?: string;
  priceFlat?: string;
  readyNow?: "on" | "";
  readyDate?: string;                               // YYYY-MM-DD
  deliverBy?: string;                               // YYYY-MM-DD
  tags?: string;                                    // comma list, filtered to the TAG vocabulary
  requirements?: string;
  contactName?: string;                             // default user.name
  contactPhone?: string;                            // default user.phone; required after defaulting
  notes?: string;                                   // → job_notes
}

export class WebJobValidationError extends Error {
  constructor(
    public field: keyof WebJobBody,
    message: string,
  ) {
    super(message);
    this.name = "WebJobValidationError";
  }
}

/**
 * The tag vocabulary. Anything else a poster types is dropped rather than
 * invented as a new tag -- the filter chips and the tag labels are a closed
 * set, and a one-off "grandfather_clock" would render as a raw identifier.
 */
const TAGS = new Set([
  "bulky",
  "urgent",
  "hot_tub",
  "piano",
  "safe",
  "stairs",
  "elevator",
  "no_elevator",
  "shuttle",
  "long_carry",
  "packing",
  "partial",
  "full",
  "fragile",
  "motorcycle",
  "pool_table",
  "treadmill",
  "storage",
  "cod",
  "ground_floor",
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function insertWebJob(
  user: { id: number; name: string; phone: string | null },
  body: WebJobBody,
): Promise<{ id: number }> {
  const now = new Date();

  // --- pickup ---------------------------------------------------------------
  const pickupLabel = (body.pickup ?? "").trim();
  if (!pickupLabel) throw new WebJobValidationError("pickup", "required");

  const pickupLat = numberOrNull(body.pickupLat);
  const pickupLng = numberOrNull(body.pickupLng);
  let pickup: {
    lat: number;
    lng: number;
    city: string | null;
    state: string | null;
    zip: string | null;
    precision: string;
  } | null = null;

  if (pickupLat != null && pickupLng != null) {
    // The poster picked a suggestion, so we already have exactly what the
    // geocoder would have returned -- no second lookup, no chance of drifting
    // to a different "Springfield".
    const zip = fiveDigits(body.pickupZip);
    pickup = {
      lat: pickupLat,
      lng: pickupLng,
      city: null,
      state: twoLetter(body.pickupState),
      zip,
      // The suggestion carries its own precision: "Florida -- anywhere in the
      // state" and "north jersey" are centroids, and calling them a city would
      // draw a pinned point and drop the "approximate" note. Only a post from a
      // client that sends no precision falls back to the shape of the fields.
      precision: precisionOrNull(body.pickupPrecision) ?? (zip ? "zip" : "city"),
    };
  } else {
    const hit = await geocode(pickupLabel);
    if (!hit) throw new WebJobValidationError("pickup", "could not be found on the map");
    pickup = {
      lat: hit.lat,
      lng: hit.lng,
      city: hit.city,
      state: hit.state,
      zip: hit.zip,
      precision: hit.precision,
    };
  }

  // --- delivery -------------------------------------------------------------
  const deliveryState = twoLetter(body.deliveryState);
  if (!deliveryState) throw new WebJobValidationError("deliveryState", "required");

  const deliveryZip = fiveDigits(body.deliveryZip);
  if (body.deliveryZip && !deliveryZip) {
    throw new WebJobValidationError("deliveryZip", "must be five digits");
  }
  const deliveryCity = (body.deliveryCity ?? "").trim() || null;
  if (!deliveryZip && !deliveryCity) {
    throw new WebJobValidationError("deliveryZip", "a delivery ZIP or city is required");
  }

  const deliveryLabel =
    (deliveryCity ? `${titleCase(deliveryCity)}, ` : "") +
    deliveryState +
    (deliveryZip ? ` ${deliveryZip}` : "");

  // The structured geocoder: cached ZIP points, gazetteer cities, HERE when
  // configured, and an honest state-centroid fallback for a ZIP nobody can place.
  const delivery = await geocodeDestination({ state: deliveryState, zip: deliveryZip, city: deliveryCity });

  // --- size and price -------------------------------------------------------
  const cubicFeet = Math.round(numberOrNull(body.cubicFeet) ?? NaN);
  if (!Number.isFinite(cubicFeet)) throw new WebJobValidationError("cubicFeet", "required");
  if (cubicFeet < 10 || cubicFeet > 5000) {
    throw new WebJobValidationError("cubicFeet", "must be between 10 and 5000");
  }

  let pricePerCf: number | null = null;
  let priceFlat: number | null = null;
  if (body.priceMode === "percf") {
    pricePerCf = numberOrNull(body.pricePerCf);
    if (pricePerCf == null || pricePerCf <= 0) {
      throw new WebJobValidationError("pricePerCf", "must be a price per cubic foot");
    }
  } else if (body.priceMode === "flat") {
    priceFlat = numberOrNull(body.priceFlat);
    if (priceFlat == null || priceFlat <= 0) {
      throw new WebJobValidationError("priceFlat", "must be a total price");
    }
  }
  const rateUsd = priceFlat ?? (pricePerCf != null ? pricePerCf * cubicFeet : null);

  // --- readiness ------------------------------------------------------------
  const readyDate = optionalIsoDate(body.readyDate, "readyDate");
  const deliverBy = optionalIsoDate(body.deliverBy, "deliverBy");
  const readyNow = body.readyNow === "on" || !readyDate;
  const readySource = body.readyNow === "on" || readyDate ? "line" : "assumed";

  // --- contact --------------------------------------------------------------
  const contactName = (body.contactName ?? "").trim() || user.name;
  const rawPhone = (body.contactPhone ?? "").trim() || user.phone || "";
  const phone = normalizePhone(rawPhone);
  const contactPhone = phone.e164 ?? phone.display;
  if (!contactPhone) {
    throw new WebJobValidationError("contactPhone", "required — a job with no phone cannot be answered");
  }

  const tags = (body.tags ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase().replace(/[\s-]+/g, "_"))
    .filter((t) => TAGS.has(t));

  const tripMiles = delivery
    ? haversineMiles({ lat: pickup.lat, lng: pickup.lng }, { lat: delivery.lat, lng: delivery.lng })
    : null;

  const row = await queryOne<{ id: number }>(
    `INSERT INTO loads (
       source_message_id, group_id, posted_by,
       status, status_source,
       pickup_label, pickup_city, pickup_state, pickup_zip,
       pickup_lat, pickup_lng, pickup_precision,
       delivery_label, delivery_city, delivery_state, delivery_zip,
       delivery_lat, delivery_lng, delivery_precision,
       trip_miles,
       cubic_feet, price_per_cf, price_flat, rate_usd,
       ready_now, ready_date, ready_source, deliver_by, pickup_date,
       tags, flags, job_notes, requirements,
       contact_name, contact_phone, contact_phone_raw, contact_mode,
       sender_key, job_key, ordinal,
       is_canonical, confidence, needs_review,
       first_seen_at, last_seen_at, seen_count,
       expires_at
     ) VALUES (
       NULL, NULL, $1,
       'available', 'derived',
       $2,$3,$4,$5,$6,$7,$8,
       $9,$10,$11,$12,$13,$14,$15,
       $16,
       $17,$18,$19,$20,
       $21,$22,$23,$24,$25,
       $26::text[],'{}',$27,$28,
       $29,$30,$31,'public',
       NULL, NULL, 1,
       true, 1.0, false,
       now(), now(), 1,
       $32
     ) RETURNING id`,
    [
      user.id,
      pickupLabel, pickup.city, pickup.state ?? twoLetter(body.pickupState), pickup.zip,
      pickup.lat, pickup.lng, pickup.precision,
      deliveryLabel,
      delivery?.city ?? (deliveryCity ? titleCase(deliveryCity) : null),
      deliveryState,
      deliveryZip,
      delivery?.lat ?? null, delivery?.lng ?? null, delivery?.precision ?? null,
      tripMiles,
      cubicFeet, pricePerCf, priceFlat, rateUsd,
      readyNow, readyDate, readySource, deliverBy, readyDate,
      tags, (body.notes ?? "").trim() || null, (body.requirements ?? "").trim() || null,
      contactName, contactPhone, rawPhone || null,
      computeExpiry(readyDate, now),
    ],
  );

  const id = row!.id;
  await query(`INSERT INTO load_events (load_id, actor_id, kind, detail) VALUES ($1,$2,'created',$3)`, [
    id,
    user.id,
    JSON.stringify({ source: "web" }),
  ]);

  return { id };
}

function numberOrNull(v: string | undefined): number | null {
  if (v == null) return null;
  const trimmed = String(v).replace(/[$,\s]/g, "");
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function twoLetter(v: string | undefined): string | null {
  const s = (v ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
}

/**
 * The five values `loads.pickup_precision` accepts. Anything else a client
 * sends is dropped rather than passed through: an unknown string would fail the
 * column's CHECK and turn a valid post into a 500.
 */
const PRECISIONS = new Set(["address", "zip", "city", "region", "state"]);

function precisionOrNull(v: string | undefined): string | null {
  const s = (v ?? "").trim().toLowerCase();
  return PRECISIONS.has(s) ? s : null;
}

function fiveDigits(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  return /^\d{5}$/.test(s) ? s : null;
}

function optionalIsoDate(v: string | undefined, field: keyof WebJobBody): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  if (!ISO_DATE.test(s)) throw new WebJobValidationError(field, "must be a date (YYYY-MM-DD)");
  return s;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}
