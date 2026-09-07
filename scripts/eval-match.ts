/**
 * Matching check. npm run eval:match
 *
 * PURE, AND WITHOUT A DATABASE. `evaluateMatch` is the single decision site for
 * both directions of the board, the map, the posting form's preview and (stage
 * 5) the notification cron, and it takes `now` as an argument -- so the whole of
 * what it decides can be pinned in a file, on a fixed calendar, with no seed, no
 * PGlite and no clock. A gate that needs a database to say whether a truck is
 * going the wrong way is a gate nobody will run.
 *
 * WHAT IS ASSERTED, and why each one is here:
 *
 *   1. every one of the fourteen gates REFUSES something, in its own order. A
 *      gate that no case reaches is a gate that is not tested; a gate reached
 *      out of order changes what the refusal histogram says, which is the only
 *      thing an empty screen has to offer;
 *   2. the eighteen acceptance cases of SPEC 18, M1..M18, by number;
 *   3. the exact clause strings of SPEC 11.8, including the three worked
 *      examples, byte for byte -- these are read by a person deciding whether to
 *      spend a phone call, so drift in them is drift in a promise;
 *   4. the tier rule: over the whole cross product, no result carrying an
 *      unknown is ever Strong;
 *   5. symmetry: the same pair judged from either side is the same verdict;
 *   6. determinism: two runs, byte-identical;
 *   7. the import graph: no database module and no HERE client is reachable
 *      from the decision, transitively, following value imports only.
 *
 * `npm run check:redact` covers what the two ROUTES return, including a fetch
 * spy over a real request; this file covers what the decision is.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { destinationPoint, haversineMiles, initialBearing, intermediatePoint } from "../src/lib/geo/math";
import { alongTrackFraction, crossTrackMiles } from "../src/lib/geo/math";
import { corridorFit, corridorMeasure } from "../src/lib/match/corridor";
import {
  DEFAULT_MATCH_CORRIDOR_MILES,
  HARD_TAG_VETOES,
  MAX_BEARING_DEG,
  MAX_CORRIDOR_MILES,
  OPEN_TRUCK_RADIUS_MILES,
  PROGRESS_EPSILON,
} from "../src/lib/match/constants";
import {
  bearingDelta,
  driveDays,
  evaluateMatch,
  forwardBearingOk,
  legCourseAt,
} from "../src/lib/match/evaluate";
import { emptyMatchCopy, refusalClauses } from "../src/lib/match/reasons";
import { compareMatches } from "../src/lib/match/order";
import type {
  MatchJob,
  MatchOk,
  MatchTruck,
  MatchVerdict,
  RefusalCode,
} from "../src/lib/match/types";
import { REFUSAL_ORDER } from "../src/lib/match/types";
import type { LocalDate } from "../src/lib/extract/dates";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const failures: string[] = [];
let checks = 0;
function assert(ok: boolean, what: string): void {
  checks += 1;
  if (!ok) failures.push(what);
}
function eq(actual: unknown, expected: unknown, what: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${what}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`,
  );
}
function section(name: string): void {
  console.log(`${BOLD}${name}${RESET}`);
}

// --- the calendar and the map ------------------------------------------------

/** Monday 7 September 2026. Fixed, because a date test on "today" is not a test. */
const TODAY: LocalDate = { y: 2026, m: 9, d: 7 };
const day = (n: number): string => {
  const d = new Date(Date.UTC(2026, 8, 7 + n));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

const EWR = { lat: 40.7357, lng: -74.1724 };
const KEARNY = { lat: 40.7684, lng: -74.1454 };
const MIA = { lat: 25.7617, lng: -80.1918 };
const PHL = { lat: 39.9526, lng: -75.1652 };
const ORL = { lat: 28.5383, lng: -81.3792 };
const TPA = { lat: 27.9506, lng: -82.4572 };
const LAX = { lat: 34.0522, lng: -118.2437 };
const BOS = { lat: 42.3601, lng: -71.0589 };

const truck = (over: Partial<MatchTruck> = {}): MatchTruck => ({
  id: 1,
  status: "available",
  visibility: "public",
  sender_key: null,
  posted_by: null,
  origin_lat: EWR.lat,
  origin_lng: EWR.lng,
  dest_lat: MIA.lat,
  dest_lng: MIA.lng,
  corridor_miles: 75,
  free_cf: 700,
  avail_now: true,
  avail_from: null,
  avail_to: null,
  ...over,
});

const job = (over: Partial<MatchJob> = {}): MatchJob => ({
  id: 1,
  status: "available",
  sender_key: null,
  posted_by: null,
  pickup_lat: PHL.lat,
  pickup_lng: PHL.lng,
  delivery_lat: ORL.lat,
  delivery_lng: ORL.lng,
  cubic_feet: 350,
  ready_now: true,
  ready_date: null,
  deliver_by: null,
  requirements: null,
  road_miles: null,
  ...over,
});

const open = (over: Partial<MatchTruck> = {}): MatchTruck =>
  truck({ dest_lat: null, dest_lng: null, ...over });

const verdict = (t: MatchTruck, j: MatchJob, dismissed = false): MatchVerdict =>
  evaluateMatch({ truck: t, job: j, today: TODAY, dismissed });

const refusalOf = (v: MatchVerdict): RefusalCode | "matched" => (v.ok ? "matched" : v.refusal);
const line = (v: MatchVerdict): string => (v.ok ? v.reasons.join(" · ") : `refused: ${v.refusal}`);

// --- 1. every gate refuses, in its own order ---------------------------------

/**
 * One case per gate, each one arranged so that the gate under test is the FIRST
 * one it fails. That ordering is the assertion: `too_big` counted as
 * `wrong_direction` would put the wrong sentence in front of a driver, and the
 * histogram is the only thing an empty match list has to say.
 */
interface GateCase {
  n: number;
  code: RefusalCode;
  what: string;
  t: MatchTruck;
  j: MatchJob;
  dismissed?: boolean;
}

// G10: a short leg makes the detour cap small enough for a real job to break
// it. The delivery sits 50 miles PAST Philadelphia, on the leg's own course, so
// the job is squarely forward and squarely inside the corridor -- and costs the
// driver 100 extra miles on an 80-mile run.
const PAST_PHL = destinationPoint(PHL, initialBearing(EWR, PHL), 50);
const TRENTON = { lat: 40.2206, lng: -74.7597 };

const GATE_CASES: GateCase[] = [
  { n: 1, code: "truck_not_available", what: "a booked truck", t: truck({ status: "booked" }), j: job() },
  {
    n: 1,
    code: "truck_not_available",
    what: "a truck still in the review queue",
    t: truck({ visibility: "pending" }),
    j: job(),
  },
  { n: 2, code: "job_not_available", what: "a delisted job", t: truck(), j: job({ status: "delisted" }) },
  {
    n: 3,
    code: "same_party",
    what: "the same sender on both sides",
    t: truck({ sender_key: "phone:+12015550199" }),
    j: job({ sender_key: "phone:+12015550199" }),
  },
  {
    n: 3,
    code: "same_party",
    what: "the same account on both sides",
    t: truck({ posted_by: 7 }),
    j: job({ posted_by: 7 }),
  },
  {
    n: 4,
    code: "no_truck_origin",
    what: "a truck with no coordinate",
    // `trucks.origin_lat` and `origin_lng` are NOT NULL in db/schema.sql, so
    // `TruckRow` types them as `number` and no real row can reach this gate
    // today. The cast is deliberate and so is the gate: it is one comparison,
    // and the day a truck can be posted from a place the geocoder could not
    // place, the alternative is a NaN corridor that silently matches nothing.
    // Asserted below rather than assumed, so the note stops being true loudly.
    t: truck({ origin_lat: null as unknown as number, origin_lng: null as unknown as number }),
    j: job(),
  },
  {
    n: 5,
    code: "no_job_pickup",
    what: "a job with no pickup coordinate",
    t: truck(),
    j: job({ pickup_lat: null, pickup_lng: null }),
  },
  {
    n: 6,
    code: "no_job_delivery",
    what: "a job with a pickup and no delivery",
    t: truck(),
    j: job({ delivery_lat: null, delivery_lng: null }),
  },
  {
    n: 7,
    code: "pickup_off_corridor",
    what: "Orlando is 125 mi off a 25-mile Newark -> Miami corridor",
    t: truck({ corridor_miles: 25 }),
    j: job({ pickup_lat: ORL.lat, pickup_lng: ORL.lng, delivery_lat: MIA.lat, delivery_lng: MIA.lng }),
  },
  {
    n: 8,
    code: "delivery_off_corridor",
    what: "Philadelphia is on the line, Orlando is past twice the corridor",
    t: truck({ corridor_miles: 60 }),
    j: job(),
  },
  {
    n: 9,
    code: "wrong_direction",
    what: "the job runs back up the leg the truck just came down",
    t: truck(),
    j: job({ pickup_lat: MIA.lat, pickup_lng: MIA.lng, delivery_lat: EWR.lat, delivery_lng: EWR.lng }),
  },
  {
    n: 10,
    code: "detour_too_far",
    what: "a 50-mile side trip off an 80-mile leg",
    t: truck({ dest_lat: PHL.lat, dest_lng: PHL.lng, corridor_miles: 60 }),
    j: job({
      pickup_lat: TRENTON.lat,
      pickup_lng: TRENTON.lng,
      delivery_lat: PAST_PHL.lat,
      delivery_lng: PAST_PHL.lng,
    }),
  },
  {
    n: 11,
    code: "too_big",
    what: "900 cf of freight into 700 cf of space",
    t: truck(),
    j: job({ cubic_feet: 900 }),
  },
  {
    n: 12,
    code: "not_ready_in_time",
    what: "the truck drives past three weeks before the freight is ready",
    t: truck(),
    j: job({ ready_now: false, ready_date: day(21) }),
  },
  {
    n: 13,
    code: "deadline_missed",
    what: "delivery lands after the job's own deadline",
    t: truck(),
    j: job({ deliver_by: day(1) }),
  },
  {
    n: 14,
    code: "dismissed",
    what: "the truck's owner already said no",
    t: truck(),
    j: job(),
    dismissed: true,
  },
];

function gateChecks(): void {
  section("gates — every one of the fourteen refuses, and refuses first");
  const seen = new Set<RefusalCode>();
  for (const c of GATE_CASES) {
    const v = verdict(c.t, c.j, c.dismissed);
    assert(
      refusalOf(v) === c.code,
      `G${c.n} (${c.what}) should refuse "${c.code}", got "${refusalOf(v)}"`,
    );
    seen.add(c.code);
  }
  for (const code of REFUSAL_ORDER) {
    assert(seen.has(code), `no case in this suite reaches the "${code}" gate — it is untested`);
  }

  // Two gates cannot fire on today's data, and both say so somewhere a reader
  // can see it rather than looking like passed tests. Gate 4 is impossible by
  // SCHEMA -- if that ever changes, this line is the one that notices.
  const schema = fs.readFileSync(path.join(ROOT, "db/schema.sql"), "utf8");
  const trucksDdl = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS trucks"));
  assert(
    /origin_lat\s+double precision NOT NULL/.test(trucksDdl) &&
      /origin_lng\s+double precision NOT NULL/.test(trucksDdl),
    "trucks.origin_lat/origin_lng are no longer NOT NULL — gate 4 is now reachable from real data, and the note in .design/impl/truck-stage4.md needs updating",
  );

  console.log(
    `${DIM}  ${GATE_CASES.length} cases over ${REFUSAL_ORDER.length} gates; every refusal code reached${RESET}`,
  );
}

// --- 2. the acceptance cases -------------------------------------------------

function acceptanceChecks(): void {
  section("M1..M18 — the acceptance cases of SPEC 18");

  // M1 -- the audit's named failure, and the most important test here.
  const njToFl = truck();
  const backwards = job({
    pickup_lat: MIA.lat,
    pickup_lng: MIA.lng,
    delivery_lat: EWR.lat,
    delivery_lng: EWR.lng,
    cubic_feet: 350,
  });
  const forwards = job({
    pickup_lat: EWR.lat,
    pickup_lng: EWR.lng,
    delivery_lat: MIA.lat,
    delivery_lng: MIA.lng,
    cubic_feet: 350,
  });
  assert(refusalOf(verdict(njToFl, backwards)) === "wrong_direction", "M1 a Miami -> Newark job on a Newark -> Miami truck is not refused wrong_direction");
  assert(verdict(njToFl, forwards).ok, "M1 the same pair reversed does not match");

  // M2 -- Orlando -> Tampa on a Newark -> Miami truck.
  //
  // SPEC 18 calls this "lateral, no forward progress" and expects G9a. On the
  // real coordinates it is not: the Newark -> Miami great circle runs almost
  // due south through Florida, and Tampa projects FURTHER along it than
  // Orlando (0.9033 against 0.8507), so strict forward progress passes. What
  // refuses it is the corridor: Orlando sits 125 mi off the line, outside any
  // corridor a driver would choose for a Florida run. Recorded rather than
  // fudged -- see .design/impl/truck-stage4.md.
  const lateral = job({
    pickup_lat: ORL.lat,
    pickup_lng: ORL.lng,
    delivery_lat: TPA.lat,
    delivery_lng: TPA.lng,
    cubic_feet: 350,
  });
  assert(
    !verdict(truck({ corridor_miles: 60 }), lateral).ok,
    "M2 a lateral Orlando -> Tampa hop is not refused at all",
  );
  eq(
    refusalOf(verdict(truck({ corridor_miles: 60 }), lateral)),
    "pickup_off_corridor",
    "M2 Orlando -> Tampa on a 60-mile Newark -> Miami corridor",
  );
  const fit = corridorMeasure(ORL, TPA, EWR, MIA);
  assert(
    fit.deliveryProgress > fit.pickupProgress,
    "M2 the note about Tampa projecting further along the leg is no longer true — re-check the case",
  );

  // M3 -- two points 40 miles apart that both clamp to the same along-track
  // fraction. With PROGRESS_EPSILON in place G9a sees this (equal progress is
  // not progress); the bearing test sees it too, and is asserted separately so
  // the claim "G9b catches this" is proved rather than assumed.
  // Both points sit past the end of the leg on the leg's own course, so both
  // clamp to 1.0; the second is 40 miles back UP the course from the first,
  // which is the direction the driver has just come from.
  const endCourse = legCourseAt(EWR, MIA, 1);
  const pastMiami = destinationPoint(MIA, endCourse, 80);
  const alsoPast = destinationPoint(pastMiami, endCourse + 180, 40);
  const clamped = job({
    pickup_lat: pastMiami.lat,
    pickup_lng: pastMiami.lng,
    delivery_lat: alsoPast.lat,
    delivery_lng: alsoPast.lng,
  });
  eq(
    refusalOf(verdict(truck({ corridor_miles: 150 }), clamped)),
    "wrong_direction",
    "M3 two points clamped to the same along-track fraction",
  );
  const pClamp = alongTrackFraction(pastMiami, EWR, MIA);
  const dClamp = alongTrackFraction(alsoPast, EWR, MIA);
  eq([pClamp, dClamp], [1, 1], "M3 the two points do not actually clamp to 1.0");
  assert(
    haversineMiles(pastMiami, alsoPast) > 35 && haversineMiles(pastMiami, alsoPast) < 45,
    "M3 the two points are not the 40 miles apart the case describes",
  );
  assert(
    !forwardBearingOk(EWR, MIA, pastMiami, alsoPast, pClamp),
    "M3 the bearing test alone does not see the clamped pair — G9b would be dead weight here",
  );

  // M4 -- the Strong case.
  const m4 = verdict(truck({ corridor_miles: 75 }), job());
  assert(m4.ok && m4.tier === "strong", `M4 Philadelphia -> Orlando on a NJ -> FL truck should be strong, got ${line(m4)}`);
  if (m4.ok) {
    assert(m4.facts.detour_miles != null, "M4 detour_miles is null on a corridor match");
    assert(m4.facts.off_route_miles != null, "M4 off_route_miles is null on a corridor match");
    assert(m4.facts.route_progress != null, "M4 route_progress is null on a corridor match");
    eq(m4.unknowns, [], "M4 a fully stated pair has unknowns");
  }

  // M5 -- an open truck, for ever Possible.
  const m5 = verdict(open({ free_cf: 1200 }), job({ pickup_lat: KEARNY.lat, pickup_lng: KEARNY.lng, cubic_feet: 900 }));
  assert(m5.ok && m5.tier === "possible", `M5 an open truck should match Possible, got ${line(m5)}`);
  if (m5.ok) {
    eq(
      m5.reasons[0],
      "no destination on your truck — this load is near you, not on a route",
      "M5 the first clause on an open truck",
    );
    eq(
      [m5.facts.off_route_miles, m5.facts.detour_miles, m5.facts.route_progress, m5.facts.leg_miles],
      [null, null, null, null],
      "M5 an open truck's route facts must all be null",
    );
    assert(m5.unknowns.includes("truck_destination"), "M5 truck_destination is not in unknowns");
    assert(
      !m5.reasons.some((r) => /off your route|detour/.test(r)),
      "M5 an open truck printed a clause about a route it never stated",
    );
  }

  // M6 -- size, both ways.
  const m6 = verdict(truck({ free_cf: 1200 }), job({ cubic_feet: 900 }));
  assert(m6.ok, "M6 900 cf into 1,200 cf free should match");
  if (m6.ok) eq(m6.reasons[2], "900 cf into your 1,200 cf free", "M6 the size clause");
  eq(refusalOf(verdict(truck({ free_cf: 700 }), job({ cubic_feet: 900 }))), "too_big", "M6 900 cf into 700 cf free");

  // M7 -- an unstated size is never a refusal.
  const m7job = verdict(truck(), job({ cubic_feet: null }));
  assert(m7job.ok && m7job.tier === "possible", "M7 a job with no cubic feet should match, Possible");
  if (m7job.ok) {
    assert(m7job.reasons[2].includes("size not stated"), `M7 the size clause reads "${m7job.reasons[2]}"`);
    assert(m7job.unknowns.includes("job_size"), "M7 job_size is not in unknowns");
  }
  const m7truck = verdict(truck({ free_cf: null }), job());
  assert(m7truck.ok, "M7 a truck with no free space should still match");
  if (m7truck.ok) {
    assert(
      m7truck.reasons[2].includes("your free space not stated"),
      `M7 the truck-side size clause reads "${m7truck.reasons[2]}"`,
    );
    assert(m7truck.unknowns.includes("truck_free_space"), "M7 truck_free_space is not in unknowns");
  }

  // M8 -- the gate that is easy to leave out. Without it this scores Strong.
  const m8truck = truck({ dest_lat: MIA.lat, dest_lng: MIA.lng, corridor_miles: 75 });
  const m8job = job({ ready_now: false, ready_date: day(21), deliver_by: null });
  eq(refusalOf(verdict(m8truck, m8job)), "not_ready_in_time", "M8 a truck that has already driven past");
  const readyNow = verdict(m8truck, job());
  assert(readyNow.ok && readyNow.tier === "strong", "M8 the same pair with ready freight must be the Strong it would wrongly have been");

  // M9 -- both legs are counted: the 2,800 miles from LA to the pickup.
  const m9truck = truck({
    origin_lat: LAX.lat,
    origin_lng: LAX.lng,
    dest_lat: BOS.lat,
    dest_lng: BOS.lng,
    corridor_miles: 150,
    avail_now: false,
    avail_from: day(5),
  });
  const m9job = job({
    pickup_lat: EWR.lat,
    pickup_lng: EWR.lng,
    delivery_lat: BOS.lat,
    delivery_lng: BOS.lng,
    road_miles: 220,
    deliver_by: day(7),
  });
  eq(refusalOf(verdict(m9truck, m9job)), "deadline_missed", "M9 an LA truck on a 220-mile Newark -> Boston job");
  assert(
    driveDays(haversineMiles(LAX, EWR)) >= 5,
    "M9 proves nothing unless the LA -> Newark leg really costs several days",
  );
  // ...and the geometry must NOT be what refused it, or the case is vacuous.
  const m9geometry = verdict(m9truck, job({ ...m9job, deliver_by: null }));
  assert(m9geometry.ok, `M9 the pair must clear every gate but the deadline, got ${line(m9geometry)}`);

  // M10 -- a wait, counted and said out loud.
  const m10truck = truck({ avail_now: false, avail_from: day(0), avail_to: day(4), corridor_miles: 75 });
  const m10job = job({ ready_now: false, ready_date: day(4) });
  const m10 = verdict(m10truck, m10job);
  assert(m10.ok, `M10 should match, got ${line(m10)}`);
  if (m10.ok) {
    eq(m10.facts.wait_days, 3, "M10 the wait");
    assert(
      m10.reasons.some((r) => r === "you'd wait 3 days for it to be ready"),
      `M10 the wait clause is missing from ${JSON.stringify(m10.reasons)}`,
    );
  }

  // M11 -- a NULL deliver_by is an absence, not an unknown.
  const m11 = verdict(truck({ corridor_miles: 75 }), job({ deliver_by: null }));
  assert(m11.ok, "M11 a job with no deadline should match");
  if (m11.ok) {
    eq(m11.unknowns, [], "M11 a missing deadline must not enter unknowns");
    eq(m11.tier, "strong", "M11 a missing deadline must not cap the tier");
    eq(m11.facts.slack_days, null, "M11 slack_days without a deadline");
  }

  // M12 -- same_party, and only when there is a party.
  const anonymous = verdict(truck({ sender_key: null, posted_by: null }), job({ sender_key: null, posted_by: null }));
  assert(anonymous.ok, "M12 two listings with no party on either side must not be same_party");
  eq(
    refusalOf(verdict(truck({ sender_key: "s1" }), job({ sender_key: "s1" }))),
    "same_party",
    "M12 equal sender_key",
  );
  eq(refusalOf(verdict(truck({ posted_by: 3 }), job({ posted_by: 3 }))), "same_party", "M12 equal posted_by");
  assert(verdict(truck({ posted_by: 3 }), job({ posted_by: 4 })).ok, "M12 different accounts are not the same party");

  // M13 -- the dimension we refuse to score.
  eq(HARD_TAG_VETOES.size, 0, "M13 HARD_TAG_VETOES is not empty");
  const withReq = verdict(truck({ corridor_miles: 75 }), job({ requirements: "Must have active DOT & MC" }));
  assert(withReq.ok, "M13 a requirement must not refuse a match");
  if (withReq.ok) {
    eq(withReq.requirements, "Must have active DOT & MC", "M13 requirements must ride verbatim");
    const bare = verdict(truck({ corridor_miles: 75 }), job());
    assert(bare.ok && bare.score === withReq.score, "M13 a requirement changed the score");
  }
  const evaluateSrc = fs.readFileSync(path.join(ROOT, "src/lib/match/evaluate.ts"), "utf8");
  const scoreBody = evaluateSrc.slice(evaluateSrc.indexOf("function scoreOf"));
  for (const forbidden of ["requirements", "tags", "has_dot_mc", "has_hhg_authority", "has_coi"]) {
    assert(!scoreBody.includes(forbidden), `M13 the score references "${forbidden}"`);
  }

  // M15 -- symmetry, in its pure half: one function, one argument shape, so a
  // pair judged from the truck's page and from the job's page is the same
  // verdict. The candidate SETS are not perfect mirrors and the spec says so;
  // what is held is that the DECISION does not depend on who asked.
  const runSrc = fs.readFileSync(path.join(ROOT, "src/lib/match/run.ts"), "utf8");
  const calls = runSrc.match(/evaluateMatch\(\{([^}]*)\}\)/g) ?? [];
  assert(calls.length >= 3, "M15 run.ts does not call evaluateMatch from both directions and the preview");
  // The key set, not the text: `{ truck, job, today }` and `{ truck: draft,
  // job, today }` are the same call with a differently named local. What must
  // never differ is WHICH facts reach the decision.
  const keySets = calls.map((c) =>
    c
      .replace(/^evaluateMatch\(\{|\}\)$/g, "")
      .split(",")
      .map((part) => part.split(":")[0]!.trim())
      .filter(Boolean)
      .join(","),
  );
  eq(
    [...new Set(keySets)],
    ["truck,job,today"],
    "M15 the directions do not put the same facts in front of the decision",
  );

  console.log(`${DIM}  M1..M15 checked on a fixed calendar (${day(0)})${RESET}`);
}

