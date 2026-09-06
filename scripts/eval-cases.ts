/**
 * Extraction test cases (inventory-v1).
 *
 * A rule-based extractor lives or dies on regression safety: every rule you add
 * to fix one message can quietly break three others. These cases are the
 * contract. Add one whenever you meet a message shape the rules get wrong, fix
 * the rule, and re-run `npm run eval`.
 *
 * Three kinds of case:
 *   - the six REAL messages (scripts/fixtures/real-whatsapp.ts), turned into
 *     expectations by `realMessageCases()` -- never hand-copied, so the eval
 *     and `npm run score` can never disagree about the ground truth;
 *   - variants of the real shapes that the adversary review found (A §4);
 *   - negatives: chatter, requirements, capacity offers that must yield NO job.
 *
 * Fields left undefined are not checked, so a case can assert only what it is
 * really about. `expect: null` means the message must produce no jobs.
 */
import { REAL_MESSAGES } from "./fixtures/real-whatsapp";

export interface ExpectedJob {
  origin: string;
  dest: string;
  cf: number | null;
  pricePerCf?: number | null;
  priceFlat?: number | null;
  ready?: boolean;
  /** ISO date */
  readyDate?: string;
  readySource?: string;
  tags?: string[];
  notesIncludes?: string;
  flagsInclude?: string[];
}

export interface EvalCase {
  name: string;
  body: string;
  author?: string;
  authorPhone?: string | null;
  sentAt?: string;
  expect: ExpectedJob[] | null;
  expectFlags?: string[];
  expectNotFlags?: string[];
  expectContact?: { name?: string; phoneEndsWith?: string };
  expectRequirements?: number;
  /** Minimum number of fully-correct jobs (a ratchet; defaults to expect.length). */
  baseline?: number;
}

export const EVAL_SENT_AT = "2026-09-06T15:00:00Z";

/** The six real messages, as eval cases. */
export function realMessageCases(): EvalCase[] {
  return REAL_MESSAGES.map((m) => {
    const letter = m.format[0];
    const jobs: ExpectedJob[] = m.expected.flatMap((o) =>
      o.jobs.map(([dest, cf, flag]) => {
        const e: ExpectedJob = { origin: o.origin, dest, cf };
        const f = flag ?? "";
        const price = f.match(/\$(\d+(?:\.\d+)?)\/cf/);
        if (price) e.pricePerCf = Number(price[1]);
        const tags: string[] = [];
        if (/\bbulky\b/i.test(f)) tags.push("bulky");
        if (/\burgent\b/i.test(f)) tags.push("urgent");
        if (/\bhot tub\b/i.test(f)) tags.push("hot_tub");
        if (tags.length) e.tags = tags;
        const date = f.match(/\b(\d{1,2})\/(\d{1,2})\b/);
        if (date) {
          e.readyDate = `2026-${date[1].padStart(2, "0")}-${date[2].padStart(2, "0")}`;
          e.ready = false;
        } else if (/\bRFD\b/.test(f)) {
          e.ready = true;
        }
        // Message-level rules.
        if (letter === "A" || letter === "B" || letter === "C") e.ready = true;
        if (letter === "D" && !flag) e.ready = false;
        if (letter === "E" || letter === "F") {
          e.ready = true;
          e.readySource = "assumed";
        }
        return e;
      }),
    );
    const contact: EvalCase["expectContact"] =
      letter === "A" ? { phoneEndsWith: "0100" }
      : letter === "B" ? { name: "Dispatch (unnamed)" }
      : letter === "C" ? { name: "Marco", phoneEndsWith: "0199" }
      : letter === "D" ? { phoneEndsWith: "0188" }
      : { name: "Victor", phoneEndsWith: "0128" };
    return {
      name: `real ${m.format}`,
      body: m.body,
      author: m.author,
      authorPhone: m.authorPhone,
      sentAt: EVAL_SENT_AT,
      expect: jobs,
      expectContact: contact,
      expectFlags: letter === "D" ? ["truncated_tail"] : letter === "B" ? ["no_contact"] : undefined,
      expectRequirements: letter === "C" || letter === "E" || letter === "F" ? 1 : 0,
      baseline: jobs.length,
    };
  });
}

