/**
 * Rule-based load extraction.
 *
 * The pipeline runs on deterministic rules -- no model, no API cost, no
 * per-message latency. That is workable because freight posts are formulaic:
 * an origin, a destination, a date, a phone number, and some cargo detail, in
 * almost any order.
 *
 * The design that makes it hold up is in two other modules:
 *   - spans.ts   claims typed facts (phones, money, weights, dates, equipment)
 *                and masks them, so numbers cannot be mistaken for ZIP codes
 *                and dates cannot be mistaken for place names.
 *   - geo/match.ts resolves places by dictionary lookup rather than by parsing,
 *                so "las vegas nv this week" yields a place because the
 *                gazetteer recognizes one, not because we guessed at grammar.
 *
 * What is left here is assembly: which place is the origin, which is the
 * destination, how many loads a message describes, and how much to trust it.
 */
import { matchPlaces, type PlaceMatch } from "@/lib/geo/match";
import { scanMessage, type MessageScan } from "./spans";
import type { MessageContext } from "./schema";

/**
 * The v1 freight-lane shape this file emits.
 *
 * Deliberately local rather than `ExtractedJob` from ./schema: this extractor
 * is scheduled for deletion in Phase 0b, and `src/lib/extract/index.ts` adapts
 * its output to the inventory-v1 contract meanwhile. Nothing new should be
 * written against these types.
 */
export interface LegacyLoad {
  pickup_location: string;
  delivery_location: string;
  pickup_address: string | null;
  delivery_address: string | null;
  pickup_date_text: string | null;
  pickup_date_iso: string | null;
  pickup_time_text: string | null;
  delivery_date_text: string | null;
  load_type: string | null;
  weight_lbs: number | null;
  pallets: number | null;
  pieces: number | null;
  rate_usd: number | null;
  contact_name: string | null;
  contact_phone: string | null;
  notes: string | null;
  confidence: number;
}

export interface LegacyOutcome {
  is_load_post: boolean;
  reason: string | null;
  loads: LegacyLoad[];
  extractor: string;
}

/** Messages that are clearly not offering freight. */
const NOT_A_LOAD: Array<[RegExp, string]> = [
  [/\b(empty|mt)\b[^.]{0,20}\b(in|at|near|around)\b/i, "driver availability"],
  [/\blooking for (a |any )?(load|loads|freight|work)\b/i, "driver availability"],
  [/\b(need|want)s? (a )?(load|loads|freight)\b/i, "driver availability"],
  [/\bavailable (truck|driver|van|trailer|sprinter)\b/i, "driver availability"],
  [/\b(truck|driver|van) available\b/i, "driver availability"],
  [/^(thanks?|thank you|ok|okay|yes|no|got it|copy|noted|gracias|good morning|good evening|hello|hi)\b/i, "chatter"],
  [/\b(still available|is it (still )?open|any update)\s*\??$/i, "chatter"],
  [/^(taken|covered|gone|booked|done|sold)\s*[.!]?$/i, "status reply"],
  [/\bwho (has|got|needs)\b/i, "chatter"],
  [/\b(rate|rates|prices?) (is|are|too)\b/i, "rate discussion"],
];

