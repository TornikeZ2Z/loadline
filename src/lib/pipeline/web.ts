/**
 * Jobs posted through the website rather than scraped out of WhatsApp.
 *
 * A website post has no sender snapshot, so supersession never touches it: it
 * lives until its own `expires_at` or until the poster marks it Taken.
 * Ownership is `posted_by`, which is also what B's PATCH /status gate checks --
 * `sender_key` stays NULL, and the public row reports that as `is_web`.
 *
 * This is the ONLY writer that ever sets `loads.is_demo`, and it sets it from
 * the session's own `users.is_demo` -- never from anything in the body. A demo
 * account walks the entire flow and what it publishes is visible to itself
 * alone; see db/schema.sql for why the demo is not simply refused, and
 * src/lib/loads/query.ts for the predicate that holds it.
 */
import { query, queryOne } from "@/lib/db";
import { computeExpiry } from "@/lib/extract/dates";
import { normalizePhone } from "@/lib/extract/phone";
import { geocode, geocodeDestination } from "@/lib/geo/geocode";
import { haversineMiles } from "@/lib/geo/math";
import { zipStateConflict } from "@/lib/geo/states";
import { truckExpiresAt } from "@/lib/pipeline/trucks";
import { READY_AFTER_DEADLINE } from "@/lib/loads/present";
import { DEPARTURE_ALREADY_PASSED, departureHasPassed } from "@/lib/loads/truckPresent";
import { DEFAULT_TRUCK_CORRIDOR_MILES, TRUCK_CORRIDOR_OPTIONS } from "@/lib/loads/constants";

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
  /**
   * Which of the three things the poster said about readiness (review L07).
   * "now" and "date" are claims; "unknown" is the honest absence of one, and
   * there is no fourth value meaning "we picked for you".
   */
  readyState?: "now" | "date" | "unknown" | "";
  /** Legacy: the tick-box the form sent before `readyState` existed. */
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

/**
 * How many listings one demo account keeps, and for how long.
 *
 * The lifetime question, answered where it costs nothing to enforce. A demo
 * listing is scratch: nobody but its poster ever sees it, the poster is a
 * shared identity a stranger enters with one click, and a fresh visitor tomorrow
 * has no use for what a visitor typed today. Left alone it would still grow
 * without limit, one row per click, for as long as the site is up.
 *
 * So every demo post sweeps its OWN account's older ones. That bounds the table
 * by the shape of the thing rather than by the number of requests -- at most
 * `DEMO_KEEP` rows per demo account, forever, however hard anybody leans on the
 * button -- which is the same bound `problem_reports` gets from its UNIQUE key.
 * A cron job would be a second moving part to answer a question the insert
 * already knows the answer to; a sweep on insert cannot fail to run, because
 * the only way to make demo rows is to run it.
 *
 * The age rule is the tidiness half and bounds nothing on its own: it is what
 * makes the demo look untouched to the next visitor rather than lived-in.
 * An account that posts five listings and never returns keeps five rows, which
 * is a fair price for the walkthrough still working when they come back.
 */
const DEMO_KEEP = 5;
const DEMO_MAX_AGE_HOURS = 24;

/**
 * `isDemo` is required, not optional with a false default. A caller who forgets
 * it should not quietly publish a demo post to the whole board -- the one
 * failure mode this whole change exists to remove -- so the compiler asks.
 */