export const CASES: EvalCase[] = [
  // ------------------------------------------------------------ rewritten
  {
    name: "kansas city must not resolve to kansas",
    body: "From Kansas City MO\nTo CO 80202 300cf",
    expect: [{ origin: "Kansas City, MO", dest: "CO 80202", cf: 300 }],
  },
  {
    name: "west palm beach keeps its compass word",
    body: "FROM WEST PALM BEACH FL:\n200 - GA 30303",
    expect: [{ origin: "West Palm Beach, FL", dest: "GA 30303", cf: 200 }],
  },

  // ------------------------------------------------------------- variants
  {
    name: "v1 FROM LA is Los Angeles",
    body: "FROM LA\nTo FL 33435 350cf",
    expect: [{ origin: "Los Angeles, CA", dest: "FL 33435", cf: 350 }],
  },
  {
    name: "v2 state glued to the city with a colon",
    body: "FROM DENVER CO:\n300 - MI 48341",
    expect: [{ origin: "Denver, CO", dest: "MI 48341", cf: 300 }],
  },
  {
    name: "v3 kansas city / new york blocks",
    body: "From Kansas City MO\nTo CO 80202 300cf\n\nFrom New York\nTo FL 33435 200cf",
    expect: [
      { origin: "Kansas City, MO", dest: "CO 80202", cf: 300 },
      { origin: "New York, NY", dest: "FL 33435", cf: 200 },
    ],
  },
  {
    name: "v4 thousands separators in cf and price",
    body: "From Newark NJ\nNY 11217 1,200\nFL 33435 800 $1,500",
    expect: [
      { origin: "Newark, NJ", dest: "NY 11217", cf: 1200 },
      { origin: "Newark, NJ", dest: "FL 33435", cf: 800, priceFlat: 1500, pricePerCf: null },
    ],
  },
  {
    name: "v5 numbered list",
    body: "From Newark NJ\n10. FL 33435 350\n11. GA 30303 400cf",
    expect: [
      { origin: "Newark, NJ", dest: "FL 33435", cf: 350 },
      { origin: "Newark, NJ", dest: "GA 30303", cf: 400 },
    ],
  },
  {
    name: "v6 annotated headers: count, street address, phone",
    body: "FROM PHOENIX AZ (3 JOBS):\nFL 33435 350cf\nFrom 45 Schuyler Ave Kearny NJ 07032 call 201-555-0199\nGA 30303 400cf",
    author: "Tester",
    authorPhone: null,
    expect: [
      { origin: "Phoenix, AZ", dest: "FL 33435", cf: 350 },
      { origin: "Kearny, NJ 07032", dest: "GA 30303", cf: 400 },
    ],
    expectContact: { phoneEndsWith: "0199" },
  },
  {
    name: "v7 northern virginia ZIPs are not DC",
    body: "From Sterling VA 20166\nTo VA 20132 200cf\nTo DC 20001 300cf",
    expect: [
      { origin: "Sterling, VA 20166", dest: "VA 20132", cf: 200 },
      { origin: "Sterling, VA 20166", dest: "DC 20001", cf: 300 },
    ],
    expectNotFlags: ["zip_state_mismatch"],
  },
  {
    name: "v8 block state is not single-use",
    body: "OHIO\n📍 Columbus\nFL 33435 300cf\n📍 Springfield\nGA 30303 400cf",
    expect: [
      { origin: "Columbus, OH", dest: "FL 33435", cf: 300 },
      { origin: "Springfield, OH", dest: "GA 30303", cf: 400 },
    ],
  },
  {
    name: "v9 lanes, with and without FROM",
    body: "Newark NJ -> Miami FL 33101 350cf\nFrom Cortez CO 81321 To NM 87825 250cf\nTo FL 33435 350cf",
    expect: [
      { origin: "Newark, NJ", dest: "FL 33101", cf: 350 },
      { origin: "Cortez, CO 81321", dest: "NM 87825", cf: 250 },
      { origin: "Cortez, CO 81321", dest: "FL 33435", cf: 350 },
    ],
  },
  {
    name: "v10 capacity line, cf-less destination, truncated tail",
    body: "From Boston MA 02132\nTo FL 33435 350cf\nTo FL 33180 200cf\nNeed 400cf to go to FL\nOrlando FL 32801\nTo:IA 600 c/f",
    expect: [
      { origin: "Boston, MA 02132", dest: "FL 33435", cf: 350 },
      { origin: "Boston, MA 02132", dest: "FL 33180", cf: 200 },
      { origin: "Boston, MA 02132", dest: "FL 32801", cf: null, flagsInclude: ["cfless_destination"] },
    ],
    expectFlags: ["truncated_tail"],
  },
  {
    name: "bare headers with a comma and with a ZIP",
    body: "Toledo, OH\nFL 33435 300cf\n\nPueblo CO 81003\nGA 30303 400cf",
    expect: [
      { origin: "Toledo, OH", dest: "FL 33435", cf: 300 },
      { origin: "Pueblo, CO 81003", dest: "GA 30303", cf: 400 },
    ],
  },
  {
    name: "weight is not cubic feet",
    body: "From Newark NJ\nFL 33435 3000 lbs",
    expect: [{ origin: "Newark, NJ", dest: "FL 33435", cf: null, flagsInclude: ["needs_review"] }],
  },
  {
    name: "LA without a ZIP is Louisiana, flagged",
    body: "From Newark NJ\nTo LA 350cf",
    expect: [{ origin: "Newark, NJ", dest: "LA", cf: 350, flagsInclude: ["ambiguous_la"] }],
  },
  {
    name: "two identical lines are two jobs",
    body: "From Kearny NJ\n200cf FL 33180 RFD\n200cf FL 33180 RFD",
    expect: [
      { origin: "Kearny, NJ", dest: "FL 33180", cf: 200, ready: true },
      { origin: "Kearny, NJ", dest: "FL 33180", cf: 200, ready: true },
    ],
  },
  {
    name: "an insurance minimum is not a destination",
    body: "FROM NEWARK NJ\nFL 33101 350cf\nCargo insurance 25000 required",
    expect: [{ origin: "Newark, NJ", dest: "FL 33101", cf: 350 }],
    expectRequirements: 1,
  },
  {
    name: "an MC or DOT number is not a destination",
    body: "FROM NEWARK NJ\nFL 33101 350cf\nMust have DOT 12345\nMC# 45678",
    expect: [{ origin: "Newark, NJ", dest: "FL 33101", cf: 350 }],
  },
  {
    name: "a payment note with five digits is not a destination",
    body: "FROM NEWARK NJ\nFL 33101 350cf\nZelle only 12345",
    expect: [{ origin: "Newark, NJ", dest: "FL 33101", cf: 350 }],
  },
  {
    name: "a city with a ZIP and no written state is still a destination",
    body: "From Kearny NJ\nFL 33435 350cf\nMiami 33101",
    expect: [
      { origin: "Kearny, NJ", dest: "FL 33435", cf: 350 },
      { origin: "Kearny, NJ", dest: "FL 33101", cf: null, flagsInclude: ["cfless_destination"] },
    ],
  },
  {
    name: "stacked FROM markers stay out of the origin city",
    body: "Loading out of Houston TX 77002\nAustin TX 78701 250 cf",
    expect: [{ origin: "Houston, TX 77002", dest: "TX 78701", cf: 250 }],
  },
  {
    name: "a marker tail of connector words never becomes the city",
    body: "Loading up in Houston TX 77002\nAustin TX 78701 250 cf",
    expect: [{ origin: "Houston, TX 77002", dest: "TX 78701", cf: 250 }],
  },
  {
    name: "a real leading place word after FROM survives",
    body: "From Warehouse District, Houston TX 77002\nAustin TX 78701 250 cf",
    expect: [{ origin: "Warehouse District, TX 77002", dest: "TX 78701", cf: 250 }],
  },
  {
    name: "two destinations on one line are never two jobs to the first",
    body: "FROM DALLAS TX\nNC 28202 250 cf + SC 29201 180 cf",
    expect: null,
    expectFlags: ["two_places"],
  },
  {
    name: "two destinations on one line, cf written first",
    body: "FROM DALLAS TX\n400cf FL 33101, 300cf GA 30303",
    expect: null,
    expectFlags: ["two_places"],
  },
  {
    name: "two destinations concatenated with no separator",
    body: "FROM KEARNY NJ\nFL 33101 400 cf GA 30303 300 cf",
    expect: null,
    expectFlags: ["two_places"],
  },
  {
    name: "two cf figures for one destination are still two jobs",
    body: "FROM DALLAS TX\nNC 28202 250 cf + 180 cf",
    expect: [
      { origin: "Dallas, TX", dest: "NC 28202", cf: 250 },
      { origin: "Dallas, TX", dest: "NC 28202", cf: 180 },
    ],
  },
  {
    name: "x2 multiplier still repeats the same destination",
    body: "FROM DALLAS TX\nNC 28202 250 cf x2",
    expect: [
      { origin: "Dallas, TX", dest: "NC 28202", cf: 250 },
      { origin: "Dallas, TX", dest: "NC 28202", cf: 250 },
    ],
  },
  {
    name: "deadline word makes a deliver-by date",
    body: "From Kearny NJ\nFL 33435 350cf deliver by 9/12",
    expect: [{ origin: "Kearny, NJ", dest: "FL 33435", cf: 350 }],
    expectNotFlags: ["truncated_tail"],
  },
  {
    name: "continuation lines attach to the destination above",
    body: "Pickup: Kearny NJ\nDelivery: Miami FL 33101\n350 cf\nRFD",
    expect: [{ origin: "Kearny, NJ", dest: "FL 33101", cf: 350, ready: true }],
  },

  // -------------------------------------------------------------- not loads
  { name: "greeting", body: "Good morning everyone 🙏", expect: null },
  { name: "driver availability", body: "empty in Newark, looking for loads to the midwest", expect: null },
  { name: "availability question", body: "still available?", expect: null },
  { name: "status reply", body: "taken", expect: null },
  { name: "thanks", body: "thanks!", expect: null },
  { name: "rate complaint", body: "these rates are too low man, nobody can run for that", expect: null },
  {
    name: "group admin notice mentioning no lane",
    body: "Reminder: post rate and weight with every load please. No driver availability posts in this group.",
    expect: null,
  },
  { name: "no origin or destination", body: "load available call me", expect: null },
  { name: "single place is not a lane", body: "who has anything out of newark nj tomorrow", expect: null },
  {
    name: "unplaceable destination yields no load",
    body: "naples fl to somewhere up north tomorrow, 30k, hal 239-555-5757",
    expect: null,
  },
  { name: "neg HI ALL", body: "HI ALL", expect: null },
  { name: "neg CASH OR ZELLE", body: "CASH OR ZELLE", expect: null },
  { name: "neg NO BROKERS OR DOUBLE BROKERING", body: "NO BROKERS OR DOUBLE BROKERING", expect: null },
  { name: "neg MESSAGE IN PRIVATE.", body: "MESSAGE IN PRIVATE.", expect: null },
  { name: "neg MIN 500 CF TO BOOK", body: "MIN 500 CF TO BOOK", expect: null },
  {
    name: "neg all five chatter lines together",
    body: "HI ALL\nCASH OR ZELLE\nNO BROKERS OR DOUBLE BROKERING\nMESSAGE IN PRIVATE.\nMIN 500 CF TO BOOK",
    expect: null,
  },
  {
    name: "chatter lines never change the running origin",
    body: "From Kearny NJ\nHI ALL\nCASH OR ZELLE\nFL 33435 350cf",
    expect: [{ origin: "Kearny, NJ", dest: "FL 33435", cf: 350 }],
  },
  {
    name: "unknown format: ZIP/CF pairs on one line",
    body: "33435/350, 33180/200",
    expect: null,
    expectFlags: ["unknown_format"],
  },
];
