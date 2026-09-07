/**
 * Demo-posting check. npm run check:demo
 *
 * `POST /api/auth/demo` is a public, credential-free sign-in and DEMO_MODE is
 * on in production, so the demo poster is an account any stranger holds. It may
 * post -- that walkthrough is the demo -- and what it posts must never reach
 * anybody else. This script is the gate that says so, and it is written the way
 * the audit that found the hole said it had to be: the enumeration first, then
 * one assertion per path.
 *
 * EVERY PATH THAT RETURNS A JOB TO A CLIENT, and how each is covered:
 *
 *   GET  /api/loads                  searchLoads(params, audience)
 *   GET  /api/loads/[id]             getLoad(id, audience) + getDuplicates
 *   POST /api/loads/[id]/contact     getLoad(id, audience) before revealContact
 *   GET  /api/loads/[id]/route       isLoadVisible before loadRoadRoute
 *   PATCH /api/loads/[id]/status     ownership, plus isLoadVisible so a refusal
 *                                    cannot admit the row is there
 *   POST /api/reports                isLoadVisible: no existence oracle, and no
 *                                    report about an invisible job in the queue
 *
 * Four of those six were `WHERE l.id = $1` with no predicate to extend, which is
 * precisely why a filter on the board query alone would have been theatre.
 *
 * AND EVERY PATH THAT RETURNS A TRUCK:
 *
 *   GET  /api/trucks                 searchTrucks("public", params, audience)
 *   GET  /api/trucks/[id]            getTruck(id, "public", audience)
 *
 * A truck carries TWO independent predicates, and both are checked here. The
 * scope decides whether an unreviewed row exists at all and does not depend on
 * who is asking; the audience decides whose demo scratch work is whose and is
 * the same question the job board answers. `truckQuery.ts` writes its own copy
 * of the demo fragment, because the job query path is frozen for the truck
 * feature -- so the audience matrix below is run over BOTH tables and asserts
 * the two answers agree, which is what keeps the copy from drifting.
 *
 * The board pages (`/`, `/jobs/[id]`) render `Board`, a client component that
 * reads the two API routes above and no database of its own, so they carry no
 * seventh path. The admin consoles are excluded on purpose: `/api/admin/*` and
 * `/api/test/*` are `role:admin` or `write:admin`, and a real admin being able
 * to find a demo listing is a requirement, not a leak.
 *
 * THE CHECKS
 *
 *   1. the seeded corpus is untouched -- not one row of it is is_demo, so the
 *      canonical summary npm run seed prints cannot move;
 *   2. the data layer, for eight audiences over a demo listing and a real
 *      control listing posted seconds apart: anonymous, the poster itself,
 *      another demo account, an unrelated real account, a demo admin, a real
 *      admin, and a real admin who asked (?demo=1);
 *   3. the real handlers, imported and invoked -- GET /api/loads, GET
 *      /api/loads/:id, GET /api/loads/:id/route and POST /api/reports answer an
 *      anonymous caller about the demo listing exactly as they answer about an
 *      id that was never issued;
 *   4. the route layer as text, which is what catches the handler somebody adds
 *      next month: every non-admin handler that reads a job must pass an
 *      audience, and one that writes its own `FROM loads` must be declared here;
 *   5. the lifetime: a demo account cannot accumulate rows without limit.
 *
 * Check 3 can be run at all because `getCurrentUser` answers null when there is
 * no request scope to read a cookie from (src/lib/auth.ts). An anonymous caller
 * is the case that matters most here and it is the one this can reproduce
 * exactly; the signed-in cases are check 2's, one call below the handler, and
 * the live transcript in .design/impl/demo-posting.md is the end-to-end proof.
 *
 * Runs against an in-memory database (PGLITE_DIR=memory://) so it never touches
 * a real .pgdata, and with no HERE key so it can never spend money.
 */
process.env.PGLITE_DIR = "memory://";
delete process.env.HERE_API_KEY;

import path from "node:path";
import { fileURLToPath } from "node:url";
import { guardOf, isAdminOnly, isMachineOnly, routeHandlers } from "./lib/routes";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const failures: string[] = [];
let checks = 0;
const assert = (ok: boolean, what: string) => {
  checks++;
  if (!ok) failures.push(what);
};

/** The demo sweep's ceiling, mirrored from src/lib/pipeline/web.ts. */
const DEMO_KEEP = 5;

/**
 * A pickup that needs no geocoder: the shape the form sends when the poster
 * picked a suggestion, so `insertWebJob` takes the coordinates as given. The
 * delivery goes through the structured geocoder, which falls back to a state
 * centroid offline and never calls out.
 */
const PICKUP = {
  pickup: "Kearny, NJ 07032",
  pickupLat: "40.7684",
  pickupLng: "-74.1454",
  pickupState: "NJ",
  pickupZip: "07032",
  pickupPrecision: "zip",
};

/**
 * A truck at the same yard, for the other half of every assertion below.
 *
 * Deliberately placeable and deliberately ordinary: the question this file asks
 * is never "is this row well formed?" but "who can see it?", and a fixture with
 * anything unusual about it would make a failure ambiguous.
 */
