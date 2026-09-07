/**
 * A seeded truck corpus, for the gates.
 *
 * There is no truck writer in the product yet -- the form is stage 2 and the
 * WhatsApp parser is stage 6 -- so the checks that need rows put them in
 * directly. That is deliberate rather than temporary scaffolding: these rows
 * exist to be adversarial, and a fixture written against the CHECKS carries
 * phone numbers in places a real posting form would never let a driver type.
 *
 * Every free-text column that a driver can write into carries a 555 number in a
 * DIFFERENT format, because `redactTruck` is a list of field names and the way
 * that list goes wrong is by omission. If a column is dropped from it, exactly
 * one of these formats survives into a payload and npm run check:redact says
 * which.
 *
 * Nothing here imports the extraction fixtures. `scripts/fixtures/real-whatsapp.ts`
 * and `scripts/score-fixture.ts` are frozen.
 */
import { query, queryOne } from "../../src/lib/db";

/** The five phone formats, spread across the five free-text columns. */
export const SEEDED_PHONES = {
  hyphen: "786-555-0128",
  dots: "786.555.0128",
  parens: "(201) 555-0199",
  bare: "7865550128",
  e164: "+17865550128",
} as const;

export type TruckSeed = Record<string, unknown>;

let allowedColumns: Set<string> | null = null;

/**
 * The table's own column list, read from the database rather than typed here.
 *
 * A fixture that names a column which no longer exists must fail loudly on the
 * name, not silently insert a row missing the field the check is about.
 */