// --- 3. the exact copy -------------------------------------------------------

function copyChecks(): void {
  section("SPEC 11.8 — the clause strings, and the three worked examples");

  // Worked example 3, reproduced exactly: an open truck, a pickup placed at a
  // measured 22 miles, 900 cf into 1,200, and no date on either side.
  const at22 = destinationPoint(EWR, 300, 22);
  const ex3 = verdict(
    open({ free_cf: 1200, avail_now: false, avail_from: null, avail_to: null }),
    job({
      pickup_lat: at22.lat,
      pickup_lng: at22.lng,
      cubic_feet: 900,
      ready_now: false,
      ready_date: null,
    }),
  );
  assert(ex3.ok, `worked example 3 does not match: ${line(ex3)}`);
  if (ex3.ok) {
    eq(
      line(ex3),
      "no destination on your truck — this load is near you, not on a route · 22 mi from where you'll be empty · 900 cf into your 1,200 cf free · no dates stated on either side",
      "SPEC 11.8 worked example 3, byte for byte",
    );
    eq(ex3.tier, "possible", "worked example 3 must be Possible");
  }

  // Worked example 1's shape: a Strong line, with a measured 12 miles off route.
  const twelveOff = destinationPoint(intermediatePoint(EWR, MIA, 0.25), initialBearing(EWR, MIA) + 90, 12);
  const ex1 = verdict(
    truck({ corridor_miles: 75, free_cf: 700, avail_now: false, avail_from: day(4) }),
    job({
      pickup_lat: twelveOff.lat,
      pickup_lng: twelveOff.lng,
      delivery_lat: ORL.lat,
      delivery_lng: ORL.lng,
      cubic_feet: 350,
      ready_now: false,
      ready_date: day(4),
    }),
  );
  assert(ex1.ok, `worked example 1 does not match: ${line(ex1)}`);
  if (ex1.ok) {
    eq(ex1.reasons[0], "12 mi off your route", "worked example 1, clause 1");
    assert(/^\+\d+ mi detour$/.test(ex1.reasons[1]), `worked example 1, clause 2 reads "${ex1.reasons[1]}"`);
    eq(ex1.reasons[2], "350 cf into your 700 cf free", "worked example 1, clause 3");
    assert(
      /^loads \w{3} \d{1,2} \w{3}, delivers \w{3} \d{1,2} \w{3}$/.test(ex1.reasons[3]),
      `worked example 1, clause 4 reads "${ex1.reasons[3]}"`,
    );
    eq(ex1.tier, "strong", "worked example 1 must be Strong");
    console.log(`${DIM}    strong   ${line(ex1)}${RESET}`);
  }

  // A deadline, printed as the days of slack before it.
  const withDeadline = verdict(
    truck({ corridor_miles: 75 }),
    job({ deliver_by: day(9) }),
  );
  assert(withDeadline.ok, `the deadline example does not match: ${line(withDeadline)}`);
  if (withDeadline.ok) {
    assert(
      / — \d+ days? before its deadline$/.test(withDeadline.reasons[3]),
      `the deadline tail reads "${withDeadline.reasons[3]}"`,
    );
  }

  // "no extra driving" when the detour rounds to zero: a job that runs exactly
  // along the truck's own leg costs nothing extra.
  const onTheLine = verdict(
    truck({ corridor_miles: 75 }),
    job({
      pickup_lat: EWR.lat,
      pickup_lng: EWR.lng,
      delivery_lat: MIA.lat,
      delivery_lng: MIA.lng,
    }),
  );
  assert(onTheLine.ok, "a job along the truck's own leg does not match");
  if (onTheLine.ok) eq(onTheLine.reasons[1], "no extra driving", "the zero-detour clause");

  // Neither side stated a size.
  const noSizes = verdict(truck({ free_cf: null, corridor_miles: 75 }), job({ cubic_feet: null }));
  assert(noSizes.ok, "a pair with no size on either side does not match");
  if (noSizes.ok) {
    eq(noSizes.reasons[2], "size not stated on either side", "the neither-size clause");
    eq(noSizes.tier, "possible", "two unknowns must not be Strong");
  }

  // A truck with no departure prints no date, and publishes none either.
  const noDeparture = verdict(
    truck({ corridor_miles: 75, avail_now: false, avail_from: null, avail_to: null }),
    job(),
  );
  assert(noDeparture.ok, "a truck with no departure does not match");
  if (noDeparture.ok) {
    eq(noDeparture.reasons[3], "no departure date on your truck", "the no-departure clause");
    eq(
      [noDeparture.facts.load_day, noDeparture.facts.deliver_day, noDeparture.facts.wait_days],
      [null, null, null],
      "a truck with no departure must publish no calendar at all",
    );
    assert(noDeparture.facts.dates_assumed, "dates_assumed is not set on an assumed departure");
  }

  // The basis is never silent.
  const byRoad = verdict(truck({ corridor_miles: 75 }), job({ road_miles: 861 }));
  assert(byRoad.ok && byRoad.facts.basis === "road", "a cached road_miles must set basis to road");
  const estimated = verdict(truck({ corridor_miles: 75 }), job({ road_miles: null }));
  assert(estimated.ok && estimated.facts.basis === "estimate", "no cached road_miles must set basis to estimate");

  console.log(`${DIM}  the clause set and three worked examples${RESET}`);
}