const TRUCK = {
  origin_label: "Kearny, NJ 07032",
  origin_city: "Kearny",
  origin_state: "NJ",
  origin_zip: "07032",
  origin_lat: 40.7684,
  origin_lng: -74.1454,
  origin_precision: "zip",
  dest_label: "Boynton Beach, FL 33435",
  dest_city: "Boynton Beach",
  dest_state: "FL",
  dest_zip: "33435",
  dest_lat: 26.5254,
  dest_lng: -80.0664,
  dest_precision: "zip",
  free_cf: 800,
  free_source: "form",
  avail_now: true,
  corridor_miles: 60,
  contact_name: "Rosa Poster",
  contact_phone: "+19085557788",
  contact_phone_source: "post",
  shape: "form",
};

function jobBody(marker: string) {
  return {
    ...PICKUP,
    deliveryState: "FL",
    deliveryZip: "33435",
    cubicFeet: "800",
    priceMode: "percf" as const,
    pricePerCf: "5.50",
    readyNow: "on" as const,
    contactName: marker,
    contactPhone: "+12015550199",
    notes: marker,
  };
}

interface Actor {
  id: number;
  email: string;
  label: string;
}

async function main() {
  const { query, queryOne } = await import("../src/lib/db");
  const { resetDemoData } = await import("../src/lib/demo/reset");
  const { createDemoAccounts, ensureRealAdmin, ADMIN_EMAIL } = await import(
    "../src/lib/demo/accounts"
  );
  const { getLoad, getDuplicates, isLoadVisible, searchLoads } = await import(
    "../src/lib/loads/query"
  );
  const { getTruck, isTruckVisible, searchTrucks } = await import("../src/lib/loads/truckQuery");
  const { insertTruck } = await import("./fixtures/trucks");
  const { insertWebJob } = await import("../src/lib/pipeline/web");
  const { hashPassword } = await import("../src/lib/password");
  const { isAdminActor } = await import("../src/lib/session");

  const summary = await resetDemoData();
  await createDemoAccounts();
  await ensureRealAdmin();
  console.log(`${DIM}seeded ${summary.messages} messages, ${summary.loadsCreated} jobs (in memory)${RESET}`);

  // --- 1. the seeded corpus is untouched -------------------------------------
  const corpus = await queryOne<{ total: number; demo: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE is_demo)::int AS demo FROM loads`,
  );
  assert((corpus?.total ?? 0) > 0, "the corpus seeded no jobs, so nothing below proves anything");
  assert(corpus?.demo === 0, `${corpus?.demo} seeded corpus rows are marked is_demo; the pipeline must never set it`);

  // Trucks default to public, so the DEFAULT is the thing worth asserting: a
  // row nobody stamped is everybody's, and only the poster's session can stamp
  // one. The demo walkthrough's own trucks arrive with the form in stage 2.
  const truckCorpus = await queryOne<{ total: number; demo: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE is_demo)::int AS demo FROM trucks`,
  );
  assert(truckCorpus?.demo === 0, `${truckCorpus?.demo} seeded trucks are marked is_demo`);

  // --- the cast --------------------------------------------------------------
  const find = async (email: string, label: string): Promise<Actor> => {
    const row = await queryOne<{ id: number }>(`SELECT id FROM users WHERE email = $1`, [email]);
    if (!row) throw new Error(`no ${label} account (${email}) -- seeding changed shape`);
    return { id: row.id, email, label };
  };

  const demoPoster = await find("poster@example.com", "demo poster");
  const demoDriver = await find("driver@example.com", "demo driver");
  const demoAdmin = await find("admin@example.com", "demo admin");
  const realAdmin = await find(ADMIN_EMAIL, "real admin");

  await query(
    `INSERT INTO users (email, password_hash, name, role, phone, company, is_demo, can_post)
     VALUES ($1,$2,'Rae Real','poster','+12015550111','Real Movers LLC',false,true)
     ON CONFLICT (email) DO NOTHING`,
    ["rae@real-movers.test", hashPassword("not-a-demo-password")],
  );
  const realPoster = await find("rae@real-movers.test", "real poster");

  // The demo rows really are demo rows, and the real ones really are not --
  // every assertion below is about that difference, so it is worth stating.
  const flags = await query<{ email: string; is_demo: boolean }>(
    `SELECT email, is_demo FROM users WHERE id = ANY($1::bigint[])`,
    [[demoPoster.id, demoDriver.id, demoAdmin.id, realAdmin.id, realPoster.id]],
  );
  const flagOf = new Map(flags.map((f) => [f.email, f.is_demo]));
  assert(flagOf.get(demoPoster.email) === true, "the demo poster is not marked is_demo");
  assert(flagOf.get(demoDriver.email) === true, "the demo driver is not marked is_demo");
  assert(flagOf.get(demoAdmin.email) === true, "the demo admin is not marked is_demo");
  assert(flagOf.get(realAdmin.email) === false, "the real admin is marked is_demo");
  assert(flagOf.get(realPoster.email) === false, "the real poster is marked is_demo");

  // --- two listings, posted the same way -------------------------------------
  const { id: demoJob } = await insertWebJob(
    { id: demoPoster.id, name: "Rosa Poster", phone: "+19085557788", isDemo: true },
    jobBody("demo-posted-listing"),
  );
  const { id: realJob } = await insertWebJob(
    { id: realPoster.id, name: "Rae Real", phone: "+12015550111", isDemo: false },
    jobBody("real-posted-listing"),
  );

  // The same two listings, in the other table. There is no truck writer yet --
  // the form is stage 2 -- so these are inserted directly, stamped the way the
  // session will stamp them, which is exactly the pair the predicate is about.
  const demoTruck = await insertTruck({
    ...TRUCK,
    posted_by: demoPoster.id,
    is_demo: true,
    truck_key: "demo-posted-truck",
    notes: "demo-posted-truck",
  });
  const realTruck = await insertTruck({
    ...TRUCK,
    posted_by: realPoster.id,
    is_demo: false,
    truck_key: "real-posted-truck",
    notes: "real-posted-truck",
  });

  const stamps = await query<{ id: number; is_demo: boolean; posted_by: number }>(
    `SELECT id, is_demo, posted_by FROM loads WHERE id = ANY($1::bigint[])`,
    [[demoJob, realJob]],
  );
  const stampOf = new Map(stamps.map((s) => [s.id, s]));
  assert(stampOf.get(demoJob)?.is_demo === true, "a listing posted by a demo account is not stamped is_demo");
  assert(stampOf.get(realJob)?.is_demo === false, "a listing posted by a real account was stamped is_demo");
  assert(stampOf.get(demoJob)?.posted_by === demoPoster.id, "the demo listing lost its owner");

  // --- 2. the data layer, audience by audience -------------------------------
  //
  // The control listing is the half that makes this a check rather than a
  // tautology: every audience that cannot see the demo listing must still see
  // the real one, or a query builder that returned nothing would pass.
  const audiences: Array<{ label: string; audience: { userId: number | null; includeDemo?: boolean }; sees: boolean }> = [
    { label: "an anonymous visitor", audience: { userId: null }, sees: false },
    { label: "the demo poster who made it", audience: { userId: demoPoster.id }, sees: true },
    { label: "a different demo account", audience: { userId: demoDriver.id }, sees: false },
    { label: "an unrelated real account", audience: { userId: realPoster.id }, sees: false },
    // A demo admin is not an admin actor, so it may not pass includeDemo -- and
    // if some future caller passed it anyway, this says what that would cost.
    { label: "a demo admin", audience: { userId: demoAdmin.id }, sees: false },
    { label: "a real admin, by default", audience: { userId: realAdmin.id }, sees: false },
    { label: "a real admin who asked (?demo=1)", audience: { userId: realAdmin.id, includeDemo: true }, sees: true },
  ];

  for (const { label, audience, sees } of audiences) {
    const found = await getLoad(demoJob, audience);
    assert(
      (found != null) === sees,
      `getLoad: ${label} ${found ? "CAN" : "cannot"} open the demo listing (expected ${sees ? "can" : "cannot"})`,
    );

    const visible = await isLoadVisible(demoJob, audience);
    assert(visible === sees, `isLoadVisible: ${label} disagrees with getLoad about the demo listing`);

    const board = await searchLoads({ limit: 500 }, audience);
    const ids = new Set(board.rows.map((r) => r.id));
    assert(
      ids.has(demoJob) === sees,
      `searchLoads: ${label} ${ids.has(demoJob) ? "sees" : "does not see"} the demo listing on the board`,
    );
    assert(ids.has(realJob), `searchLoads: ${label} lost the real control listing -- the filter is too wide`);

    // The headline is computed over the whole WHERE, not the page, so a demo
    // listing that slipped into the count would be visible as a number even if
    // no row carried it. This is the "does not pollute the counts" half.
    assert(
      board.summary.count === board.total && board.total === board.rows.length,
      `searchLoads: ${label} got a summary count (${board.summary.count}) that disagrees with the rows (${board.rows.length})`,
    );

    // The real listing is reachable for everyone, always. If this ever fails,
    // the predicate stopped being about demo rows.
    const control = await getLoad(realJob, audience);
    assert(control != null, `getLoad: ${label} cannot open the real control listing`);
    assert(await isLoadVisible(realJob, audience), `isLoadVisible: ${label} cannot see the real control listing`);

    // --- the same matrix, over trucks ---------------------------------------
    //
    // `demoVisibilitySql` in truckQuery.ts is a deliberate SIBLING of the one in
    // query.ts rather than a shared fragment, because the job query path is
    // frozen for the truck feature. The cost of a copy is drift, and this is the
    // answer to it: every audience is asked the same question of both tables and
    // the two answers must agree, so a predicate that changes on one side and
    // not the other fails here rather than in production.
    const truck = await getTruck(demoTruck, "public", audience);
    assert(
      (truck != null) === sees,
      `getTruck: ${label} ${truck ? "CAN" : "cannot"} open the demo truck (expected ${sees ? "can" : "cannot"})`,
    );
    assert(
      (truck != null) === (found != null),
      `getTruck and getLoad disagree about ${label}: the two demo predicates have drifted apart`,
    );
    assert(
      (await isTruckVisible(demoTruck, "public", audience)) === sees,
      `isTruckVisible: ${label} disagrees with getTruck about the demo truck`,
    );

    const truckBoard = await searchTrucks("public", { limit: 500 }, audience);
    const truckIds = new Set(truckBoard.rows.map((r) => r.id));
    assert(
      truckIds.has(demoTruck) === sees,
      `searchTrucks: ${label} ${truckIds.has(demoTruck) ? "sees" : "does not see"} the demo truck on the board`,
    );
    assert(truckIds.has(realTruck), `searchTrucks: ${label} lost the real control truck -- the filter is too wide`);
    assert(
      truckBoard.summary.count === truckBoard.total && truckBoard.total === truckBoard.rows.length,
      `searchTrucks: ${label} got a summary count (${truckBoard.summary.count}) that disagrees with the rows (${truckBoard.rows.length})`,
    );
    // The headline is the other half: a demo truck that slipped into the counts
    // would be visible as free space even with no row carrying it.
    assert(
      (truckBoard.summary.totalFreeCf === (TRUCK.free_cf as number) * 2) === sees,
      `searchTrucks: ${label} sees ${truckBoard.summary.totalFreeCf} cf free, which ${sees ? "should" : "must not"} include the demo truck`,
    );
    assert(
      (await getTruck(realTruck, "public", audience)) != null,
      `getTruck: ${label} cannot open the real control truck`,
    );
  }

  // The scope is the OTHER predicate, and it does not depend on who is asking.
  // An admin console reaches an unreviewed row; nobody on the public board does,
  // not even the account that posted it.
  const quarantined = await insertTruck({
    ...TRUCK,
    posted_by: demoPoster.id,
    is_demo: true,
    visibility: "pending",
    truck_key: "pending-demo-truck",
  });
  assert(
    (await getTruck(quarantined, "public", { userId: demoPoster.id })) == null,
    "the demo poster can open their own truck while it is in the review queue",
  );
  assert(
    (await getTruck(quarantined, "admin", { userId: demoPoster.id })) != null,
    "an admin console cannot reach a pending truck",
  );
  assert(
    (await getTruck(quarantined, "admin")) == null,
    "an admin console with no audience sees a DEMO row -- scope must not imply includeDemo",
  );

  // The default is the strict one: a caller who passes no audience at all is
  // treated as anonymous. Forgetting the argument must cost rows, never leak.
  assert((await getLoad(demoJob)) == null, "getLoad with no audience returned the demo listing");
  assert((await getLoad(realJob)) != null, "getLoad with no audience lost the real listing");
  assert(!(await isLoadVisible(demoJob)), "isLoadVisible with no audience admitted the demo listing");
  const bare = await searchLoads({ limit: 500 });
  assert(!bare.rows.some((r) => r.id === demoJob), "searchLoads with no audience returned the demo listing");

  // Same default on the truck side. `scope` is required and cannot be forgotten;
  // the audience can be, and forgetting it must cost rows rather than leak them.
  assert((await getTruck(demoTruck, "public")) == null, "getTruck with no audience returned the demo truck");
  assert((await getTruck(realTruck, "public")) != null, "getTruck with no audience lost the real truck");
  assert(!(await isTruckVisible(demoTruck, "public")), "isTruckVisible with no audience admitted the demo truck");
  const bareTrucks = await searchTrucks("public", { limit: 500 });
  assert(!bareTrucks.rows.some((r) => r.id === demoTruck), "searchTrucks with no audience returned the demo truck");

  // A demo admin must not be an admin actor -- `includeDemo` is spelled
  // `isAdminActor(user)` at every call site, and this is what that rests on.
  const demoAdminRow = await queryOne<{ id: number; role: string; is_demo: boolean }>(
    `SELECT id, role, is_demo FROM users WHERE id = $1`,
    [demoAdmin.id],
  );
  assert(
    demoAdminRow != null &&
      !isAdminActor({
        id: demoAdminRow.id,
        email: demoAdmin.email,
        name: "",
        role: demoAdminRow.role as "admin",
        phone: null,
        company: null,
        canPost: true,
        isDemo: demoAdminRow.is_demo,
      }),
    "a demo admin passes isAdminActor, so ?demo=1 would be one click from the public sign-in page",
  );

  // Duplicates travel with a detail response, so they carry the same predicate.
  const demoRow = await getLoad(demoJob, { userId: demoPoster.id });
  assert(demoRow != null, "the demo poster cannot read back their own listing");
  assert(demoRow?.is_demo === true, "the poster's own copy does not say it is a demo listing");
  assert((await getDuplicates(demoRow!, { userId: null })).every((d) => d.id !== demoJob), "getDuplicates returned the demo listing to an anonymous caller");

  console.log(`${DIM}checked ${audiences.length} audiences against a demo listing and a real control${RESET}`);

  // --- 2b. the same matrix, through the matcher ------------------------------
  //
  // A match list is a THIRD way to reach a listing, and the newest one. It has
  // both of the shapes that leak: it reads across the two tables in one call,
  // and it is reached from a panel rather than from a URL somebody typed, so
  // nothing about it makes a reader wonder whose row they are looking at.
  //
  // The fixtures line up for this without any new ones: the demo truck and the
  // demo job share a poster, so each is matched against the OTHER side's real
  // control. Gate 3 (same party) keeps a listing out of its own owner's match
  // list, which is why the pairs cross over.
  await matchDemoChecks({
    demoJob,
    realJob,
    demoTruck,
    realTruck,
    pendingTruck: quarantined,
    audiences,
    demoPosterId: demoPoster.id,
  });

  // --- 3. the real handlers, invoked -----------------------------------------
  await liveRouteChecks(demoJob, realJob);
  await liveTruckRouteChecks(demoTruck, realTruck);

  // --- 4. the route layer as text --------------------------------------------
  routeTextChecks();

  // --- 5. the lifetime -------------------------------------------------------
  for (let i = 0; i < DEMO_KEEP + 3; i++) {
    await insertWebJob(
      { id: demoPoster.id, name: "Rosa Poster", phone: "+19085557788", isDemo: true },
      jobBody(`demo-flood-${i}`),
    );
  }
  const held = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM loads WHERE is_demo = true AND posted_by = $1`,
    [demoPoster.id],
  );
  assert(
    (held?.n ?? 0) <= DEMO_KEEP,
    `a demo account holds ${held?.n} listings after ${DEMO_KEEP + 4} posts; the sweep in insertWebJob must bound it at ${DEMO_KEEP}`,
  );
  assert((held?.n ?? 0) > 0, "the sweep deleted every demo listing, including the one just posted");

  // The sweep is scoped to the account AND to is_demo. If it ever widens, this
  // is the row it takes first.
  const stillReal = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM loads WHERE id = $1`,
    [realJob],
  );
  assert(stillReal?.n === 1, "the demo sweep deleted a real account's listing");
  const stillCorpus = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM loads WHERE posted_by IS NULL`);
  assert(
    (stillCorpus?.n ?? 0) === (corpus?.total ?? 0),
    `the demo sweep changed the WhatsApp corpus: ${corpus?.total} rows before, ${stillCorpus?.n} after`,
  );
  console.log(`${DIM}posted ${DEMO_KEEP + 4} demo listings; ${held?.n} survive, corpus and real listing untouched${RESET}`);
}

/**
 * The handlers themselves, called the way Next calls them.
 *
 * Anonymous, because that is the caller with no cookie to forge and the one the
 * hole was about: a stranger opening the live board. A demo listing must be
 * indistinguishable from an id that was never issued -- same status, and for
 * the detail route the same body -- so each assertion is made against a control
 * id one past the end of the table as well as against the real listing.
 */
async function liveRouteChecks(demoJob: number, realJob: number) {
  const { queryOne } = await import("../src/lib/db");
  const max = await queryOne<{ id: number }>(`SELECT coalesce(max(id), 0)::int AS id FROM loads`);
  const noSuchJob = (max?.id ?? 0) + 1000;

  const board = (await import("../src/app/api/loads/route")) as {
    GET: (req: Request) => Promise<Response>;
  };
  const res = await board.GET(new Request("http://localhost/api/loads?limit=500"));
  assert(res.status === 200, `GET /api/loads answered ${res.status}`);
  const body = (await res.json()) as { rows: Array<{ id: number }>; total: number };
  assert(!body.rows.some((r) => r.id === demoJob), "GET /api/loads returned the demo listing to an anonymous caller");
  assert(body.rows.some((r) => r.id === realJob), "GET /api/loads lost the real control listing");
  assert(body.total === body.rows.length, `GET /api/loads counted ${body.total} but returned ${body.rows.length}`);

  const detail = (await import("../src/app/api/loads/[id]/route")) as {
    GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  };
  const call = (id: number) =>
    detail.GET(new Request(`http://localhost/api/loads/${id}`), {
      params: Promise.resolve({ id: String(id) }),
    });

  const demoDetail = await call(demoJob);
  const missingDetail = await call(noSuchJob);
  const realDetail = await call(realJob);
  assert(demoDetail.status === 404, `GET /api/loads/:id answered ${demoDetail.status} for a demo listing`);
  assert(realDetail.status === 200, `GET /api/loads/:id answered ${realDetail.status} for the real listing`);
  const demoText = await demoDetail.text();
  assert(
    demoText === (await missingDetail.text()),
    "GET /api/loads/:id tells a demo listing apart from an id that was never issued",
  );
  assert(!demoText.includes("demo-posted-listing"), "GET /api/loads/:id echoed the demo listing's own text");

  const road = (await import("../src/app/api/loads/[id]/route/route")) as {
    GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  };
  const roadRes = await road.GET(new Request(`http://localhost/api/loads/${demoJob}/route`), {
    params: Promise.resolve({ id: String(demoJob) }),
  });
  assert(roadRes.status === 404, `GET /api/loads/:id/route answered ${roadRes.status} for a demo listing`);
  const roadReal = await road.GET(new Request(`http://localhost/api/loads/${realJob}/route`), {
    params: Promise.resolve({ id: String(realJob) }),
  });
  assert(roadReal.status === 200, `GET /api/loads/:id/route answered ${roadReal.status} for the real listing`);

  const reports = (await import("../src/app/api/reports/route")) as {
    POST: (req: Request) => Promise<Response>;
  };
  const report = (id: number) =>
    reports.POST(
      new Request("http://localhost/api/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loadId: id, reason: "not_a_job" }),
      }),
    );
  const demoReport = await report(demoJob);
  const missingReport = await report(noSuchJob);
  assert(
    demoReport.status === missingReport.status && demoReport.status === 404,
    `POST /api/reports answered ${demoReport.status} for a demo listing and ${missingReport.status} for an id that does not exist`,
  );

  console.log(`${DIM}invoked GET /api/loads, GET /api/loads/:id, GET /api/loads/:id/route and POST /api/reports anonymously${RESET}`);
}