async function columns(): Promise<Set<string>> {
  if (allowedColumns) return allowedColumns;
  const rows = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'trucks'`,
  );
  allowedColumns = new Set(rows.map((r) => r.column_name));
  return allowedColumns;
}

/**
 * Insert one truck and return its id.
 *
 * `sender_key` is a foreign key into `senders`, so a fixture that names a
 * sender gets one created for it -- the same shape the pipeline would have
 * written, minus everything the checks do not read.
 */
export async function insertTruck(seed: TruckSeed): Promise<number> {
  const allowed = await columns();
  const keys = Object.keys(seed);
  for (const k of keys) {
    if (!allowed.has(k)) throw new Error(`fixtures/trucks.ts: no such trucks column: ${k}`);
  }

  const senderKey = seed.sender_key as string | undefined;
  if (senderKey) {
    await query(`INSERT INTO senders (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`, [senderKey]);
  }

  const row = await queryOne<{ id: number }>(
    `INSERT INTO trucks (${keys.join(", ")})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})
     RETURNING id`,
    keys.map((k) => seed[k]),
  );
  return row!.id;
}

/** ISO date N days from `from`, in UTC -- fixtures do not need a timezone. */
export function isoDay(from: Date, days: number): string {
  const d = new Date(from.getTime() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * The corpus the redaction gate serialises.
 *
 * Six trucks covering every state a reader can be lied to about: everything
 * stated, no free space stated, no destination stated, a phone that arrived
 * from the sender rather than the post, a truck with no phone at all, and one
 * sitting in the review queue that must never leave the server.
 */
export function truckCorpus(now: Date): TruckSeed[] {
  const nowIso = now.toISOString();
  return [
    {
      origin_label: `Newark, NJ 07102 — yard gate code, ask for Ana ${SEEDED_PHONES.dots}`,
      origin_city: "Newark",
      origin_state: "NJ",
      origin_zip: "07102",
      origin_lat: 40.7357,
      origin_lng: -74.1724,
      origin_precision: "zip",
      dest_label: `Miami, FL 33101 — call ${SEEDED_PHONES.e164} on arrival`,
      dest_city: "Miami",
      dest_state: "FL",
      dest_zip: "33101",
      dest_lat: 25.7743,
      dest_lng: -80.1937,
      dest_precision: "zip",
      leg_miles: 1092,
      free_cf: 700,
      truck_cf: 1600,
      free_source: "stated",
      truck_text: `26 ft box truck ${SEEDED_PHONES.hyphen}`,
      avail_now: true,
      avail_from: isoDay(now, 0),
      avail_to: isoDay(now, 2),
      avail_source: "form",
      corridor_miles: 60,
      equipment: ["liftgate", "pads"],
      equipment_notes: `lift gate on the back, ask for Ana ${SEEDED_PHONES.dots}`,
      requirements: `COI on file before loading — call ${SEEDED_PHONES.parens}`,
      notes: `text me ${SEEDED_PHONES.bare}`,
      line_text: `empty NJ to FL Friday 700cf ${SEEDED_PHONES.e164}`,
      contact_name: "Marco",
      contact_phone: "+12015550199",
      contact_phone_raw: "(201) 555-0199",
      contact_phone_source: "post",
      sender_key: "phone:+12015550199",
      truck_key: "fixture-1",
      shape: "form",
      first_seen_at: nowIso,
      last_seen_at: nowIso,
      seen_count: 1,
    },
    {
      // No free space stated. "Space not stated", never 0 cf.
      origin_label: "Kearny, NJ 07032",
      origin_city: "Kearny",
      origin_state: "NJ",
      origin_zip: "07032",
      origin_lat: 40.7684,
      origin_lng: -74.1454,
      origin_precision: "zip",
      dest_label: "Atlanta, GA 30303",
      dest_city: "Atlanta",
      dest_state: "GA",
      dest_zip: "30303",
      dest_lat: 33.749,
      dest_lng: -84.388,
      dest_precision: "zip",
      leg_miles: 748,
      truck_text: "53 ft trailer",
      avail_from: isoDay(now, 1),
      avail_source: "form",
      corridor_miles: 100,
      contact_name: "Rosa Dispatch",
      contact_phone: "+19085557788",
      contact_phone_source: "sender",
      sender_key: "phone:+19085557788",
      truck_key: "fixture-2",
      shape: "form",
      first_seen_at: nowIso,
      last_seen_at: nowIso,
      seen_count: 1,
    },
    {
      // No destination stated. Never a centroid, never "Anywhere".
      origin_label: "Denver, CO 80202",
      origin_city: "Denver",
      origin_state: "CO",
      origin_zip: "80202",
      origin_lat: 39.7392,
      origin_lng: -104.9903,
      origin_precision: "zip",
      free_cf: 300,
      free_source: "stated",
      avail_now: true,
      avail_from: isoDay(now, 0),
      avail_source: "form",
      corridor_miles: 150,
      notes: "can go anywhere west",
      contact_name: "+1 (786) 555-0128",
      contact_phone: "+17865550128",
      contact_phone_source: "post",
      truck_key: "fixture-3",
      shape: "form",
      first_seen_at: nowIso,
      last_seen_at: nowIso,
      seen_count: 1,
    },
    {
      // No phone anywhere: has_phone must be false, and the contact gate must
      // have nothing to open.
      origin_label: "Charlotte, NC 28202",
      origin_city: "Charlotte",
      origin_state: "NC",
      origin_zip: "28202",
      origin_lat: 35.2271,
      origin_lng: -80.8431,
      origin_precision: "zip",
      dest_label: "Nashville, TN 37203",
      dest_city: "Nashville",
      dest_state: "TN",
      dest_zip: "37203",
      dest_lat: 36.1627,
      dest_lng: -86.7816,
      dest_precision: "zip",
      leg_miles: 330,
      free_cf: 450,
      free_source: "form",
      avail_from: isoDay(now, 3),
      avail_source: "form",
      corridor_miles: 60,
      truck_key: "fixture-4",
      shape: "form",
      first_seen_at: nowIso,
      last_seen_at: nowIso,
      seen_count: 1,
    },
    {
      // Booked: still on the board for a day with a struck-through badge, and
      // still phone-free on the wire.
      origin_label: "Boston, MA 02108",
      origin_city: "Boston",
      origin_state: "MA",
      origin_zip: "02108",
      origin_lat: 42.3581,
      origin_lng: -71.0636,
      origin_precision: "zip",
      dest_label: "Newark, NJ 07102",
      dest_city: "Newark",
      dest_state: "NJ",
      dest_zip: "07102",
      dest_lat: 40.7357,
      dest_lng: -74.1724,
      dest_precision: "zip",
      leg_miles: 205,
      free_cf: 900,
      free_source: "stated",
      status: "booked",
      status_source: "manual",
      avail_from: isoDay(now, 1),
      avail_source: "form",
      corridor_miles: 60,
      contact_phone: "+12015550111",
      contact_phone_source: "post",
      truck_key: "fixture-5",
      shape: "form",
      first_seen_at: nowIso,
      last_seen_at: nowIso,
      seen_count: 1,
    },
    {
      // THE ROW THAT MUST NOT LEAVE THE SERVER. Machine-invented, unreviewed,
      // and carrying a phone: 404 by id, absent from the board, for every
      // caller who is not an admin console.
      origin_label: `Dallas, TX 75201 — ${SEEDED_PHONES.hyphen}`,
      origin_city: "Dallas",
      origin_state: "TX",
      origin_zip: "75201",
      origin_lat: 32.7767,
      origin_lng: -96.797,
      origin_precision: "zip",
      free_cf: 1200,
      free_source: "empty_phrase",
      truck_text: `26 ft box truck available in Dallas ${SEEDED_PHONES.bare}`,
      visibility: "pending",
      needs_review: true,
      confidence: 0.4,
      flags: ["capacity_unstated", "no_destination"],
      supply_phrase: "going empty",
      shape: "C2",
      line_text: `going empty out of Dallas ${SEEDED_PHONES.parens}`,
      contact_name: "Unreviewed Sender",
      contact_phone: "+12145550164",
      contact_phone_raw: "214-555-0164",
      contact_phone_source: "sender",
      corridor_miles: 60,
      avail_from: isoDay(now, 1),
      avail_source: "line",
      truck_key: "fixture-6",
      first_seen_at: nowIso,
      last_seen_at: nowIso,
      seen_count: 1,
    },
  ];
}

/** Seed the corpus and return the ids, in the order above. */
export async function seedTrucks(now: Date = new Date()): Promise<number[]> {
  const ids: number[] = [];
  for (const seed of truckCorpus(now)) ids.push(await insertTruck(seed));
  return ids;
}
