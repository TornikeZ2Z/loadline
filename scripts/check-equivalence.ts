/**
 * Equivalence gate.  npm run check:equiv
 *
 * Stage 0 of the truck-space feature moves working code between files and adds
 * nothing a user can see. "No behaviour change" is a claim, and a claim in a
 * commit message is worth nothing, so this script is the evidence:
 *
 *   T-A1  every SQL statement `searchLoads` builds, for 31 fixed searches, is
 *         byte-identical to a committed snapshot -- statement text AND bind
 *         values.  Recorded through a `pg` driver stand-in, so the statements
 *         are the ones the shipped code sends, not a transcription of them.
 *         See scripts/lib/search-sql.ts.
 *   T-A2  the corridor search over a frozen board returns the same rows in the
 *         same order with the same off_route_miles / detour_miles /
 *         route_progress.
 *   T-A3  `buildGroups` over the same frozen board produces a byte-identical
 *         GeoJSON FeatureCollection at both map ends.
 *
 * The board is frozen in scripts/fixtures/board-corpus.json -- every row of
 * `whatsapp_groups`, `raw_messages` and `loads` from a database seeded by
 * `npm run seed`, coordinates and all.  Nothing here geocodes, and nothing here
 * touches the network or a persistent database: the corpus is loaded into an
 * in-memory PGlite.  That is what makes a byte-identical assertion honest --
 * a snapshot that moved because HERE returned a different centroid would be a
 * false alarm, and a gate that cries wolf is a gate people re-record.
 *
 * A DIFFERENCE IS A BUG UNTIL PROVEN OTHERWISE.  `--record` exists so the
 * snapshots can be created and, one day, deliberately updated; it is not the
 * response to a red run.  Whitespace counts.
 *
 *   npm run check:equiv                  verify (the gate)
 *   npx tsx scripts/check-equivalence.ts --record          rewrite the snapshots
 *   npx tsx scripts/check-equivalence.ts --record-corpus   re-freeze the board
 *                                                          from ./.pgdata
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ARGS = process.argv.slice(2);
const RECORD = ARGS.includes("--record");
const RECORD_CORPUS = ARGS.includes("--record-corpus");

// Re-freezing reads the developer's own seeded ./.pgdata; everything else runs
// against the committed corpus in a database that never touches a disk.
if (!RECORD_CORPUS) process.env.PGLITE_DIR = "memory://";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const ROOT = process.cwd();
const CORPUS = path.join(ROOT, "scripts", "fixtures", "board-corpus.json");
const SNAP_DIR = path.join(ROOT, "scripts", "fixtures", "equivalence");

interface Corpus {
  _provenance: Record<string, unknown>;
  groups: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  senders: Array<Record<string, unknown>>;
  loads: Array<Record<string, unknown>>;
}

let failures = 0;
let checks = 0;

/**
 * Compare against the committed snapshot, or write it.
 *
 * The report on a mismatch is a line number and the two lines, not "differs":
 * the whole point of the gate is that the person who broke it can see what
 * moved without re-running anything.
 */
function snapshot(name: string, actual: string): void {
  checks++;
  const file = path.join(SNAP_DIR, name);
  if (RECORD) {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    fs.writeFileSync(file, actual);
    console.log(`  ${DIM}recorded${RESET} ${name} ${DIM}(${actual.length} bytes)${RESET}`);
    return;
  }
  if (!fs.existsSync(file)) {
    failures++;
    console.log(`  ${RED}✗${RESET} ${name}: no snapshot committed (run with --record once, deliberately)`);
    return;
  }
  const expected = fs.readFileSync(file, "utf8");
  if (expected === actual) {
    console.log(`  ${GREEN}✓${RESET} ${name} ${DIM}byte-identical (${actual.length} bytes)${RESET}`);
    return;
  }
  failures++;
  const a = expected.split("\n");
  const b = actual.split("\n");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  console.log(`  ${RED}✗${RESET} ${name}: differs at line ${i + 1} of ${a.length} committed / ${b.length} produced`);
  console.log(`      ${DIM}committed${RESET} ${JSON.stringify(a[i] ?? "<end of file>")}`);
  console.log(`      ${DIM}produced ${RESET} ${JSON.stringify(b[i] ?? "<end of file>")}`);
}

/**
 * JSON hands back strings where the database had timestamps, which is what a
 * timestamptz/date column wants anyway. Only jsonb needs re-encoding: an object
 * would be bound as a record, an array is a text[]/bigint[] and stays one.
 */
function insertable(v: unknown): unknown {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) return JSON.stringify(v);
  return v;
}