/**
 * The truck handlers, called the way Next calls them, anonymously.
 *
 * A demo truck must be indistinguishable from an id that was never issued --
 * same status, same body -- so each assertion is made against a control id past
 * the end of the table as well as against the real control truck.
 */
async function liveTruckRouteChecks(demoTruck: number, realTruck: number) {
  const { queryOne } = await import("../src/lib/db");
  const max = await queryOne<{ id: number }>(`SELECT coalesce(max(id), 0)::int AS id FROM trucks`);
  const noSuchTruck = (max?.id ?? 0) + 1000;

  const board = (await import("../src/app/api/trucks/route")) as {
    GET: (req: Request) => Promise<Response>;
  };
  const res = await board.GET(new Request("http://localhost/api/trucks?limit=500"));
  assert(res.status === 200, `GET /api/trucks answered ${res.status}`);
  const body = (await res.json()) as {
    rows: Array<{ id: number }>;
    total: number;
    summary: { count: number; totalFreeCf: number };
  };
  assert(!body.rows.some((r) => r.id === demoTruck), "GET /api/trucks returned the demo truck to an anonymous caller");
  assert(body.rows.some((r) => r.id === realTruck), "GET /api/trucks lost the real control truck");
  assert(body.total === body.rows.length, `GET /api/trucks counted ${body.total} but returned ${body.rows.length}`);
  assert(
    body.summary.count === body.rows.length,
    `GET /api/trucks summarised ${body.summary.count} trucks over ${body.rows.length} rows -- a demo truck is in the headline`,
  );

  const detail = (await import("../src/app/api/trucks/[id]/route")) as {
    GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  };
  const call = (id: number) =>
    detail.GET(new Request(`http://localhost/api/trucks/${id}`), {
      params: Promise.resolve({ id: String(id) }),
    });

  const demoDetail = await call(demoTruck);
  const missingDetail = await call(noSuchTruck);
  const realDetail = await call(realTruck);
  assert(demoDetail.status === 404, `GET /api/trucks/:id answered ${demoDetail.status} for a demo truck`);
  assert(realDetail.status === 200, `GET /api/trucks/:id answered ${realDetail.status} for the real truck`);
  const demoText = await demoDetail.text();
  assert(
    demoText === (await missingDetail.text()),
    "GET /api/trucks/:id tells a demo truck apart from an id that was never issued",
  );
  assert(!demoText.includes("demo-posted-truck"), "GET /api/trucks/:id echoed the demo truck's own text");

  console.log(`${DIM}invoked GET /api/trucks and GET /api/trucks/:id anonymously${RESET}`);
}

