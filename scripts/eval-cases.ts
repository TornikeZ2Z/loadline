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
  // ---------------------------------------------------------------- basics
  {
    name: "arrow lane with markers and pallets",
    body: "Tomorrow NJ → PA, pickup Newark, delivery Pittsburgh, 2 pallets, call Peter 973-555-1234",
    expect: [
      {
        pickup: "Newark, NJ",
        delivery: "Pittsburgh, PA",
        dayOffset: 1,
        pallets: 2,
        contact: "Peter",
        phoneEndsWith: "5551234",
      },
    ],
  },
  {
    name: "third party named as contact",
    body: "Peter has a load tomorrow from Newark going to Boston. Pickup around 10. Call 973-555-1234.",
    expect: [{ pickup: "Newark, NJ", delivery: "Boston, MA", dayOffset: 1, contact: "Peter" }],
  },
  {
    name: "nickname origin, rate and weight",
    body: "Need someone for Philly to Miami tomorrow. 44,000 lbs dry van. $3200. Rosa 908-555-7788",
    expect: [
      {
        pickup: "Philadelphia, PA",
        delivery: "Miami, FL",
        dayOffset: 1,
        weightLbs: 44000,
        loadType: "dry van",
        rateUsd: 3200,
      },
    ],
  },
  {
    name: "zip codes on both ends, lowercase",
    body: "elizabeth nj 07201 -> charlotte nc 28202 today after 2pm, 18 pallets, 38k lbs, call mike 215-555-9090",
    expect: [
      {
        pickup: "Elizabeth, NJ 07201",
        delivery: "Charlotte, NC 28202",
        dayOffset: 0,
        pallets: 18,
        weightLbs: 38000,
        contact: "Mike",
      },
    ],
  },
  {
    name: "airport codes",
    body: "EWR to ORD tmrw morning, 53' van, 40000lbs. 718-555-2211",
    expect: [{ pickup: "Newark, NJ", delivery: "Chicago, IL", dayOffset: 1, weightLbs: 40000 }],
  },

  // ------------------------------------------------------------ multi-lane
  {
    name: "three lanes sharing one date and phone",
    body: "3 loads all tmrw, call me 267-555-8833:\nnewark -> boston 12 plts\nedison nj -> pitt 44k lbs\ncarteret -> richmond va reefer",
    expect: [
      { pickup: "Newark, NJ", delivery: "Boston, MA", dayOffset: 1, pallets: 12 },
      { pickup: "Edison, NJ", delivery: "Pittsburgh, PA", dayOffset: 1, weightLbs: 44000 },
      { pickup: "Carteret, NJ", delivery: "Richmond, VA", dayOffset: 1, loadType: "reefer" },
    ],
  },
  {
    name: "equipment must not leak between lanes",
    body: "2 loads tmrw call sasha 862-555-0102:\nnewark nj -> raleigh nc 18 plts\nelizabeth nj -> jax fl reefer 40k lbs",
    expect: [
      { pickup: "Newark, NJ", delivery: "Raleigh, NC", pallets: 18, loadType: null },
      { pickup: "Elizabeth, NJ", delivery: "Jacksonville, FL", loadType: "reefer", weightLbs: 40000 },
    ],
  },

  // ------------------------------------------------------------- informal
  {
    name: "regional origin, weekday date",
    body: "north jersey to south florida, pickup mon, 22 pallets, reefer preferred. Tony 856-555-3311",
    expect: [{ pickup: "Tri-State Area", delivery: "Miami, FL", pallets: 22, loadType: "reefer" }],
  },
  {
    name: "nicknames on both ends, trailing detail",
    body: "socal to phx wednesday, produce, 42000 lbs, temp 34F. Carlos 305-555-9988",
    expect: [{ pickup: "Los Angeles, CA", delivery: "Phoenix, AZ", weightLbs: 42000 }],
  },
  {
    name: "nickname plus its own state",
    body: "newark nj -> atl ga tomorrow, call vera 973-555-0199",
    expect: [{ pickup: "Newark, NJ", delivery: "Atlanta, GA", dayOffset: 1, contact: "Vera" }],
  },
  {
    name: "dash separator, no arrow",
    body: "louisville ky - cincinnati oh 10/12 22 tons flatbed, iris 502-555-6868",
    expect: [
      {
        pickup: "Louisville, KY",
        delivery: "Cincinnati, OH",
        weightLbs: 44000,
        loadType: "flatbed",
        contact: "Iris",
      },
    ],
  },
  {
    name: "trailing date must not swallow the destination",
    body: "stockton ca -> las vegas nv this week reefer 44000, emin 209-555-3535",
    expect: [
      { pickup: "Stockton, CA", delivery: "Las Vegas, NV", loadType: "reefer", weightLbs: 44000 },
    ],
  },
  {
    name: "weight of five digits must not be read as a zip",
    body: "houston tx to new orleans la tomorrow, 44000 lbs, gita 713-555-6565",
    expect: [
      { pickup: "Houston, TX", delivery: "New Orleans, LA", dayOffset: 1, weightLbs: 44000 },
    ],
  },
  {
    name: "the city alias",
    body: "the city to lakewood nj today, 3 pallets furniture, 845-555-4455",
    expect: [{ pickup: "New York, NY", delivery: "Lakewood, NJ", dayOffset: 0, pallets: 3 }],
  },

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
