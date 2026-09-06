/**
 * Extraction test cases.
 *
 * A rule-based extractor lives or dies on regression safety: every rule you add
 * to fix one message can quietly break three others. These cases are the
 * contract. Add one whenever you meet a message shape the rules get wrong, fix
 * the rule, and re-run `npm run eval`.
 *
 * `expect: null` means the message must produce NO loads. Getting those right
 * matters as much as extracting well -- a board full of "thanks!" and driver
 * availability posts is noise.
 *
 * Fields left undefined are not checked, so a case can assert only what it is
 * really about.
 *
 * The 14 freight-lane cases (pallets, reefers, airport codes) are gone: the
 * product is a moving-industry backhaul board and the real posts look nothing
 * like them. What remains are the negatives and the two lane cases that the
 * inventory-v1 rewrite keeps (rewritten as batch posts in the next step).
 */

export interface ExpectedLoad {
  pickup: string;
  delivery: string;
  /** Days from the message's send date: 0 = today, 1 = tomorrow. */
  dayOffset?: number;
  loadType?: string | null;
  weightLbs?: number | null;
  pallets?: number | null;
  rateUsd?: number | null;
  contact?: string | null;
  phoneEndsWith?: string;
}

export interface EvalCase {
  name: string;
  body: string;
  author?: string;
  authorPhone?: string;
  expect: ExpectedLoad[] | null;
}

export const CASES: EvalCase[] = [
  // -------------------------------------------------------------- not loads
  { name: "greeting", body: "Good morning everyone 🙏", expect: null },
  {
    name: "driver availability",
    body: "empty in Newark, looking for loads to the midwest",
    expect: null,
  },
  { name: "availability question", body: "still available?", expect: null },
  { name: "status reply", body: "taken", expect: null },
  { name: "thanks", body: "thanks!", expect: null },
  {
    name: "rate complaint",
    body: "these rates are too low man, nobody can run for that",
    expect: null,
  },
  {
    name: "group admin notice mentioning no lane",
    body: "Reminder: post rate and weight with every load please. No driver availability posts in this group.",
    expect: null,
  },
  { name: "no origin or destination", body: "load available call me", expect: null },
  {
    name: "single place is not a lane",
    body: "who has anything out of newark nj tomorrow",
    expect: null,
  },

  // ------------------------------------------------------------- edge cases
  {
    // A destination nobody can place is not a destination. Publishing
    // "Naples, FL -> north" would put an unsearchable load on the board.
    name: "unplaceable destination yields no load",
    body: "naples fl to somewhere up north tomorrow, 30k, hal 239-555-5757",
    expect: null,
  },
  {
    name: "kansas city must not resolve to kansas",
    body: "kansas city mo -> denver co friday, 20 pallets, 816-555-1000",
    expect: [{ pickup: "Kansas City, MO", delivery: "Denver, CO", pallets: 20 }],
  },
  {
    name: "west palm beach keeps its compass word",
    body: "west palm beach fl to orlando fl tomorrow 10 skids, 561-555-2222",
    expect: [
      { pickup: "West Palm Beach, FL", delivery: "Orlando, FL", dayOffset: 1, pallets: 10 },
    ],
  },
];