// --- 2b. the matcher, audience by audience -----------------------------------

interface MatchMatrix {
  demoJob: number;
  realJob: number;
  demoTruck: number;
  realTruck: number;
  pendingTruck: number;
  audiences: Array<{ label: string; audience: { userId: number | null; includeDemo?: boolean }; sees: boolean }>;
  demoPosterId: number;
}

/**
 * A match list may never contain a listing the same caller could not open.
 *
 * Three assertions per audience, and the second is the one that makes the first
 * a check rather than a tautology: the NON-DEMO half of every match list has to
 * be identical for everybody, or a predicate that simply returned nothing would
 * pass. The third is the universal form -- every row that comes back is a row
 * `getLoad` / `getTruck` would hand the same caller -- which holds no matter
 * what the fixtures happen to be.
 */
async function matchDemoChecks(m: MatchMatrix): Promise<void> {
  const { matchesForTruck, matchesForJob, previewMatches } = await import("../src/lib/match/run");
  const { getLoad } = await import("../src/lib/loads/query");
  const { getTruck } = await import("../src/lib/loads/truckQuery");

  let jobBaseline: string | null = null;
  let truckBaseline: string | null = null;
  let sawDemoJob = false;
  let sawDemoTruck = false;

  for (const { label, audience, sees } of m.audiences) {
    const forTruck = await matchesForTruck(m.realTruck, "public", audience);
    assert(forTruck != null, `matchesForTruck: ${label} cannot open the real control truck`);
    const jobIds = (forTruck?.matches ?? []).map((x) => x.item.id);
    assert(
      jobIds.includes(m.demoJob) === sees,
      `matchesForTruck: ${label} ${jobIds.includes(m.demoJob) ? "SEES" : "does not see"} the demo job inside a match list (expected ${sees ? "sees" : "does not see"})`,
    );
    if (jobIds.includes(m.demoJob)) sawDemoJob = true;
    const nonDemoJobs = JSON.stringify(jobIds.filter((id) => id !== m.demoJob));
    if (jobBaseline == null) jobBaseline = nonDemoJobs;
    assert(
      nonDemoJobs === jobBaseline,
      `matchesForTruck: ${label} got a different set of real jobs (${nonDemoJobs}) than the first audience (${jobBaseline}) -- the predicate is doing more than hiding demo rows`,
    );
    for (const id of jobIds) {
      assert(
        (await getLoad(id, audience)) != null,
        `matchesForTruck: ${label} was handed job ${id} inside a match list but cannot open it`,
      );
    }

    const forJob = await matchesForJob(m.realJob, "public", audience);
    assert(forJob != null, `matchesForJob: ${label} cannot open the real control job`);
    const truckIds = (forJob?.matches ?? []).map((x) => x.item.id);
    assert(
      truckIds.includes(m.demoTruck) === sees,
      `matchesForJob: ${label} ${truckIds.includes(m.demoTruck) ? "SEES" : "does not see"} the demo truck inside a match list (expected ${sees ? "sees" : "does not see"})`,
    );
    if (truckIds.includes(m.demoTruck)) sawDemoTruck = true;
    assert(
      !truckIds.includes(m.pendingTruck),
      `matchesForJob: ${label} was handed a truck from the review queue inside a match list`,
    );
    const nonDemoTrucks = JSON.stringify(truckIds.filter((id) => id !== m.demoTruck));
    if (truckBaseline == null) truckBaseline = nonDemoTrucks;
    assert(
      nonDemoTrucks === truckBaseline,
      `matchesForJob: ${label} got a different set of real trucks (${nonDemoTrucks}) than the first audience (${truckBaseline})`,
    );
    for (const id of truckIds) {
      assert(
        (await getTruck(id, "public", audience)) != null,
        `matchesForJob: ${label} was handed truck ${id} inside a match list but cannot open it`,
      );
    }
  }

  // Non-vacuity. If the fixture lanes ever stop matching, every assertion above
  // passes on two empty lists and proves nothing at all.
  assert(sawDemoJob, "no audience ever saw the demo job in a match list, so the matrix above is vacuous");
  assert(sawDemoTruck, "no audience ever saw the demo truck in a match list, so the matrix above is vacuous");

  // Forgetting the audience must cost rows, never leak them.
  const bare = await matchesForTruck(m.realTruck, "public");
  assert(
    !(bare?.matches ?? []).some((x) => x.item.id === m.demoJob),
    "matchesForTruck with no audience returned the demo job",
  );
  const bareJob = await matchesForJob(m.realJob, "public");
  assert(
    !(bareJob?.matches ?? []).some((x) => x.item.id === m.demoTruck),
    "matchesForJob with no audience returned the demo truck",
  );

  // The scope is the other predicate: a truck in the review queue has no match
  // page at all, for anybody, including the account that posted it.
  assert(
    (await matchesForTruck(m.pendingTruck, "public", { userId: m.demoPosterId })) == null,
    "a pending truck's own poster can open its match list on the public scope",
  );

  // ...and the preview, which reads jobs on behalf of a draft nobody has posted.
  // `posted_by: null` so gate 3 cannot hide the demo job for the poster's own
  // audience -- what is being measured here is the demo predicate, not the
  // same-party one.
  const draft = {
    id: 0,
    status: "available" as const,
    visibility: "public" as const,
    sender_key: null,
    posted_by: null,
    origin_lat: TRUCK.origin_lat,
    origin_lng: TRUCK.origin_lng,
    dest_lat: TRUCK.dest_lat,
    dest_lng: TRUCK.dest_lng,
    corridor_miles: TRUCK.corridor_miles,
    free_cf: TRUCK.free_cf,
    avail_now: true,
    avail_from: null,
    avail_to: null,
  };
  const anonPreview = await previewMatches(draft, { userId: null });
  const posterPreview = await previewMatches(draft, { userId: m.demoPosterId });
  assert(
    posterPreview.total === anonPreview.total + 1,
    `the posting preview counted ${posterPreview.total} for the demo poster and ${anonPreview.total} anonymously -- the demo job must be in exactly one of them`,
  );

  console.log(
    `${DIM}drove matchesForTruck, matchesForJob and previewMatches over the same ${m.audiences.length} audiences${RESET}`,
  );
}