async function loadCorpus(): Promise<Corpus> {
  if (!fs.existsSync(CORPUS)) {
    throw new Error(`missing ${CORPUS} -- re-freeze it with --record-corpus against a seeded database`);
  }
  return JSON.parse(fs.readFileSync(CORPUS, "utf8")) as Corpus;
}

async function insertRows(table: string, rows: Array<Record<string, unknown>>): Promise<void> {
  if (!rows.length) return;
  const { query } = await import("../src/lib/db");
  const cols = Object.keys(rows[0]!);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
  for (const row of rows) {
    await query(
      `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${placeholders})`,
      cols.map((c) => insertable(row[c])),
    );
  }
  // The frozen ids are the ids: leave the sequence where the corpus left it so
  // anything inserted later cannot collide. `senders` is keyed by text and has
  // no sequence to move.
  if (cols.includes("id")) {
    await query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'), (SELECT max(id) FROM ${table}))`,
      [table],
    );
  }
}

// --- re-freezing the board ---------------------------------------------------

async function recordCorpus(): Promise<void> {
  const { query } = await import("../src/lib/db");
  const groups = await query<Record<string, unknown>>(
    `SELECT id, wa_group_id, name, description, invite_url FROM whatsapp_groups ORDER BY id`,
  );
  // `extracted` and `payload` are large audit blobs no board query reads; the
  // bodies are what make this corpus worth freezing.
  const messages = await query<Record<string, unknown>>(
    `SELECT id, group_id, wa_message_id, author_name, author_phone, body, sent_at, received_at,
            status, skip_reason, error, attempts, extractor, processed_at
       FROM raw_messages ORDER BY id`,
  );
  // `loads.sender_key` is a foreign key into `senders`, so the board is not
  // insertable without them.
  const senders = await query<Record<string, unknown>>(`SELECT * FROM senders ORDER BY key`);
  const loads = await query<Record<string, unknown>>(`SELECT * FROM loads ORDER BY id`);
  const out: Corpus = {
    _provenance: {
      what: "every row of whatsapp_groups, raw_messages (minus the `extracted`/`payload` audit blobs), senders and loads",
      from: "a database seeded by `npm run seed` from src/lib/demo/sample-messages.ts",
      frozen_at: new Date().toISOString(),
      why: "so the T-A2 and T-A3 snapshots are byte-stable on any machine, offline, with no geocoder in the loop",
      phones: "the seed's 555 placeholders, the same discipline as scripts/fixtures/real-whatsapp.ts",
      rebuild: "npx tsx scripts/check-equivalence.ts --record-corpus",
    },
    groups,
    messages,
    senders,
    loads,
  };
  fs.writeFileSync(CORPUS, JSON.stringify(out, null, 1) + "\n");
  console.log(
    `froze ${loads.length} loads, ${messages.length} messages, ${senders.length} senders, ` +
      `${groups.length} groups -> ${path.relative(ROOT, CORPUS)}`,
  );
}

// --- T-A1 --------------------------------------------------------------------

function checkSearchSql(): void {
  console.log(`${BOLD}T-A1${RESET} the SQL searchLoads builds`);
  // A child process, because the tap replaces the `pg` module for the whole
  // process and this one is already holding a PGlite backend open.
  const res = spawnSync(
    process.execPath,
    [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), path.join(ROOT, "scripts", "lib", "search-sql.ts")],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    failures++;
    checks++;
    console.log(`  ${RED}✗${RESET} search-sql.ts exited ${res.status}\n${res.stderr}`);
    return;
  }
  snapshot("searchloads-sql.txt", res.stdout.replace(/\r\n/g, "\n"));
}

// --- T-A2 --------------------------------------------------------------------

const MIAMI = { lat: 25.7617, lng: -80.1918, label: "Miami, FL", precision: "city" };
const NORTH_JERSEY = { lat: 40.7357, lng: -74.1724, label: "Newark, NJ", precision: "city" };
const LA = { lat: 34.0522, lng: -118.2437, label: "Los Angeles, CA", precision: "city" };
const CHICAGO = { lat: 41.8781, lng: -87.6298, label: "Chicago, IL", precision: "city" };