// --- M18: the refusal histogram ----------------------------------------------

function histogramChecks(): void {
  section("M18 — an empty list says why, by gate");

  const refusals = { wrong_direction: 11, too_big: 4, deadline_missed: 2, pickup_off_corridor: 38 };
  const copy = emptyMatchCopy({ refusals, candidates: 55 }, "truck", { freeCf: 400 });
  eq(copy.headline, "No jobs fit this truck right now.", "the truck-side empty headline");
  eq(
    copy.clauses.join(" · "),
    "38 were not near your route · 11 were going the wrong way · 4 were bigger than your 400 cf free · 2 could not be delivered by their deadline",
    "SPEC 11.8's histogram, in gate order",
  );

  // Nothing on the board at all is a different silence, and asks for supply.
  const dayOne = emptyMatchCopy({ refusals: {}, candidates: 0 }, "job");
  eq(dayOne.headline, "No trucks are listed for this lane yet.", "SPEC 2's day-one job-detail copy");
  assert(dayOne.clauses.length === 0 && dayOne.ask != null, "the day-one empty state must ask for supply, not explain");

  // The anchor being at fault is a third silence, and never a histogram that
  // blames the board for the reader's own listing.
  const ownFault = emptyMatchCopy({ refusals: { truck_not_available: 98 }, candidates: 98 }, "truck");
  assert(
    ownFault.headline.startsWith("This truck is no longer listed"),
    `an unavailable anchor produced "${ownFault.headline}"`,
  );
  eq(ownFault.clauses, [], "an anchor refusal must not print a histogram");

  // Singular and plural both read as English.
  eq(
    refusalClauses({ wrong_direction: 1, too_big: 1 }, "truck", { freeCf: 700 }),
    ["1 was going the wrong way", "1 was bigger than your 700 cf free"],
    "the singular forms",
  );
  eq(
    refusalClauses({ wrong_direction: 2, too_big: 3 }, "job", { jobCf: 350 }),
    ["2 were going the other way", "3 had no room for 350 cf"],
    "the job side's mirror",
  );

  // Every gate that can be counted has a sentence on both sides, or the
  // histogram silently drops a reason and the total stops adding up.
  for (const code of REFUSAL_ORDER) {
    for (const side of ["truck", "job"] as const) {
      const anchorSide =
        (side === "truck" && (code === "truck_not_available" || code === "no_truck_origin")) ||
        (side === "job" &&
          (code === "job_not_available" || code === "no_job_pickup" || code === "no_job_delivery"));
      const out = refusalClauses({ [code]: 1 }, side, { freeCf: 700, jobCf: 350 });
      assert(
        anchorSide ? out.length === 0 : out.length === 1,
        `"${code}" on the ${side} side produced ${out.length} clauses; every gate needs exactly one sentence or none by design`,
      );
    }
  }

  console.log(`${DIM}  ${REFUSAL_ORDER.length * 2} gate/side sentences, three empty states${RESET}`);
}