/** Split a message into candidate lanes. One post often lists several. */
function segments(body: string): string[] {
  return body
    .split(/[\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function extractWithRules(ctx: MessageContext): LegacyOutcome {
  const body = ctx.body.trim();

  for (const [re, reason] of NOT_A_LOAD) {
    if (re.test(body)) {
      return { is_load_post: false, reason, loads: [], extractor: "rules" };
    }
  }

  // Message-level facts. A multi-lane post states the date and the callback
  // number once, at the top or the bottom, and every lane inherits them.
  const whole = scanMessage(body);
  const shared = {
    date: whole.dates[0]?.text ?? null,
    time: whole.times[0]?.text ?? null,
    phone: whole.phones[0] ?? ctx.authorPhone ?? null,
    contact: whole.contactName ?? ctx.authorName ?? null,
    equipment: whole.equipment[0]?.type ?? null,
    rate: whole.rateUsd,
    quantities: whole.quantities,
  };

  const lines = segments(body);
  const loads: LegacyLoad[] = [];

  for (const line of lines) {
    const scan = scanMessage(line);
    const places = matchPlaces(scan.tokens);
    const lane = resolveLane(scan, places);
    if (!lane) continue;

    // A lane inherits shared facts only where its own line is silent.
    const equipment = scan.equipment[0]?.type ?? null;
    const quantities = scan.quantities;

    loads.push({
      pickup_location: lane.pickup.canonical,
      delivery_location: lane.delivery.canonical,
      pickup_address: null,
      delivery_address: null,
      pickup_date_text: scan.dates[0]?.text ?? shared.date,
      pickup_date_iso: null,
      pickup_time_text: scan.times[0]?.text ?? (lines.length === 1 ? shared.time : null),
      delivery_date_text: scan.dates[1]?.text ?? null,
      load_type: equipment ?? (lines.length === 1 ? shared.equipment : null),
      weight_lbs: quantities.weightLbs ?? (lines.length === 1 ? shared.quantities.weightLbs : null),
      pallets: quantities.pallets ?? (lines.length === 1 ? shared.quantities.pallets : null),
      pieces: quantities.pieces ?? (lines.length === 1 ? shared.quantities.pieces : null),
      rate_usd: scan.rateUsd ?? (lines.length === 1 ? shared.rate : null),
      contact_name: scan.contactName ?? nameBesidePhone(scan, places) ?? shared.contact,
      contact_phone: scan.phones[0] ?? shared.phone,
      notes: null,
      confidence: score(lane, scan, shared.date),
    });
  }

  if (!loads.length) {
    return {
      is_load_post: false,
      reason: "no origin and destination found",
      loads: [],
      extractor: "rules",
    };
  }

  return { is_load_post: true, reason: null, loads, extractor: "rules" };
}

interface Lane {
  pickup: PlaceMatch;
  delivery: PlaceMatch;
  /** How the direction was established -- drives the confidence score. */
  basis: "marker" | "arrow" | "order";
}

/**
 * Decide which place is the origin and which is the destination.
 *
 * Direction is the one thing a load board cannot afford to get wrong, so it is
 * taken from explicit evidence wherever any exists, and only inferred from
 * reading order as a last resort.
 */
function resolveLane(scan: MessageScan, places: PlaceMatch[]): Lane | null {
  if (places.length < 2) return null;

  // 1. Explicit markers: "pickup Newark, delivery Pittsburgh".
  const pickupMarker = scan.markers.find((m) => m.role === "pickup");
  const deliveryMarker = scan.markers.find((m) => m.role === "delivery");
  if (pickupMarker && deliveryMarker) {
    const pickup = firstPlaceAfter(places, pickupMarker.at);
    const delivery = firstPlaceAfter(places, deliveryMarker.at);
    if (pickup && delivery && pickup !== delivery) {
      return { pickup, delivery, basis: "marker" };
    }
  }

  // 2. A route arrow or a "to" separator.
  const split = [...scan.arrows, ...scan.separators].sort((a, b) => a - b)[0];
  if (split != null) {
    const before = places.filter((p) => p.end <= split);
    const after = places.filter((p) => p.start >= split);
    // Nearest place on each side of the separator, which handles
    // "urgent load newark nj -> boston ma tomorrow" cleanly.
    const pickup = before[before.length - 1];
    const delivery = after[0];
    if (pickup && delivery) return { pickup, delivery, basis: "arrow" };
  }

  // 3. Fall back to reading order.
  return { pickup: places[0], delivery: places[1], basis: "order" };
}

function firstPlaceAfter(places: PlaceMatch[], index: number): PlaceMatch | undefined {
  return places.find((p) => p.start >= index);
}

/**
 * "…flatbed, iris 502-555-6868" -- the contact is very often just a first name
 * parked next to the number, with no "call" in front of it. Only words that
 * survived span extraction and sit outside every matched place qualify, which
 * keeps "richmond va 804-555-6655" from nominating Richmond as the contact.
 */
function nameBesidePhone(scan: MessageScan, places: PlaceMatch[]): string | null {
  const insidePlace = (i: number) => places.some((p) => i >= p.start && i < p.end);

  for (const at of scan.phoneAt) {
    for (const i of [at - 1, at + 1]) {
      if (i < 0 || i >= scan.raw.length) continue;
      if (insidePlace(i)) continue;
      // A token still present in `tokens` was not claimed as a date, quantity,
      // equipment type or separator.
      if (scan.tokens[i] !== scan.raw[i]) continue;

      const word = scan.raw[i].replace(/[^a-z]/g, "");
      if (word.length < 2 || word.length > 15) continue;
      if (NOT_A_CONTACT.has(word)) continue;
      return word.charAt(0).toUpperCase() + word.slice(1);
    }
  }
  return null;
}

/** Words that can sit beside a phone number without being anyone's name. */
const NOT_A_CONTACT = new Set(
  ("me us him her them dispatch dispatcher driver owner broker asap now today tomorrow " +
    "anytime the my our back soon later direct cell mobile office phone tel call text " +
    "load loads freight truck van reefer flatbed sprinter pallets plts lbs and or " +
    // Commodities sit next to the phone number as often as names do:
    // "3 pallets furniture, 845-555-4455".
    "furniture produce food foods steel lumber machinery electronics paper tires " +
    "beverages groceries appliances plastics chemicals textiles frozen dry general " +
    "misc other stuff goods cargo material materials parts equipment")
    .split(" "),
);

/**
 * Confidence, 0..1. Loads below 0.5 are flagged for review in the pipeline, so
 * this is the dial that decides what a human looks at.
 */
function score(lane: Lane, scan: MessageScan, sharedDate: string | null): number {
  let c = 0.3;

  // Direction evidence is the most important signal.
  if (lane.basis === "marker") c += 0.22;
  else if (lane.basis === "arrow") c += 0.2;
  else c += 0.04;

  c += specificity(lane.pickup) * 0.16;
  c += specificity(lane.delivery) * 0.12;

  if (scan.dates.length || sharedDate) c += 0.14;
  if (scan.phones.length) c += 0.08;
  if (scan.equipment.length) c += 0.04;
  if (scan.quantities.weightLbs || scan.quantities.pallets || scan.quantities.pieces) c += 0.04;

  return Math.min(Math.round(c * 100) / 100, 0.97);
}

/** 0..1 by how precisely the place was pinned. */
function specificity(place: PlaceMatch): number {
  switch (place.kind) {
    case "city_state_zip":
      return 1;
    case "city_state":
      return 0.9;
    case "city_state_guess":
      return 0.45;
    case "zip":
      return 0.85;
    case "alias":
      return 0.8;
    case "city":
      return 0.6;
    case "region":
      return 0.3;
    case "state":
      return 0.2;
  }
}
