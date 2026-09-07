/**
 * The single decision site. Does this job belong on this truck?
 *
 * ONE function answers it, for both directions of the board, for the map, for
 * the posting form's live preview and (stage 5) for the notification cron. Two
 * implementations of "is this a match" is how a driver gets an alert about a
 * load that the page it links to refuses to show, and there is no recovering
 * the reader's trust after that.
 *
 * PURE. No database, no network, no clock -- `today` is an argument, so the
 * same inputs produce byte-identical output on any machine at any hour
 * (acceptance M16), and no HERE call can ever be made from a match query
 * (acceptance M14). `loads.road_miles` is USED when the row already carried it
 * and never fetched to find out.
 *
 * Fourteen gates, in order, first failure wins and nothing further is computed.
 * The caller gets the refusal code and counts them into a histogram, because
 * the most likely screen on a 98-job board with a handful of trucks is an empty
 * one, and "11 were going the wrong way · 4 were bigger than your 400 cf free"
 * is the difference between a board that is honest and a board that is broken.
 *
 * SPEC 11.3 - 11.7.
 */
import { addDays, diffDays, isoOf, type LocalDate } from "@/lib/extract/dates";
import { haversineMiles, initialBearing, intermediatePoint } from "@/lib/geo/math";
import { corridorMeasure } from "./corridor";
import {
  DEFAULT_MATCH_CORRIDOR_MILES,
  MAX_BEARING_DEG,
  MAX_DETOUR_FRACTION,
  MILES_PER_DRIVING_DAY,
  OPEN_TRUCK_RADIUS_MILES,
  PROGRESS_EPSILON,
  ROAD_FACTOR,
  STRONG_DETOUR_FRACTION,
  STRONG_OFFROUTE_FRACTION,
} from "./constants";
import { buildReasons } from "./reasons";
import type {
  MatchFacts,
  MatchJob,
  MatchTruck,
  MatchVerdict,
  RefusalCode,
  Unknown,
} from "./types";
import { UNKNOWN_ORDER } from "./types";

export interface EvaluateInput {
  truck: MatchTruck;
  job: MatchJob;
  /** Today, in the board's timezone. There is no clock inside this module. */
  today: LocalDate;
  /**
   * Gate 14. The truck's owner has already said no to this job, so it stops
   * coming back. Stage 5 owns the store; the gate is here, in order, so that
   * wiring it up later is a data change and not a change to the decision.
   */
  dismissed?: boolean;
}

const refuse = (refusal: RefusalCode): MatchVerdict => ({ ok: false, refusal });

/** An ISO date to the calendar shape the date helpers work in. */
function parseIso(iso: string | null | undefined): LocalDate | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

const laterOf = (a: LocalDate, b: LocalDate): LocalDate => (diffDays(a, b) >= 0 ? a : b);

/**
 * Days behind a wheel, from a straight line.
 *
 * Crude on purpose and disclosed wherever it shows: `ROAD_FACTOR` turns the
 * great circle into something road-shaped and `MILES_PER_DRIVING_DAY` is an HHG
 * truck's day. It exists to refuse impossible calendars and to count a wait --
 * never to promise a delivery date, and never to justify a routing call.
 */
export function driveDays(miles: number): number {
  return Math.max(1, Math.ceil((miles * ROAD_FACTOR) / MILES_PER_DRIVING_DAY));
}

/** Signed separation of two compass bearings, in (-180, 180]. */
export function bearingDelta(a: number, b: number): number {
  return ((a - b + 540) % 360) - 180;
}

/**
 * The course of the leg AT a point along it, rather than the bearing of the
 * whole chord. Over 2,500 miles a great circle's heading swings by tens of
 * degrees, and a job in Ohio has to be judged against where the truck is
 * pointing in Ohio.
 */
export function legCourseAt(origin: LatLng, destination: LatLng, f: number): number {
  return initialBearing(
    intermediatePoint(origin, destination, Math.max(0, f - 0.02)),
    intermediatePoint(origin, destination, Math.min(1, f + 0.02)),
  );
}

interface LatLng {
  lat: number;
  lng: number;
}

/**
 * G9b, in isolation. Is the job pointing roughly the way the truck is pointing?
 *
 * Belt to G9a's braces, and worth saying plainly: with `PROGRESS_EPSILON` in
 * place this test has not been observed to refuse a pair that strict forward
 * progress accepts -- a positive along-track gain is a positive along-course
 * displacement, so the two agree by construction almost everywhere. It is kept
 * because it is three lines, because it is what catches the clamped cases if
 * the epsilon is ever lowered or `alongTrackFraction` stops clamping, and
 * because it can be tested on its own, which it is. See .design/impl/
 * truck-stage4.md for the million-pair search behind that sentence.
 */
export function forwardBearingOk(
  origin: LatLng,
  destination: LatLng,
  pickup: LatLng,
  delivery: LatLng,
  pickupProgress: number,
): boolean {
  const delta = bearingDelta(
    initialBearing(pickup, delivery),
    legCourseAt(origin, destination, pickupProgress),
  );
  return Math.abs(delta) <= MAX_BEARING_DEG;
}