// --- 4..6: the corpus properties ---------------------------------------------

/** A spread of trucks and jobs wide enough that most gates fire somewhere. */
function corpus(): { trucks: MatchTruck[]; jobs: MatchJob[] } {
  const places = [EWR, KEARNY, PHL, MIA, ORL, TPA, LAX, BOS];
  const trucks: MatchTruck[] = [];
  const jobs: MatchJob[] = [];
  let id = 0;
  for (const a of places) {
    for (const b of places) {
      if (a === b) continue;
      id += 1;
      trucks.push(
        truck({
          id,
          origin_lat: a.lat,
          origin_lng: a.lng,
          dest_lat: id % 5 === 0 ? null : b.lat,
          dest_lng: id % 5 === 0 ? null : b.lng,
          corridor_miles: [25, 50, 60, 75, 100, 150][id % 6]!,
          free_cf: id % 4 === 0 ? null : 400 + (id % 7) * 200,
          avail_now: id % 3 === 0,
          avail_from: id % 3 === 0 ? null : id % 3 === 1 ? day(id % 6) : null,
          avail_to: id % 3 === 1 ? day((id % 6) + 3) : null,
        }),
      );
      jobs.push(
        job({
          id,
          pickup_lat: a.lat,
          pickup_lng: a.lng,
          delivery_lat: b.lat,
          delivery_lng: b.lng,
          cubic_feet: id % 5 === 0 ? null : 200 + (id % 9) * 150,
          ready_now: id % 4 === 0,
          ready_date: id % 4 === 0 ? null : id % 4 === 1 ? day(id % 9) : null,
          deliver_by: id % 7 === 0 ? day((id % 9) + 6) : null,
          road_miles: id % 6 === 0 ? Math.round(haversineMiles(a, b) * 1.15) : null,
        }),
      );
    }
  }
  return { trucks, jobs };
}

