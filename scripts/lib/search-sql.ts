/**
 * Print, verbatim, every SQL statement `searchLoads` builds for a fixed set of
 * searches. Stdout is the T-A1 snapshot; `check-equivalence.ts` runs this file
 * in a child process and compares the bytes.
 *
 * Nothing is reimplemented here. `DATABASE_URL` is set so `src/lib/db.ts` takes
 * its `pg` branch, and the bare specifier `pg` is resolved to `pg-tap.mjs`
 * (see `pg-tap-hooks.mjs`), which records statements and answers with no rows.
 * So the statements below are the ones the shipped code would send to
 * Postgres -- not a transcription of them.
 *
 * The one substitution: today's date, which `localToday()` binds into the
 * readiness filter and the summary, is printed as <TODAY>. Everything else is
 * byte-for-byte what the driver was handed, bind values included -- a builder
 * that changed a LIKE pattern or a state expansion without changing a single
 * character of SQL would still be caught.
 */
process.env.DATABASE_URL = "postgres://pg-tap/none";
process.env.TZ ??= "America/New_York";

import { register } from "node:module";

register("./pg-tap-hooks.mjs", import.meta.url);

const { RECORDED, reset } = await import("./pg-tap.mjs");
const { searchLoads } = await import("../../src/lib/loads/query");
const { DEFAULT_TZ } = await import("../../src/lib/extract/dates");

type Params = Parameters<typeof searchLoads>[0];

/** The board's own calendar day -- the value `localToday()` binds. */
const TODAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: DEFAULT_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

const NEWARK = { lat: 40.7357, lng: -74.1724, label: "Newark, NJ", precision: "city" };
const MIAMI = { lat: 25.7617, lng: -80.1918, label: "Miami, FL", precision: "city" };

/**
 * Chosen so that every fragment builder that moves in this stage is exercised
 * at least twice, in different callers: `distanceSql` (as a select column and
 * inside a radius), `radiusClause` at both ends, `boundsClause` (through
 * `eitherEndInBounds` and through the corridor prefilter), `expandStates`
 * (region token, plain state, mixed case), `zipPattern` (full and partial),
 * and `pageLimit`/`pageOffset` (absent, fractional, over the ceiling).
 */
const CASES: Array<{ name: string; input: Params }> = [
  { name: "default board", input: {} },

  {
    name: "every endpoints-mode filter at once",
    input: {
      pickupStates: ["nj", "southeast", "Tx"],
      pickupCity: "Kearny",
      pickupZip: "07032",
      deliveryStates: ["tristate"],
      deliveryCity: "Miami",
      deliveryZip: "331",
      origin: NEWARK,
      radiusMiles: 50,
      destination: MIAMI,
      destRadiusMiles: 125,
      routeMode: "endpoints",
      bounds: { minLat: 24.1, maxLat: 41.9, minLng: -80.9, maxLng: -73.2 },
      minCf: 200,
      maxCf: 900,
      includeUnsized: false,
      readyOnly: true,
      readyBy: "2026-10-01",
      deliverBy: "2026-10-15",
      seenDays: 7,
      hasPrice: true,
      statuses: ["available", "delisted"],
      senderKey: "phone:+17865550128",
      q: "Piano NO STAIRS",
      includeDuplicates: true,
      needsReviewOnly: true,
      viewer: MIAMI,
      sort: "distance",
      limit: 25,
      offset: 50,
    },
  },

  {
    name: "corridor, fully populated",
    input: {
      routeMode: "corridor",
      origin: MIAMI,
      destination: NEWARK,
      corridorMiles: 75,
      readyBy: "2026-10-01",
      deliverBy: "2026-10-15",
      seenDays: 14,
      minCf: 150,
      sort: "cf",
      limit: 40,
      offset: 10,
    },
  },

  {
    name: "corridor with no explicit width (the default)",
    input: { routeMode: "corridor", origin: MIAMI, destination: NEWARK },
  },

  { name: "size floor only, unsized excluded", input: { includeUnsized: false } },
  { name: "size ceiling only, unsized kept", input: { maxCf: 400 } },
  { name: "size window, unsized kept", input: { minCf: 100, maxCf: 400 } },

  { name: "ready today", input: { readyOnly: true } },
  { name: "deliver by", input: { deliverBy: "2026-09-30" } },
  { name: "seen days out of range (clamped)", input: { seenDays: 900 } },
  { name: "seen days fractional", input: { seenDays: 2.6 } },

  { name: "partial pickup ZIP", input: { pickupZip: "070" } },
  { name: "punctuated delivery ZIP", input: { deliveryZip: "33-435-1234" } },
  { name: "region tokens", input: { pickupStates: ["West Coast"], deliveryStates: ["tri-state"] } },

  { name: "origin radius only", input: { origin: NEWARK, radiusMiles: 60 } },
  { name: "destination radius only", input: { destination: MIAMI, destRadiusMiles: 200 } },
  { name: "viewer distance, no origin", input: { viewer: NEWARK, sort: "distance" } },
  { name: "map viewport", input: { bounds: { minLat: 25, maxLat: 41, minLng: -81, maxLng: -73 } } },
  { name: "free-text search", input: { q: "Kearny" } },

  { name: "sort newest", input: { sort: "newest" } },
  { name: "sort last_seen", input: { sort: "last_seen" } },
  { name: "sort ready", input: { sort: "ready" } },
  { name: "sort trip_miles", input: { sort: "trip_miles" } },
  { name: "sort rate", input: { sort: "rate" } },
  { name: "sort cf", input: { sort: "cf" } },
  { name: "sort deliver_by", input: { sort: "deliver_by" } },
  { name: "sort distance with no reference point", input: { sort: "distance" } },

  { name: "fractional page", input: { limit: 1.5, offset: 2.4 } },
  { name: "page over the ceiling", input: { limit: 1e21, offset: 1e21 } },
  { name: "page below the floor", input: { limit: -3, offset: -3 } },
];

function normalize(value: unknown): unknown {
  if (value === TODAY) return "<TODAY>";
  return value;
}

const out: string[] = [
  "# T-A1 -- the statements searchLoads builds, verbatim.",
  "# Recorded through a `pg` driver stand-in; today's date is printed as <TODAY>.",
];

/**
 * Open the backend before anything is recorded.
 *
 * `src/lib/db.ts` connects lazily, and connecting runs `migrate()` -- one
 * `exec` of the whole of db/schema.sql, through this same tap. Left in, it
 * would be "statement 1" of the first case, and every additive migration for
 * ever after would move this snapshot: a red T-A1 that says "the schema grew",
 * not "searchLoads changed". A gate that cries wolf is a gate people re-record,
 * and the snapshot is supposed to be about the statements searchLoads BUILDS.
 * So the connection is made here and its schema exec is discarded by the
 * `reset()` at the top of the first case.
 */
await searchLoads({});

for (const { name, input } of CASES) {
  reset();
  await searchLoads(input);
  out.push("", "=".repeat(78), `CASE ${name}`, "=".repeat(78));
  RECORDED.forEach((r, i) => {
    out.push(`--- statement ${i + 1} ---`);
    out.push(r.sql);
    out.push(`--- binds ${i + 1} ---`);
    out.push(JSON.stringify(r.params.map(normalize)));
  });
}

process.stdout.write(out.join("\n") + "\n");