export function evaluateMatch(input: EvaluateInput): MatchVerdict {
  const { truck, job, today } = input;

  // --- 1..3: is this pair even a question? ----------------------------------
  if (truck.status !== "available" || truck.visibility !== "public") {
    return refuse("truck_not_available");
  }
  if (job.status !== "available") return refuse("job_not_available");
  if (truck.sender_key != null && truck.sender_key === job.sender_key) return refuse("same_party");
  if (truck.posted_by != null && truck.posted_by === job.posted_by) return refuse("same_party");

  // --- 4..6: coordinates, all three of them ---------------------------------
  //
  // Gate 6 requires the DELIVERY as well, which is the same demand
  // `corridorSearch` makes: without it there is no way to tell whether the job
  // carries the driver home or straight back the way they came.
  if (truck.origin_lat == null || truck.origin_lng == null) return refuse("no_truck_origin");
  if (job.pickup_lat == null || job.pickup_lng == null) return refuse("no_job_pickup");
  if (job.delivery_lat == null || job.delivery_lng == null) return refuse("no_job_delivery");

  const origin: LatLng = { lat: truck.origin_lat, lng: truck.origin_lng };
  const pickup: LatLng = { lat: job.pickup_lat, lng: job.pickup_lng };
  const delivery: LatLng = { lat: job.delivery_lat, lng: job.delivery_lng };
  const destination: LatLng | null =
    truck.dest_lat != null && truck.dest_lng != null
      ? { lat: truck.dest_lat, lng: truck.dest_lng }
      : null;

  const half =
    Number.isFinite(truck.corridor_miles) && truck.corridor_miles > 0
      ? truck.corridor_miles
      : DEFAULT_MATCH_CORRIDOR_MILES;

  const unknowns: Unknown[] = [];
  const originToPickup = haversineMiles(origin, pickup);

  let offRoute: number | null = null;
  let detour: number | null = null;
  let progress: number | null = null;
  let legMiles: number | null = null;

  // --- 7..10: geometry ------------------------------------------------------
  if (destination) {
    const fit = corridorMeasure(pickup, delivery, origin, destination);

    if (fit.offRoute > half) return refuse("pickup_off_corridor");
    if (fit.deliveryOffRoute > half * 2) return refuse("delivery_off_corridor");

    // G9a, stricter than the board's corridor search on purpose. A search row a
    // driver dismisses for free may be generous; a MATCH is a claim that costs
    // a phone call, so the delivery has to actually advance along the leg.
    if (!(fit.deliveryProgress > fit.pickupProgress + PROGRESS_EPSILON)) {
      return refuse("wrong_direction");
    }
    // G9b.
    if (!forwardBearingOk(origin, destination, pickup, delivery, fit.pickupProgress)) {
      return refuse("wrong_direction");
    }

    if (fit.detour > Math.min(half * 2, fit.legMiles * MAX_DETOUR_FRACTION)) {
      return refuse("detour_too_far");
    }

    offRoute = fit.offRoute;
    detour = fit.detour;
    progress = fit.pickupProgress;
    legMiles = fit.legMiles;
  } else {
    // Radius mode. A truck that never said where it is going has no direction
    // to test, and this refuses to invent one: the load is near where the
    // driver will be empty, which is a different and smaller claim. The circle
    // is never tighter than the corridor the driver themselves chose.
    if (originToPickup > Math.max(half, OPEN_TRUCK_RADIUS_MILES)) {
      return refuse("pickup_off_corridor");
    }
    unknowns.push("truck_destination");
  }

  // --- 11: size. Arithmetic, and a hard veto ---------------------------------
  //
  // HARD_TAG_VETOES (SPEC 11.6) ships empty and acceptance M13 asserts it stays
  // empty, so there is no service clause here to be dead code. The day a truck
  // genuinely cannot do a thing a job needs -- no lift gate, no shuttle -- this
  // is the gate it joins.
  const jobCf = job.cubic_feet;
  const freeCf = truck.free_cf;
  if (jobCf != null && freeCf != null && jobCf > freeCf) return refuse("too_big");
  if (jobCf == null) unknowns.push("job_size");
  if (freeCf == null) unknowns.push("truck_free_space");
  const fillPct = jobCf != null && freeCf != null && freeCf > 0 ? jobCf / freeCf : null;

  // --- 12..13: dates ---------------------------------------------------------
  let departFrom = truck.avail_now ? today : parseIso(truck.avail_from);
  let departTo = parseIso(truck.avail_to) ?? departFrom;
  let datesAssumed = false;
  if (departFrom == null) {
    // Either nothing was stated at all, or an end with no beginning ("free
    // until Friday"). Today is the only honest start and it is still a guess,
    // so it is recorded as one and the tier is capped for it.
    departFrom = today;
    departTo = departTo ?? today;
    unknowns.push("truck_depart_date");
    datesAssumed = true;
  }
  // A window that ends before it starts is not a window.
  departTo = laterOf(departTo ?? departFrom, departFrom);

  let readyFrom = job.ready_now ? today : parseIso(job.ready_date);
  if (readyFrom == null) {
    readyFrom = today;
    unknowns.push("job_ready_date");
  }

  // `deliver_by` NULL is the ABSENCE of a deadline, not an unknown fact. It
  // caps nothing and it is not in `unknowns` (acceptance M11).
  const deliverBy = parseIso(job.deliver_by);

  const carryMiles = job.road_miles ?? haversineMiles(pickup, delivery);
  const basis: MatchFacts["basis"] = job.road_miles != null ? "road" : "estimate";

  const toPickupDays = driveDays(originToPickup);
  const arriveEarliest = addDays(departFrom, toPickupDays);
  const arriveLatest = addDays(departTo, toPickupDays);

  // G12 -- "the truck has already gone past". A truck leaving Newark today and
  // a Philadelphia job whose freight is not ready for three weeks passes every
  // other test: clean corridor, capacity fits. Without this it scores Strong,
  // for freight that will not exist when the truck drives by.
  if (diffDays(readyFrom, arriveLatest) > 0) return refuse("not_ready_in_time");

  const loadDay = laterOf(arriveEarliest, readyFrom);
  const waitDays = Math.max(0, diffDays(readyFrom, arriveEarliest));
  const deliverDay = addDays(loadDay, driveDays(carryMiles));

  if (deliverBy != null && diffDays(deliverDay, deliverBy) > 0) return refuse("deadline_missed");
  const slackDays = deliverBy == null ? null : diffDays(deliverBy, deliverDay);

  // --- 14 -------------------------------------------------------------------
  if (input.dismissed) return refuse("dismissed");

  // A calendar built on an assumed departure is honest as a refusal and
  // dishonest as a promise, so the dates that RUN the gates above are not the
  // dates published for printing. Nothing downstream can render a day the
  // driver never stated.
  const publish = !datesAssumed;

  const facts: MatchFacts = {
    off_route_miles: offRoute,
    detour_miles: detour,
    route_progress: progress,
    leg_miles: legMiles,
    origin_to_pickup_miles: originToPickup,
    job_cf: jobCf,
    free_cf: freeCf,
    fill_pct: fillPct,
    load_day: publish ? isoOf(loadDay) : null,
    deliver_day: publish ? isoOf(deliverDay) : null,
    wait_days: publish ? waitDays : null,
    slack_days: publish ? slackDays : null,
    dates_assumed: datesAssumed,
    basis,
  };

  unknowns.sort((a, b) => UNKNOWN_ORDER.indexOf(a) - UNKNOWN_ORDER.indexOf(b));

  const tier =
    unknowns.length === 0 &&
    legMiles != null &&
    detour != null &&
    offRoute != null &&
    detour <= STRONG_DETOUR_FRACTION * legMiles &&
    offRoute <= STRONG_OFFROUTE_FRACTION * half
      ? "strong"
      : "possible";

  return {
    ok: true,
    tier,
    score: scoreOf(facts, unknowns, half, carryMiles),
    facts,
    unknowns,
    reasons: buildReasons(facts, unknowns),
    // Verbatim, and that is all it does: it never scores, never ranks, never
    // refuses. 17 of 98 jobs carry one repeated string and none carry a tag --
    // a ranking built on that would look meaningful and be noise (SPEC 11.6).
    requirements: job.requirements,
  };
}