async function checkCorridor(): Promise<void> {
  console.log(`${BOLD}T-A2${RESET} the corridor search over the frozen board`);
  const { searchLoads } = await import("../src/lib/loads/query");

  const cases: Array<{ name: string; input: Parameters<typeof searchLoads>[0] }> = [
    {
      name: "Miami -> North Jersey, 75 mi (the spec's case)",
      input: { routeMode: "corridor", origin: MIAMI, destination: NORTH_JERSEY, corridorMiles: 75 },
    },
    {
      name: "Miami -> North Jersey, 150 mi",
      input: { routeMode: "corridor", origin: MIAMI, destination: NORTH_JERSEY, corridorMiles: 150 },
    },
    {
      name: "Miami -> North Jersey, default width",
      input: { routeMode: "corridor", origin: MIAMI, destination: NORTH_JERSEY },
    },
    {
      name: "North Jersey -> Miami, 75 mi (the other direction)",
      input: { routeMode: "corridor", origin: NORTH_JERSEY, destination: MIAMI, corridorMiles: 75 },
    },
    {
      name: "Los Angeles -> Chicago, 100 mi",
      input: { routeMode: "corridor", origin: LA, destination: CHICAGO, corridorMiles: 100 },
    },
    {
      name: "Miami -> North Jersey, 75 mi, paged",
      input: { routeMode: "corridor", origin: MIAMI, destination: NORTH_JERSEY, corridorMiles: 75, limit: 3, offset: 2 },
    },
    {
      name: "Miami -> North Jersey, 75 mi, sized 300..500",
      input: { routeMode: "corridor", origin: MIAMI, destination: NORTH_JERSEY, corridorMiles: 75, minCf: 300, maxCf: 500 },
    },
  ];

  const out: unknown[] = [];
  for (const { name, input } of cases) {
    const r = await searchLoads(input);
    out.push({
      case: name,
      total: r.total,
      applied: r.applied,
      // `summarizeRows` is not part of this stage's lift, but the deterministic
      // half of it is free coverage. `readyNow` and `freshToday` are measured
      // against the wall clock and would decay a frozen snapshot into a daily
      // false alarm, so they are not asserted -- said out loud rather than
      // quietly dropped.
      summary: {
        count: r.summary.count,
        totalCf: r.summary.totalCf,
        withCf: r.summary.withCf,
        priced: r.summary.priced,
        medianPricePerCf: r.summary.medianPricePerCf,
        readyNow: "<measured against the wall clock; not asserted>",
        freshToday: "<measured against the wall clock; not asserted>",
      },
      rows: r.rows.map((row) => ({
        id: row.id,
        off_route_miles: row.off_route_miles ?? null,
        detour_miles: row.detour_miles ?? null,
        route_progress: row.route_progress ?? null,
        pickup_label: row.pickup_label,
        delivery_label: row.delivery_label,
      })),
    });
  }
  snapshot("corridor.json", JSON.stringify(out, null, 1) + "\n");
}

// --- T-A3 --------------------------------------------------------------------

async function checkMapFeatures(): Promise<void> {
  console.log(`${BOLD}T-A3${RESET} the map's features over the frozen board`);
  const { searchLoads } = await import("../src/lib/loads/query");
  const { toPublicLoads } = await import("../src/lib/loads/publicView");
  const { buildGroups } = await import("../src/lib/geo/points");

  const { rows } = await searchLoads({ limit: 500 });
  const jobs = toPublicLoads(rows);

  const out: Record<string, unknown> = { jobs: jobs.length };
  for (const end of ["pickup", "delivery"] as const) {
    const built = buildGroups(jobs, end);
    out[end] = {
      plotted: built.plotted,
      groups: built.groups,
      features: built.features,
      keyByJob: [...built.keyByJob.entries()],
    };
  }
  snapshot("map-features.json", JSON.stringify(out, null, 1) + "\n");
}

// --- main --------------------------------------------------------------------

async function main() {
  if (RECORD_CORPUS) {
    await recordCorpus();
    process.exit(0);
  }

  const corpus = await loadCorpus();
  const { dbKind } = await import("../src/lib/db");
  console.log(
    `${DIM}${await dbKind()} in memory · frozen board: ${corpus.loads.length} loads, ` +
      `${corpus.messages.length} messages, ${corpus.senders.length} senders, ${corpus.groups.length} groups${RESET}`,
  );
  await insertRows("whatsapp_groups", corpus.groups);
  await insertRows("raw_messages", corpus.messages);
  await insertRows("senders", corpus.senders);
  await insertRows("loads", corpus.loads);

  if (RECORD) console.log(`${RED}${BOLD}--record: rewriting the snapshots.${RESET}`);
  console.log("");

  checkSearchSql();
  await checkCorridor();
  await checkMapFeatures();

  console.log("");
  if (failures) {
    console.log(`${RED}${BOLD}equivalence  ${checks - failures}/${checks}${RESET}`);
    console.log(
      `${DIM}A snapshot that moved is a behaviour change until someone explains it.\n` +
        `Investigate the diff; do not re-record to make this green.${RESET}`,
    );
    process.exit(1);
  }
  console.log(`${GREEN}${BOLD}equivalence  ${checks}/${checks} byte-identical${RESET}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