function corpusChecks(): void {
  section("the cross product — the tier rule, symmetry, determinism, the corridor");

  const { trucks, jobs } = corpus();
  const verdicts: MatchVerdict[] = [];
  const tally: Partial<Record<RefusalCode | "matched", number>> = {};
  let strong = 0;

  for (const t of trucks) {
    for (const j of jobs) {
      const v = verdict(t, j);
      verdicts.push(v);
      const key = refusalOf(v);
      tally[key] = (tally[key] ?? 0) + 1;

      // M17 -- the rule that makes the badge mean something.
      if (v.ok && v.tier === "strong") {
        strong += 1;
        assert(v.unknowns.length === 0, `M17 a Strong match carried unknowns ${JSON.stringify(v.unknowns)}`);
        assert(
          v.facts.off_route_miles != null && v.facts.detour_miles != null,
          "M17 a Strong match has no route facts, so it came from an open truck",
        );
      }

      // A corridor-mode acceptance must be an acceptance the shared corridor
      // test agrees with: `evaluateMatch` layers the epsilon and the bearing on
      // top of `corridorFit` and may only ever be STRICTER than it. Anything
      // else is the two implementations drifting, which is what lifting the
      // geometry into one module was for.
      if (v.ok && t.dest_lat != null && t.dest_lng != null && v.facts.off_route_miles != null) {
        const shared = corridorFit(
          { lat: j.pickup_lat!, lng: j.pickup_lng! },
          { lat: j.delivery_lat!, lng: j.delivery_lng! },
          {
            origin: { lat: t.origin_lat!, lng: t.origin_lng! },
            destination: { lat: t.dest_lat, lng: t.dest_lng },
            halfWidthMiles: t.corridor_miles,
          },
          { strictForward: true },
        );
        assert(
          shared != null && Math.abs(shared.offRoute - v.facts.off_route_miles) < 1e-9,
          `the matcher accepted a pair corridorFit rejects (truck ${t.id}, job ${j.id})`,
        );
      }
    }
  }

  const pairs = trucks.length * jobs.length;
  assert(pairs > 2000, `the corpus is only ${pairs} pairs — too thin to prove a property over`);
  assert(strong > 0, "not one Strong match in the whole corpus, so M17 proves nothing");
  assert((tally.matched ?? 0) > 20, `only ${tally.matched ?? 0} matches in the corpus`);

  // M16 -- determinism. Same inputs, same bytes, and `now` is an argument.
  const again = trucks.flatMap((t) => jobs.map((j) => verdict(t, j)));
  assert(
    JSON.stringify(verdicts) === JSON.stringify(again),
    "M16 two runs over the same corpus produced different output",
  );
  for (const file of ["evaluate.ts", "reasons.ts", "corridor.ts", "order.ts", "constants.ts"]) {
    const src = fs.readFileSync(path.join(ROOT, "src/lib/match", file), "utf8");
    assert(!/\bDate\.now\(|new Date\(\)/.test(src), `M16 src/lib/match/${file} reads the clock`);
  }

  // The ordering is total and stable: sorting the same list twice, from two
  // different starting orders, gives the same sequence.
  const matched = trucks
    .flatMap((t) => jobs.map((j) => ({ t, j, v: verdict(t, j) })))
    .filter((x): x is { t: MatchTruck; j: MatchJob; v: MatchOk } => x.v.ok)
    .map((x) => ({ item: x.j, verdict: x.v }));
  const keys = (j: MatchJob) => ({ deadline: j.deliver_by, lastSeen: null });
  const forward = [...matched].sort((a, b) => compareMatches(a, b, keys));
  const reversed = [...matched].reverse().sort((a, b) => compareMatches(a, b, keys));
  eq(
    forward.map((m) => `${m.verdict.tier}:${m.verdict.score.toFixed(6)}`),
    reversed.map((m) => `${m.verdict.tier}:${m.verdict.score.toFixed(6)}`),
    "the ordering is not stable under a different input order",
  );
  assert(
    forward.every(
      (m, i) => i === 0 || forward[i - 1]!.verdict.tier === "strong" || m.verdict.tier !== "strong",
    ),
    "a Possible match sorted above a Strong one",
  );

  const summary = REFUSAL_ORDER.filter((c) => tally[c])
    .map((c) => `${c} ${tally[c]}`)
    .join(", ");
  console.log(
    `${DIM}  ${pairs} pairs: ${tally.matched ?? 0} matched (${strong} strong)${RESET}\n` +
      `${DIM}  refusals: ${summary}${RESET}`,
  );
}

// --- the bearing test, on its own --------------------------------------------

/**
 * G9b, measured rather than assumed.
 *
 * The suite asserts what the test DOES (it refuses a job pointing back down the
 * leg) and then reports what it ADDS over strict forward progress, by searching
 * a deterministic sample of the geometry for a pair G9a accepts and G9b
 * refuses. That number is currently zero and the report says so out loud: it is
 * a fact about this codebase's geometry, not a defect, and printing it means
 * nobody has to re-derive it -- including whoever next considers lowering
 * PROGRESS_EPSILON, at which point it stops being zero.
 */
function bearingChecks(): void {
  section("G9b — the bearing test, and what it adds");

  eq(bearingDelta(10, 350), 20, "bearingDelta across north");
  eq(bearingDelta(350, 10), -20, "bearingDelta across north, the other way");
  eq(Math.round(legCourseAt(EWR, MIA, 0)), Math.round(legCourseAt(EWR, MIA, 0)), "legCourseAt is deterministic");

  const south = legCourseAt(EWR, MIA, 0.5);
  assert(south > 180 && south < 230, `the Newark -> Miami course at half way is ${south.toFixed(1)}, not south-west`);
  assert(
    !forwardBearingOk(EWR, MIA, MIA, EWR, alongTrackFraction(MIA, EWR, MIA)),
    "the bearing test accepts a job running straight back up the leg",
  );
  assert(
    forwardBearingOk(EWR, MIA, PHL, ORL, alongTrackFraction(PHL, EWR, MIA)),
    "the bearing test refuses Philadelphia -> Orlando on a Newark -> Miami run",
  );

  let seed = 987654321;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let passed = 0;
  let g9bOnly = 0;
  let g9aOnly = 0;
  for (let i = 0; i < 200_000; i += 1) {
    const o = { lat: 25 + rnd() * 24, lng: -124 + rnd() * 57 };
    const d = { lat: 25 + rnd() * 24, lng: -124 + rnd() * 57 };
    if (haversineMiles(o, d) < 20) continue;
    const half = [25, 50, DEFAULT_MATCH_CORRIDOR_MILES, 75, 100, MAX_CORRIDOR_MILES][Math.floor(rnd() * 6)]!;
    const f = -0.15 + rnd() * 1.3;
    const p = destinationPoint(intermediatePoint(o, d, Math.min(1, Math.max(0, f))), rnd() * 360, rnd() * half * 1.1);
    const q = destinationPoint(p, rnd() * 360, 5 + rnd() * 395);
    if (crossTrackMiles(p, o, d) > half) continue;
    if (crossTrackMiles(q, o, d) > half * 2) continue;
    passed += 1;
    const pProg = alongTrackFraction(p, o, d);
    const g9a = alongTrackFraction(q, o, d) > pProg + PROGRESS_EPSILON;
    const g9b = forwardBearingOk(o, d, p, q, pProg);
    if (g9a && !g9b) g9bOnly += 1;
    if (!g9a && g9b) g9aOnly += 1;
  }
  assert(passed > 50_000, `only ${passed} sampled pairs cleared the corridor — the search is not searching`);
  console.log(
    `${DIM}  over ${passed.toLocaleString("en-US")} corridor-passing pairs: ${g9aOnly.toLocaleString("en-US")} refused by ` +
      `forward progress alone, ${g9bOnly} by the bearing alone (MAX_BEARING_DEG ${MAX_BEARING_DEG}, ` +
      `PROGRESS_EPSILON ${PROGRESS_EPSILON})${RESET}`,
  );
  if (g9bOnly === 0) {
    console.log(
      `${DIM}  G9b currently refuses nothing G9a does not: a positive along-track gain is a positive${RESET}\n` +
        `${DIM}  along-course displacement, and the clamped cases fail the epsilon first. Kept as the guard${RESET}\n` +
        `${DIM}  that becomes live the moment PROGRESS_EPSILON drops or alongTrackFraction stops clamping.${RESET}`,
    );
  }
}

// --- M14: the import graph ---------------------------------------------------

const FORBIDDEN_MODULES = ["@/lib/db", "@/lib/geo/here"];

/** Value imports only: `import type` is erased and cannot reach a driver. */
function valueImports(src: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\s+([^;]*?)\s*from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const clause = m[1]!;
    // `import type { X } from` and `import { type X } from` are both erased.
    if (/^type\b/.test(clause.trim())) continue;
    const named = clause.replace(/^\{|\}$/g, "");
    if (/^\{/.test(clause.trim()) && named.split(",").every((s) => /^\s*type\s/.test(s) || !s.trim())) {
      continue;
    }
    out.push(m[2]!);
  }
  return out;
}

function resolveModule(spec: string, from: string): string | null {
  const base = spec.startsWith("@/")
    ? path.join(ROOT, "src", spec.slice(2))
    : spec.startsWith(".")
      ? path.resolve(path.dirname(from), spec)
      : null;
  if (!base) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function importGraphChecks(): void {
  section("M14 — the decision cannot reach a database or a router");

  const entry = path.join(ROOT, "src/lib/match/evaluate.ts");
  const seen = new Set<string>();
  const reached: string[] = [];
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, "utf8");
    for (const spec of valueImports(src)) {
      assert(
        !FORBIDDEN_MODULES.includes(spec),
        `M14 ${path.relative(ROOT, file).replace(/\\/g, "/")} imports ${spec} — the decision must never reach it`,
      );
      const next = resolveModule(spec, file);
      if (next) walk(next);
      else reached.push(spec);
    }
  };
  walk(entry);

  const modules = [...seen].map((f) => path.relative(ROOT, f).replace(/\\/g, "/")).sort();
  for (const forbidden of FORBIDDEN_MODULES) {
    const asPath = `src/${forbidden.slice(2)}.ts`;
    assert(!modules.includes(asPath), `M14 ${asPath} is reachable from evaluateMatch`);
  }
  for (const file of ["src/lib/match/evaluate.ts", "src/lib/match/reasons.ts"]) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert(!/\bfetch\s*\(/.test(src), `M14 ${file} contains a fetch call`);
    assert(!/\basync\b|\bawait\b/.test(src), `M14 ${file} is asynchronous, so it can wait for something`);
  }
  assert(reached.length === 0, `M14 could not resolve ${reached.join(", ")} — the walk is incomplete`);
  assert(modules.length >= 6, `M14 walked only ${modules.length} modules; the scanner is reading nothing`);

  console.log(`${DIM}  ${modules.length} modules reachable: ${modules.join(", ")}${RESET}`);
}