/**
 * A weighted opinion, for ORDERING ONLY, never rendered.
 *
 * An unknown contributes ZERO to the fill penalty and instead costs a flat 5
 * through `unknowns.length`. Smearing it into a fabricated middle value would
 * put a guess into a ranking and let it beat a stated fact.
 */
function scoreOf(
  f: MatchFacts,
  unknowns: readonly Unknown[],
  half: number,
  carryMiles: number,
): number {
  const detourCap = f.leg_miles != null ? Math.min(half * 2, f.leg_miles * MAX_DETOUR_FRACTION) : 0;
  const detourTerm =
    f.detour_miles != null && detourCap > 0 ? Math.min(1, f.detour_miles / detourCap) : 0;
  const offRouteTerm = f.off_route_miles != null && half > 0 ? Math.min(1, f.off_route_miles / half) : 0;
  const fillPenalty = f.fill_pct == null ? 0 : 1 - Math.min(1, Math.max(0, f.fill_pct));
  const waitTerm = f.wait_days == null ? 0 : Math.min(1, f.wait_days / 3);
  const urgency = f.slack_days != null && f.slack_days < driveDays(carryMiles) ? 1 : 0;

  return (
    100 -
    45 * detourTerm -
    15 * offRouteTerm -
    20 * fillPenalty -
    10 * waitTerm -
    5 * urgency -
    5 * unknowns.length
  );
}