// --- 4. the route layer, as text ---------------------------------------------

/** Reads that hand back a job and therefore have to be told who is asking. */
const AUDIENCED = ["searchLoads", "getLoad", "getDuplicates", "isLoadVisible"];

/**
 * Reads that hand back a TRUCK, which have to be told two things: which rows
 * exist at all (`scope`, first and required) and who is asking (the audience).
 *
 * The scope is asserted to be the LITERAL "public" rather than merely present,
 * and that is the point of the check: a scope computed from a variable in a
 * handler a non-admin can reach is one `?admin=1` away from serving the review
 * queue. An admin console passes "admin" -- and is excluded from this scan,
 * because reading the queue is its whole purpose.
 */
const SCOPED: Record<string, { scopeAt: number; args: number }> = {
  // The scope leads a search, because it decides which rows the params are
  // filtering; it follows the id on an id-addressed read, where the id leads for
  // the same reason `getLoad(id, audience)` does. Both are required.
  searchTrucks: { scopeAt: 0, args: 3 },
  getTruck: { scopeAt: 1, args: 3 },
  isTruckVisible: { scopeAt: 1, args: 3 },
  // The owner-guarded writes read through this rather than writing their own
  // `FROM trucks`, so the ownership lookup carries the same two predicates as
  // every other truck read and a row the caller may not see 404s before it can
  // 403. Added in the same commit that created it, exactly as RAW_SOURCES is.
  truckOwner: { scopeAt: 1, args: 3 },
  // The matchers read BOTH tables -- a truck's match list is full of jobs and a
  // job's is full of trucks -- so they carry both predicates and are charged the
  // same price as every other read. Added in the commit that created them.
  matchesForTruck: { scopeAt: 1, args: 3 },
  matchesForJob: { scopeAt: 1, args: 3 },
};