export async function insertWebJob(
  user: { id: number; name: string; phone: string | null; isDemo: boolean },
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

  // The pair as the ROW will hold it, which is the pair that has to agree.
  // In the picked branch these are the two fields the body sent; in the
  // geocoded branch they are one geocoder's own answer, and checking that too
  // costs nothing and closes the only other way a disagreeing pair could reach
  // the column.
  const pickupState = pickup.state ?? twoLetter(body.pickupState);
  const pickupClash = zipStateConflict(pickupState, pickup.zip, "pickup");
  if (pickupClash) throw new WebJobValidationError("pickupZip", pickupClash.message);

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

  /*
   * A delivery ZIP that belongs to a different state than the one chosen.
   *
   * This is the review's own case: `deliveryState:"FL"` with
   * `deliveryZip:"07102"` used to be accepted. Nothing was invented -- the
   * geocoder saw the disagreement, refused the ZIP's point and stored the
   * Florida centroid at `delivery_precision:'state'` with no city, and the
   * board printed "Approximate delivery" -- but the row still held a Florida
   * job carrying a Newark ZIP, and the only person who could say which of the
   * two was meant was never asked.
   *
   * REFUSED rather than corrected, and the refusal is a question. Correcting
   * would mean choosing a winner, and there is no rule that picks one: the
   * poster who tabbed past the state select and the poster who pasted the ZIP
   * off the wrong line send the identical body. Choosing would be inventing a
   * fact -- the exact thing this product says it does not do -- and it would
   * invent it silently, in the field a driver reads first.
   *
   * Refusing here is also what makes the guarantee absolute rather than
   * conventional: this is the only writer for a posted job, so a `loads` row
   * whose `delivery_state` and `delivery_zip` disagree cannot be created
   * through the front door at all, by a form, by curl, or by a client that has
   * not been updated. The browser offers the two repairs as buttons because it
   * has a person in front of it; the API has only words, so it uses them.
   */
  const deliveryClash = zipStateConflict(deliveryState, deliveryZip, "delivery");
  if (deliveryClash) throw new WebJobValidationError("deliveryZip", deliveryClash.message);

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
  // The third option is the point of it (review L07). The form used to offer
  // "ready now" or a date, defaulting to "ready now", so a poster who did not
  // know published a green claim by tabbing past the question -- the same
  // invention the WhatsApp path made, through the front door.
  //
  // A body with no `readyState` is a legacy client (scripts/check-demo.ts posts
  // one): its tick-box still means "now", but its SILENCE now means unknown.
  const readyDate = optionalIsoDate(body.readyDate, "readyDate");
  const deliverBy = optionalIsoDate(body.deliverBy, "deliverBy");
  const stated = body.readyState || (body.readyNow === "on" ? "now" : readyDate ? "date" : "unknown");
  if (stated !== "now" && stated !== "date" && stated !== "unknown") {
    throw new WebJobValidationError(
      "readyState",
      "say whether the job is ready now, ready on a date, or not stated yet",
    );
  }
  if (stated === "date" && !readyDate) {
    throw new WebJobValidationError("readyDate", "give the date the job is ready, or choose \u201cNot stated yet\u201d");
  }
  // Freight that is ready only after it is due is a job nobody can run. Both
  // fields are calendar days typed against the same board -- neither is a
  // timestamp, so there is no zone to convert between and the ISO compare IS
  // the board's calendar.
  if (stated === "date" && readyDate && deliverBy && readyDate > deliverBy) {
    throw new WebJobValidationError("readyDate", READY_AFTER_DEADLINE);
  }
  const readyNow = stated === "now";
  const readyDateStored = stated === "date" ? readyDate : null;
  const readyState = stated;
  const readySource = stated === "unknown" ? null : "line";

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
       ready_now, ready_date, ready_source, ready_state, deliver_by, pickup_date,
       tags, flags, job_notes, requirements,
       contact_name, contact_phone, contact_phone_raw, contact_mode,
       sender_key, job_key, ordinal,
       is_canonical, confidence, needs_review,
       first_seen_at, last_seen_at, seen_count,
       expires_at, is_demo
     ) VALUES (
       NULL, NULL, $1,
       'available', 'derived',
       $2,$3,$4,$5,$6,$7,$8,
       $9,$10,$11,$12,$13,$14,$15,
       $16,
       $17,$18,$19,$20,
       $21,$22,$23,$34,$24,$25,
       $26::text[],'{}',$27,$28,
       $29,$30,$31,'public',
       NULL, NULL, 1,
       true, 1.0, false,
       now(), now(), 1,
       $32, $33
     ) RETURNING id`,
    [
      user.id,
      pickupLabel, pickup.city, pickupState, pickup.zip,
      pickup.lat, pickup.lng, pickup.precision,
      deliveryLabel,
      delivery?.city ?? (deliveryCity ? titleCase(deliveryCity) : null),
      deliveryState,
      deliveryZip,
      delivery?.lat ?? null, delivery?.lng ?? null, delivery?.precision ?? null,
      tripMiles,
      cubicFeet, pricePerCf, priceFlat, rateUsd,
      readyNow, readyDateStored, readySource, deliverBy, readyDateStored,
      tags, (body.notes ?? "").trim() || null, (body.requirements ?? "").trim() || null,
      contactName, contactPhone, rawPhone || null,
      computeExpiry(readyDateStored, now),
      user.isDemo,
      readyState,
    ],
  );

  const id = row!.id;
  await query(`INSERT INTO load_events (load_id, actor_id, kind, detail) VALUES ($1,$2,'created',$3)`, [
    id,
    user.id,
    JSON.stringify({ source: "web", demo: user.isDemo }),
  ]);

  if (user.isDemo) await sweepDemoJobs(user.id);

  return { id };
}

/**
 * Retire this demo account's older listings. See `DEMO_KEEP` above.
 *
 * Scoped to `posted_by` AND `is_demo`, never to `is_demo` alone: the predicate
 * has to be one a real row can never satisfy, or a bug here would delete the
 * corpus rather than a stranger's scratch listing. Deleting is right rather
 * than expiring, because an expired row is still a row and the point is that
 * the table does not grow. `load_events` cascades with it; `problem_reports`
 * holds a soft reference and keeps a report about a job that has gone, which is
 * what that table's comment says it is for.
 *
 * Runs after the insert, so `DEMO_KEEP` counts the listing just made.
 */
async function sweepDemoJobs(userId: number): Promise<number> {
  const gone = await query<{ id: number }>(
    `DELETE FROM loads
      WHERE is_demo = true
        AND posted_by = $1
        AND (
          created_at < now() - ($2 || ' hours')::interval
          OR id NOT IN (
            SELECT id FROM loads
             WHERE is_demo = true AND posted_by = $1
             ORDER BY id DESC
             LIMIT $3
          )
        )
      RETURNING id`,
    [userId, String(DEMO_MAX_AGE_HOURS), DEMO_KEEP],
  );
  return gone.length;
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

// --- available truck space ---------------------------------------------------

/**
 * A driver's empty leg, posted through the website.
 *
 * The sibling of `insertWebJob` above, in the same file for the reason §9 gives:
 * same geocode path, same precision handling, same validator style, same demo
 * stamp read from the session and from nowhere else. What it is NOT is a mode
 * of `insertWebJob` -- the two write different tables, and the columns are
 * deliberately named so that nothing here can be pasted into there.
 *
 * Every honesty rule in the form is enforced HERE as well as in the browser,
 * because a POST is a public interface:
 *
 *   * an empty destination that was not explicitly ticked "not decided" is a
 *     validation error naming the field. We will not guess which the driver
 *     meant, and a truck silently given no destination is a truck whose lane
 *     the board would print as unknown when in fact the driver just tabbed past
 *     the box;
 *   * `free_cf` blank is blank. It is never 0, never derived from `truck_cf`,
 *     and never read out of `truck_text`: "26 ft box truck" is a length and a
 *     body style, not a volume, and converting one into the other is the single
 *     thing this product's voice refuses most loudly;
 *   * `avail_now` is true only when the driver said so. There is no default and
 *     no silent today, which is why `availMode` has four values and not three.
 */
export interface WebTruckBody {
  origin: string;                                   // required label as typed or picked
  originLat?: string;
  originLng?: string;
  originState?: string;
  originZip?: string;
  originPrecision?: string;

  dest?: string;                                    // optional, but see destUndecided
  destLat?: string;
  destLng?: string;
  destState?: string;
  destZip?: string;
  destPrecision?: string;
  /** "on" -- the driver ticked "Not decided yet". Required when `dest` is blank. */
  destUndecided?: "on" | "";

  freeCf?: string;                                  // 10..20000, or blank for "not sure"
  truckCf?: string;                                 // 10..20000, must be >= freeCf
  truckText?: string;                               // the words; never converted to cf

  /** No default: "now" | "from" | "between" | "unknown". */
  availMode?: string;
  availFrom?: string;                               // YYYY-MM-DD
  availTo?: string;                                 // YYYY-MM-DD

  corridorMiles?: string;                           // one of TRUCK_CORRIDOR_OPTIONS

  equipment?: string;                               // comma list over the job TAG vocabulary
  cannot?: string;                                  // comma list, disjoint from equipment
  equipmentNotes?: string;

  hasDotMc?: "on" | "";
  hasHhgAuthority?: "on" | "";
  hasCoi?: "on" | "";

  requirements?: string;
  notes?: string;
  contactName?: string;
  contactPhone?: string;                            // default user.phone; required after defaulting
}

/**
 * The field name travels with the message so the route can answer
 * "freeCf: must be between 10 and 20000 cubic feet" and the form can put the
 * error under the input it belongs to. The type is the union of the post body
 * and the patch body: `status` only exists on the second, and naming it in a
 * message is the difference between a form that highlights a control and one
 * that prints a sentence at the bottom.
 */
export class WebTruckValidationError extends Error {
  constructor(
    public field: keyof WebTruckBody | keyof WebTruckPatch,
    message: string,
  ) {
    super(message);
    this.name = "WebTruckValidationError";
  }
}

/** Free space, in cubic feet. The column's own CHECK, restated where the message can name the field. */
const FREE_CF_MIN = 10;
const FREE_CF_MAX = 20000;

/**
 * A demo account's trucks are swept exactly as its jobs are.
 *
 * Same numbers, and the same reasoning: a demo listing is scratch that only its
 * poster can see, the poster is an identity a stranger enters with one click,
 * and the table must be bounded by the shape of the thing rather than by how
 * hard somebody leans on the button. Separate constants would have been two
 * numbers to keep in step for no benefit, so this reuses `DEMO_KEEP` and
 * `DEMO_MAX_AGE_HOURS` above.
 */
export async function insertWebTruck(
  user: { id: number; name: string; phone: string | null; isDemo: boolean },
  body: WebTruckBody,
): Promise<{ id: number }> {
  const now = new Date();

  // --- where it will be empty ----------------------------------------------
  const originLabel = (body.origin ?? "").trim();
  if (!originLabel) throw new WebTruckValidationError("origin", "required");

  const origin = await placeFor(originLabel, {
    lat: body.originLat,
    lng: body.originLng,
    state: body.originState,
    zip: body.originZip,
    precision: body.originPrecision,
  });
  if (!origin) throw new WebTruckValidationError("origin", "could not be found on the map");
  // The same disagreement, on the truck's own two ends. A driver working the
  // form cannot easily produce it -- both halves come from one picked
  // suggestion rather than from a select and a text box -- but `originState`
  // and `originZip` are two independent fields of a public POST body, and the
  // guarantee is about the column, not about the form that usually fills it.
  const originClash = zipStateConflict(origin.state, origin.zip, "origin");
  if (originClash) throw new WebTruckValidationError("originZip", originClash.message);

  // --- where it is headed ---------------------------------------------------
  // Blank AND unticked is the error. The two are different answers and the form
  // says so; conflating them is how a truck ends up claiming a lane it never
  // claimed, or hiding one it did.
  const destLabel = (body.dest ?? "").trim();
  const undecided = body.destUndecided === "on";
  if (!destLabel && !undecided) {
    throw new WebTruckValidationError(
      "dest",
      'give a destination, or tick "Not decided yet" — we will not guess which you meant',
    );
  }
  if (destLabel && undecided) {
    throw new WebTruckValidationError(
      "dest",
      'you typed a destination and also ticked "Not decided yet" — pick one',
    );
  }

  const dest = destLabel
    ? await placeFor(destLabel, {
        lat: body.destLat,
        lng: body.destLng,
        state: body.destState,
        zip: body.destZip,
        precision: body.destPrecision,
      })
    : null;
  if (destLabel && !dest) throw new WebTruckValidationError("dest", "could not be found on the map");
  const destClash = dest ? zipStateConflict(dest.state, dest.zip, "destination") : null;
  if (destClash) throw new WebTruckValidationError("destZip", destClash.message);

  const legMiles = dest
    ? haversineMiles({ lat: origin.lat, lng: origin.lng }, { lat: dest.lat, lng: dest.lng })
    : null;

  // --- space ----------------------------------------------------------------
  const freeCf = cfOrNull(body.freeCf, "freeCf");
  const truckCf = cfOrNull(body.truckCf, "truckCf");
  if (freeCf != null && truckCf != null && freeCf > truckCf) {
    throw new WebTruckValidationError("freeCf", "free space cannot be larger than the truck");
  }
  const truckText = (body.truckText ?? "").trim() || null;

  // --- when -----------------------------------------------------------------
  const { availNow, availFrom, availTo, availSource } = parseAvailability(body);
  // A truck is posted `available`, so a window already behind us would go
  // straight onto the public board as a departure that has been and gone --
  // the stale listing SPEC 10.1 exists to prevent, arriving through the front
  // door. The sweep would clear it within the hour, and an hour of a board
  // saying something untrue is an hour of wasted phone calls.
  refusePastDeparture(availFrom, availTo, now);

  // --- the one matcher knob -------------------------------------------------
  const corridorMiles = corridorOrDefault(body.corridorMiles);

  // --- what it can and cannot take -----------------------------------------
  const equipment = tagList(body.equipment);
  const cannot = tagList(body.cannot);
  const both = equipment.filter((t) => cannot.includes(t));
  if (both.length) {
    throw new WebTruckValidationError(
      "cannot",
      `${both.join(", ")} is ticked in both columns — a truck cannot both handle and refuse the same thing`,
    );
  }

  // --- contact --------------------------------------------------------------
  const contactName = (body.contactName ?? "").trim() || user.name;
  const rawPhone = (body.contactPhone ?? "").trim() || user.phone || "";
  const phone = normalizePhone(rawPhone);
  const contactPhone = phone.e164 ?? phone.display;
  if (!contactPhone) {
    throw new WebTruckValidationError(
      "contactPhone",
      "required — a truck with no phone cannot be answered",
    );
  }

  const expiresAt = truckExpiresAt({ availFrom, availTo, lastSeenAt: now });

  const row = await queryOne<{ id: number }>(
    `INSERT INTO trucks (
       source_message_id, group_id, posted_by, sender_key, truck_key,
       status, status_source, visibility,
       origin_label, origin_city, origin_state, origin_zip,
       origin_lat, origin_lng, origin_precision,
       dest_label, dest_city, dest_state, dest_zip,
       dest_lat, dest_lng, dest_precision,
       leg_miles,
       free_cf, truck_cf, free_source, truck_text,
       avail_now, avail_from, avail_to, avail_source,
       corridor_miles,
       has_dot_mc, has_hhg_authority, has_coi,
       equipment, cannot, equipment_notes, requirements, notes,
       contact_name, contact_phone, contact_phone_raw, contact_mode, contact_phone_source,
       line_text, supply_phrase, shape, confidence, needs_review, flags,
       first_seen_at, last_seen_at, seen_count,
       expires_at, is_demo
     ) VALUES (
       NULL, NULL, $1, NULL, NULL,
       'available', 'derived', 'public',
       $2,$3,$4,$5,$6,$7,$8,
       $9,$10,$11,$12,$13,$14,$15,
       $16,
       $17,$18,$19,$20,
       $21,$22,$23,$24,
       $25,
       $26,$27,$28,
       $29::text[],$30::text[],$31,$32,$33,
       $34,$35,$36,'public','post',
       NULL, NULL, 'form', 1.0, false, '{}',
       now(), now(), 1,
       $37, $38
     ) RETURNING id`,
    [
      user.id,
      originLabel, origin.city, origin.state, origin.zip,
      origin.lat, origin.lng, origin.precision,
      dest ? destLabel : null, dest?.city ?? null, dest?.state ?? null, dest?.zip ?? null,
      dest?.lat ?? null, dest?.lng ?? null, dest?.precision ?? null,
      legMiles,
      // `free_source` is 'form' only when a number was actually typed. A NULL
      // size with a source would say "the form stated it" about a blank.
      freeCf, truckCf, freeCf != null ? "form" : null, truckText,
      availNow, availFrom, availTo, availSource,
      corridorMiles,
      checkbox(body.hasDotMc), checkbox(body.hasHhgAuthority), checkbox(body.hasCoi),
      equipment, cannot,
      (body.equipmentNotes ?? "").trim() || null,
      (body.requirements ?? "").trim() || null,
      (body.notes ?? "").trim() || null,
      contactName, contactPhone, rawPhone || null,
      expiresAt, user.isDemo,
    ],
  );

  const id = row!.id;
  await query(`INSERT INTO truck_events (truck_id, actor_id, kind, detail) VALUES ($1,$2,'created',$3)`, [
    id,
    user.id,
    JSON.stringify({ source: "web", demo: user.isDemo }),
  ]);

  if (user.isDemo) await sweepDemoTrucks(user.id);

  return { id };
}

/**
 * The fields a driver may change after posting, and the ones they may not.
 *
 * Editing exists for trucks and not for jobs, and that asymmetry is deliberate
 * (SPEC §9.1): a departure slips, and a truck advertising last Tuesday is worse
 * than no truck at all -- it costs a dispatcher the one phone call they were
 * going to make. A job's date slipping costs nothing like as much.
 *
 * ORIGIN AND DESTINATION ARE NOT EDITABLE, and that is the load-bearing half of
 * this function. Changing the lane makes it a different truck; the pairing
 * history that stage 4 writes into `truck_matches` would silently become about
 * something else, and a dispatcher who saved a link to "the Newark to Miami
 * truck" would open a Denver one. The form says: post that as a second truck.
 *
 * Every call writes a `truck_events` row of kind `edited` carrying the before
 * and after of exactly the fields that moved, and recomputes `expires_at` --
 * without which extending a departure by a day would leave the listing expiring
 * on yesterday's clock.
 */
export interface WebTruckPatch {
  freeCf?: string | null;
  truckCf?: string | null;
  truckText?: string | null;
  availMode?: string;
  availFrom?: string | null;
  availTo?: string | null;
  corridorMiles?: string | null;
  equipment?: string | null;
  cannot?: string | null;
  equipmentNotes?: string | null;
  requirements?: string | null;
  notes?: string | null;
  hasDotMc?: "on" | "";
  hasHhgAuthority?: "on" | "";
  hasCoi?: "on" | "";
  status?: string;
}

/** What a person may set. The other two are conclusions the sweep draws. */
export const MANUAL_TRUCK_STATUSES = ["available", "booked", "cancelled"] as const;
export type ManualTruckStatus = (typeof MANUAL_TRUCK_STATUSES)[number];

interface EditableTruck {
  id: number;
  free_cf: number | null;
  truck_cf: number | null;
  truck_text: string | null;
  avail_now: boolean;
  avail_from: string | null;
  avail_to: string | null;
  avail_source: string | null;
  corridor_miles: number;
  equipment: string[];
  cannot: string[];
  equipment_notes: string | null;
  requirements: string | null;
  notes: string | null;
  has_dot_mc: boolean | null;
  has_hhg_authority: boolean | null;
  has_coi: boolean | null;
  status: string;
  status_source: string;
  last_seen_at: string | null;
}

export async function updateWebTruck(
  truckId: number,
  actorId: number,
  patch: WebTruckPatch,
): Promise<{ id: number; changed: string[] } | null> {
  const before = await queryOne<EditableTruck>(
    `SELECT id, free_cf, truck_cf, truck_text, avail_now,
            avail_from::text AS avail_from, avail_to::text AS avail_to, avail_source,
            corridor_miles, coalesce(equipment,'{}') AS equipment, coalesce(cannot,'{}') AS cannot,
            equipment_notes, requirements, notes,
            has_dot_mc, has_hhg_authority, has_coi, status, status_source,
            last_seen_at::text AS last_seen_at
       FROM trucks WHERE id = $1`,
    [truckId],
  );
  if (!before) return null;

  const next: Record<string, unknown> = {};

  if ("freeCf" in patch) next.free_cf = cfOrNull(patch.freeCf ?? "", "freeCf");
  if ("truckCf" in patch) next.truck_cf = cfOrNull(patch.truckCf ?? "", "truckCf");
  const freeAfter = ("free_cf" in next ? next.free_cf : before.free_cf) as number | null;
  const truckAfter = ("truck_cf" in next ? next.truck_cf : before.truck_cf) as number | null;
  if (freeAfter != null && truckAfter != null && freeAfter > truckAfter) {
    throw new WebTruckValidationError("freeCf", "free space cannot be larger than the truck");
  }
  // A size that was stated and is now blank loses its source with it: a
  // `free_source` left behind on a NULL would claim the form stated nothing.
  if ("free_cf" in next) next.free_source = next.free_cf != null ? "form" : null;

  if ("truckText" in patch) next.truck_text = (patch.truckText ?? "").trim() || null;

  if (patch.availMode) {
    const a = parseAvailability({
      availMode: patch.availMode,
      availFrom: patch.availFrom ?? "",
      availTo: patch.availTo ?? "",
    });
    next.avail_now = a.availNow;
    next.avail_from = a.availFrom;
    next.avail_to = a.availTo;
    next.avail_source = a.availSource;
  }

  if (patch.corridorMiles != null) next.corridor_miles = corridorOrDefault(patch.corridorMiles);

  if ("equipment" in patch || "cannot" in patch) {
    const equipment = "equipment" in patch ? tagList(patch.equipment ?? "") : before.equipment;
    const cannot = "cannot" in patch ? tagList(patch.cannot ?? "") : before.cannot;
    const both = equipment.filter((t) => cannot.includes(t));
    if (both.length) {
      throw new WebTruckValidationError(
        "cannot",
        `${both.join(", ")} is ticked in both columns — a truck cannot both handle and refuse the same thing`,
      );
    }
    next.equipment = equipment;
    next.cannot = cannot;
  }

  if ("equipmentNotes" in patch) next.equipment_notes = (patch.equipmentNotes ?? "").trim() || null;
  if ("requirements" in patch) next.requirements = (patch.requirements ?? "").trim() || null;
  if ("notes" in patch) next.notes = (patch.notes ?? "").trim() || null;
  if ("hasDotMc" in patch) next.has_dot_mc = checkbox(patch.hasDotMc);
  if ("hasHhgAuthority" in patch) next.has_hhg_authority = checkbox(patch.hasHhgAuthority);
  if ("hasCoi" in patch) next.has_coi = checkbox(patch.hasCoi);

  if (patch.status != null) {
    if (!(MANUAL_TRUCK_STATUSES as readonly string[]).includes(patch.status)) {
      throw new WebTruckValidationError(
        "status",
        `status must be one of: ${MANUAL_TRUCK_STATUSES.join(", ")}`,
      );
    }
    next.status = patch.status;
    // A person said so, so the sweep's own reasoning no longer owns this field.
    // Note that `expireTrucks` still revisits a MANUAL 'available' truck whose
    // departure day has passed -- see the note in src/lib/pipeline/trucks.ts:
    // a departure is a physical fact, not an inference about silence.
    next.status_source = "manual";
  }

  // SPEC 10.2, acceptance T6: a truck may not be `available` with a departure
  // that already happened.
  //
  // Tested on the RESULTING state rather than on the transition, because the two
  // routes into this function reach the same end from opposite directions --
  // `PATCH /status` hands a booked truck back with its old dates, and `PATCH`
  // moves an available truck's dates backwards -- and a listing advertising last
  // Tuesday is the stale-truck failure 10.1 exists to prevent either way.
  //
  // The sweep would clear it on its next run, which is why this is a refusal and
  // not a repair: between the two the board is telling a dispatcher something
  // untrue, and the person who can fix it is the one making the request.
  //
  // `insertWebTruck` runs the SAME predicate on the way in. It did not always,
  // and closing that gap is why the check is a shared function rather than the
  // dozen lines that used to sit here: POST accepted a window entirely in the
  // past and published the truck as `available`, which is this identical lie
  // reached through the one door that had no lock on it.
  const statusAfter = ("status" in next ? next.status : before.status) as string;
  if (statusAfter === "available") {
    const fromAfter = (("avail_from" in next ? next.avail_from : before.avail_from) as string | null) ?? null;
    const toAfter = (("avail_to" in next ? next.avail_to : before.avail_to) as string | null) ?? null;
    refusePastDeparture(fromAfter, toAfter, new Date());
  }

  // Only what actually moved. An "edited" event listing fields nobody touched
  // would make the admin history unreadable within a week.
  const changed = Object.keys(next).filter(
    (k) => JSON.stringify(next[k]) !== JSON.stringify((before as unknown as Record<string, unknown>)[k]),
  );

  // The clock, recomputed from the dates as they now stand. `last_seen_at` is
  // the truck's own anchor, not `now()`: a listing seen this morning and edited
  // this afternoon keeps the TTL it was given, so editing a note cannot silently
  // extend a truck's life on the board.
  //
  // The ONE exception is SPEC 10.2's other half: handing a truck back to
  // `available` "recomputes `expires_at` from `now`". A relist is a fresh
  // statement that the truck is free, not an edit to a listing that was already
  // on the board -- and anchoring it to `last_seen_at` gives a DATELESS truck
  // unbooked two days later an `expires_at` in the past, so the very next sweep
  // deletes the listing its owner just restored. Dated trucks are unaffected
  // either way: their expiry comes from `avail_to`, and the refusal above means
  // that date is still ahead.
  const relisted = "status" in next && next.status === "available" && before.status !== "available";
  const lastSeen = before.last_seen_at ? new Date(before.last_seen_at) : new Date();
  const expiresAt = truckExpiresAt({
    availFrom: (("avail_from" in next ? next.avail_from : before.avail_from) as string | null) ?? null,
    availTo: (("avail_to" in next ? next.avail_to : before.avail_to) as string | null) ?? null,
    lastSeenAt: relisted || Number.isNaN(lastSeen.getTime()) ? new Date() : lastSeen,
  });

  const columns = Object.keys(next);
  const sets = columns.map((c, i) => `${c} = $${i + 2}`);
  sets.push(`expires_at = $${columns.length + 2}`);
  sets.push(`updated_at = now()`);

  // THE TEN-MINUTE QUIET WINDOW (SPEC 12.1.3).
  //
  // One owner changing one departure date can flip dozens of pairings at once,
  // and each flip is a match the sweep has never seen before. Without this the
  // next run turns a single edit into a burst of alerts about the same truck.
  // The sweep skips a truck while this is in the future and afterwards emits
  // ONE digest for everything that moved -- acceptance N5.
  //
  // Stamped on any edit that changed anything, not only on a date: a corridor
  // widened from 60 to 300 miles flips as many pairings as a date does, and
  // enumerating which fields are "matchy" is a list that would go stale. It is
  // deliberately NOT part of `next`, so it never appears in the `edited` event's
  // field list -- it is bookkeeping about the edit, not a thing the owner
  // changed.
  if (changed.length) sets.push(`quiet_until = now() + interval '10 minutes'`);

  await query(`UPDATE trucks SET ${sets.join(", ")} WHERE id = $1`, [
    truckId,
    ...columns.map((c) => next[c]),
    expiresAt,
  ]);

  if (changed.length) {
    const detail: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of changed) {
      detail[k] = { from: (before as unknown as Record<string, unknown>)[k], to: next[k] };
    }
    await query(
      `INSERT INTO truck_events (truck_id, actor_id, kind, detail) VALUES ($1,$2,'edited',$3)`,
      [truckId, actorId, JSON.stringify(detail)],
    );
  }

  return { id: truckId, changed };
}

/** This demo account's older trucks. See `sweepDemoJobs` — same bound, same reasoning. */
async function sweepDemoTrucks(userId: number): Promise<number> {
  const gone = await query<{ id: number }>(
    `DELETE FROM trucks
      WHERE is_demo = true
        AND posted_by = $1
        AND (
          created_at < now() - ($2 || ' hours')::interval
          OR id NOT IN (
            SELECT id FROM trucks
             WHERE is_demo = true AND posted_by = $1
             ORDER BY id DESC
             LIMIT $3
          )
        )
      RETURNING id`,
    [userId, String(DEMO_MAX_AGE_HOURS), DEMO_KEEP],
  );
  return gone.length;
}

/**
 * A place from the picked suggestion, or from a geocode of what was typed.
 *
 * The same two-branch shape as the pickup in `insertWebJob`, written here rather
 * than lifted into a helper the two share: `insertWebJob` is a shipped, gated
 * path and this feature does not touch it.
 */
async function placeFor(
  label: string,
  picked: {
    lat?: string;
    lng?: string;
    state?: string;
    zip?: string;
    precision?: string;
  },
): Promise<{
  lat: number;
  lng: number;
  city: string | null;
  state: string | null;
  zip: string | null;
  precision: string;
} | null> {
  const lat = numberOrNull(picked.lat);
  const lng = numberOrNull(picked.lng);
  if (lat != null && lng != null) {
    const zip = fiveDigits(picked.zip);
    return {
      lat,
      lng,
      city: null,
      state: twoLetter(picked.state),
      zip,
      precision: precisionOrNull(picked.precision) ?? (zip ? "zip" : "city"),
    };
  }
  const hit = await geocode(label);
  if (!hit) return null;
  return {
    lat: hit.lat,
    lng: hit.lng,
    city: hit.city,
    state: hit.state,
    zip: hit.zip,
    precision: hit.precision,
  };
}

/**
 * The four answers to "when are you empty?", and there is no fifth.
 *
 * `unknown` is a real answer and is stored as one: `avail_now` false, both dates
 * NULL, and `avail_source` NULL so nothing downstream can claim the form said
 * something. It is NOT the same as an absent `availMode`, which is a client that
 * forgot the field -- that is a validation error, because silently choosing for
 * the driver is exactly how a truck ends up advertising a departure it never
 * promised.
 */
function parseAvailability(body: Pick<WebTruckBody, "availMode" | "availFrom" | "availTo">): {
  availNow: boolean;
  availFrom: string | null;
  availTo: string | null;
  availSource: "form" | null;
} {
  const mode = (body.availMode ?? "").trim();
  const from = optionalTruckDate(body.availFrom, "availFrom");
  const to = optionalTruckDate(body.availTo, "availTo");

  if (mode === "now") return { availNow: true, availFrom: from, availTo: to, availSource: "form" };

  if (mode === "from") {
    if (!from) throw new WebTruckValidationError("availFrom", "give the date you are empty from");
    return { availNow: false, availFrom: from, availTo: null, availSource: "form" };
  }

  if (mode === "between") {
    if (!from || !to) {
      throw new WebTruckValidationError("availFrom", "give both dates, or choose a single date");
    }
    if (to < from) {
      throw new WebTruckValidationError("availTo", "the second date is before the first");
    }
    return { availNow: false, availFrom: from, availTo: to, availSource: "form" };
  }

  if (mode === "unknown") {
    return { availNow: false, availFrom: null, availTo: null, availSource: null };
  }

  throw new WebTruckValidationError(
    "availMode",
    'say when the truck is empty — "Now", a date, a range, or "Not decided"',
  );
}

/**
 * The one refusal, over the one predicate, called by both writers.
 *
 * `departureHasPassed` decides WHAT is past -- the board's calendar, the end of
 * the window, an undated truck exempt -- and lives in truckPresent.ts because
 * the posting form has to say the same sentence before the request is even
 * sent. This wrapper is the half that belongs to the writers: which field the
 * message is hung on, so the form can put it under the input that has to change.
 *
 * `availTo` when there is one, `availFrom` when the driver gave a single open
 * date -- naming the second date on a truck that never had one would point at a
 * control the form is not showing.
 */
function refusePastDeparture(availFrom: string | null, availTo: string | null, now: Date): void {
  if (!departureHasPassed({ availFrom, availTo }, now)) return;
  throw new WebTruckValidationError(availTo ? "availTo" : "availFrom", DEPARTURE_ALREADY_PASSED);
}

function cfOrNull(v: string | undefined | null, field: keyof WebTruckBody): number | null {
  const n = numberOrNull(v ?? undefined);
  if (n == null) return null;
  const rounded = Math.round(n);
  if (rounded < FREE_CF_MIN || rounded > FREE_CF_MAX) {
    throw new WebTruckValidationError(
      field,
      `must be between ${FREE_CF_MIN} and ${FREE_CF_MAX} cubic feet`,
    );
  }
  return rounded;
}

function corridorOrDefault(v: string | undefined | null): number {
  const n = numberOrNull(v ?? undefined);
  if (n == null) return DEFAULT_TRUCK_CORRIDOR_MILES;
  const rounded = Math.round(n);
  // Snapped to the offered list rather than clamped to the column's 10..300
  // CHECK: the value is a select, so anything else is a client that made one up,
  // and a made-up 137 would be a matcher setting no driver chose.
  return (TRUCK_CORRIDOR_OPTIONS as readonly number[]).includes(rounded)
    ? rounded
    : DEFAULT_TRUCK_CORRIDOR_MILES;
}

/** The job TAG vocabulary, shared on purpose: a truck handles what a job needs. */
function tagList(raw: string | undefined | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase().replace(/[\s-]+/g, "_"))
    .filter((t) => TAGS.has(t));
}

function checkbox(v: "on" | "" | undefined): boolean | null {
  // NULL, not false: "the driver did not tick it" and "the driver said no" are
  // different facts, and no surface prints either as a claim.
  return v === "on" ? true : null;
}

function optionalTruckDate(v: string | undefined | null, field: keyof WebTruckBody): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  if (!ISO_DATE.test(s)) throw new WebTruckValidationError(field, "must be a date (YYYY-MM-DD)");
  return s;
}