// --- the radius rule ---------------------------------------------------------

function radiusChecks(): void {
  section("the open truck — a circle, never a faked direction");

  const wide = open({ corridor_miles: MAX_CORRIDOR_MILES });
  const at120 = destinationPoint(EWR, 200, 120);
  const at160 = destinationPoint(EWR, 200, 160);
  assert(
    verdict(wide, job({ pickup_lat: at120.lat, pickup_lng: at120.lng })).ok,
    `a driver who chose a ${MAX_CORRIDOR_MILES}-mile swing must be matched out to it, not cut back to ${OPEN_TRUCK_RADIUS_MILES}`,
  );
  eq(
    refusalOf(verdict(wide, job({ pickup_lat: at160.lat, pickup_lng: at160.lng }))),
    "pickup_off_corridor",
    "a load past the driver's own stated swing",
  );
  const narrow = open({ corridor_miles: 25 });
  assert(
    verdict(narrow, job({ pickup_lat: at120.lat, pickup_lng: at120.lng })).ok === false ||
      haversineMiles(EWR, at120) <= OPEN_TRUCK_RADIUS_MILES,
    "the open-truck circle is smaller than OPEN_TRUCK_RADIUS_MILES",
  );
  const at90 = destinationPoint(EWR, 200, 90);
  assert(
    verdict(narrow, job({ pickup_lat: at90.lat, pickup_lng: at90.lng })).ok,
    `a 25-mile corridor must still see ${OPEN_TRUCK_RADIUS_MILES} miles when there is no destination`,
  );
  console.log(`${DIM}  the circle is max(corridor, ${OPEN_TRUCK_RADIUS_MILES}) and never less${RESET}`);
}

function main(): void {
  gateChecks();
  acceptanceChecks();
  copyChecks();
  histogramChecks();
  corpusChecks();
  bearingChecks();
  radiusChecks();
  importGraphChecks();

  if (failures.length) {
    console.log(`\n${RED}${failures.length} of ${checks} match checks failed${RESET}`);
    for (const f of failures) console.log(`  ${RED}✗${RESET} ${f}`);
    process.exit(1);
  }
  console.log(`\n${GREEN}✓${RESET} ${checks} match checks passed\n`);
  process.exit(0);
}

main();