/**
 * Non-admin handlers that write their own `FROM loads` SQL, and why that is
 * safe. Adding a line here is the cost of a new one, exactly as check-routes
 * charges a line for a new route: it makes "who may see this row?" a question
 * somebody answered in writing.
 */
const RAW_LOADS_SQL: Record<string, string> = {
  "PATCH /api/loads/[id]/status":
    "reads id/posted_by/status for the ownership test, then calls isLoadVisible before it acts or admits the row exists",
};

/** The balanced argument text of `name(` at `at`, or null. */
function argsOf(body: string, name: string, at: number): string | null {
  let i = body.indexOf("(", at + name.length);
  if (i === -1) return null;
  const start = ++i;
  let depth = 1;
  while (i < body.length && depth > 0) {
    const c = body[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    i++;
  }
  return depth === 0 ? body.slice(start, i - 1) : null;
}

/** True when the argument list has a comma outside any nested bracket. */
function hasSecondArgument(args: string): boolean {
  return splitArgs(args).length > 1;
}

/** The top-level arguments of a call, split on commas outside any bracket. */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = args.slice(start).trim();
  if (last || out.length) out.push(last);
  return out.filter((a, i) => a !== "" || i < out.length - 1);
}

function routeTextChecks() {
  const handlers = routeHandlers(ROOT);
  assert(handlers.length > 20, `only ${handlers.length} route handlers found -- the scanner is not reading src/app/api`);

  let scanned = 0;
  let audienced = 0;
  let scoped = 0;
  const declaredSeen = new Set<string>();

  for (const h of handlers) {
    const guard = guardOf(h.body);
    // An admin console reading a demo listing is a requirement, not a leak, and
    // cron and the webhook answer machines that hold a secret.
    if (isAdminOnly(guard) || isMachineOnly(guard)) continue;
    scanned++;

    for (const name of AUDIENCED) {
      const re = new RegExp(String.raw`\b${name}\s*\(`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(h.body))) {
        const args = argsOf(h.body, name, m.index);
        assert(
          args != null && hasSecondArgument(args),
          `${h.id} (${h.file}) calls ${name}() with no audience — a job read by a non-admin handler must be told who is asking, or a demo listing is one URL away`,
        );
        audienced++;
      }
    }

    for (const [name, shape] of Object.entries(SCOPED)) {
      const re = new RegExp(String.raw`\b${name}\s*\(`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(h.body))) {
        const args = splitArgs(argsOf(h.body, name, m.index) ?? "");
        assert(
          args[shape.scopeAt] === `"public"`,
          `${h.id} (${h.file}) calls ${name}() with scope ${args[shape.scopeAt] ?? "nothing"} — a handler a non-admin can reach must pass the literal "public", or the review queue is one query parameter away`,
        );
        assert(
          args.length >= shape.args,
          `${h.id} (${h.file}) calls ${name}() with no audience — a truck read by a non-admin handler must be told who is asking, or a demo listing is one URL away`,
        );
        scoped++;
      }
    }

    if (/\bFROM loads\b/.test(h.body)) {
      const why = RAW_LOADS_SQL[h.id];
      assert(
        why != null,
        `${h.id} (${h.file}) queries "FROM loads" directly. Route it through src/lib/loads/query.ts, or declare it in RAW_LOADS_SQL in this file with the reason it is safe`,
      );
      if (why) declaredSeen.add(h.id);
    }

    assert(
      !/\bFROM trucks\b/.test(h.body),
      `${h.id} (${h.file}) queries "FROM trucks" directly. Route it through src/lib/loads/truckQuery.ts: a hand-written truck query has neither the scope nor the audience predicate, and both are what keep an unreviewed row and a demo row off the wire`,
    );
  }

  for (const id of Object.keys(RAW_LOADS_SQL)) {
    assert(declaredSeen.has(id), `RAW_LOADS_SQL declares "${id}", which no longer reads "FROM loads" — delete the line`);
  }

  assert(scanned >= 8, `only ${scanned} non-admin handlers were scanned -- the guard classifier is over-excluding`);
  assert(audienced >= 5, `only ${audienced} audienced job reads found across the public routes -- the scanner is matching nothing`);
  assert(scoped >= 2, `only ${scoped} scoped truck reads found across the public routes -- the scanner is matching nothing`);
  console.log(
    `${DIM}scanned ${scanned} handlers a non-admin can reach; ${audienced} job reads carry an audience, ` +
      `${scoped} truck reads carry a public scope and an audience${RESET}`,
  );
}

main()
  .then(() => {
    if (failures.length) {
      console.log(`\n${RED}${failures.length} of ${checks} demo-posting checks failed${RESET}`);
      for (const f of failures) console.log(`  ${RED}✗${RESET} ${f}`);
      process.exit(1);
    }
    console.log(`\n${GREEN}✓${RESET} ${checks} demo-posting checks passed\n`);
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
