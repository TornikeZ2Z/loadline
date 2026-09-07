/**
 * Board honesty check. npm run check:sums
 *
 * ONE CLAIM, AND IT IS THE ONE THE PRODUCT IS SOLD ON:
 *
 *     "98 jobs · 42,506 cf" keeps meaning what it says.
 *
 * A truck is not a shipment. A 700 cf truck is a hole in a vehicle; a 700 cf
 * job is furniture in a warehouse. Add them and you get a plausible number, a
 * wrong number, and no error -- which is why the single-table design was
 * rejected on this point specifically (SPEC §0.4): one forgotten predicate
 * turns the board's opening statement into "104 listings · 49,506 cf", and no
 * existing gate can see it. `check:redact` can catch a leaked phone because a
 * phone is a shape in a response body. A wrong total is just a number.
 *
 * So this suite is written to fail on the REGRESSION rather than to restate
 * today's behaviour, in five layers:
 *
 *   1. THE SHAPES cannot be added. `LoadSummary` and `TruckSummary` are read
 *      out of the source and their field names compared: no name carrying a
 *      volume may appear on both. The day somebody adds `totalCf` to
 *      TruckSummary, this fails -- before any code has had the chance to sum it.
 *   2. THE SOURCE does not mention both totals on one line, anywhere under src/
 *      or scripts/. That is a coarse rule and it is meant to be: the only way to
 *      write the wrong sum is to name both quantities together.
 *   3. `truckLine()` -- the "≈ 28.3 truckloads" line -- is never called with a
 *      truck. It divides a volume of FREIGHT by the size of a truck; doing it to
 *      free space prints how many trucks fit inside your trucks (H2).
 *   4. `boardHeadline` is proved to be two independent answers: the job line is
 *      run against fifty different truck summaries and must come back
 *      byte-identical every time, and neither line may ever contain the sum or
 *      the combined count (H6). Zero trucks must produce no truck line at all,
 *      never "0 trucks" (H3).
 *   5. THE LIVE BOARD. `GET /api/loads` is imported and invoked against a
 *      seeded corpus; its six summary figures are snapshotted; then trucks are
 *      added, edited and deleted and the six are demanded back unchanged (H1).
 *
 * Plus H5, which is a different kind of honesty: a truck with no stated free
 * space says "Space not stated" and it is ONE string, in one module, that four
 * surfaces import. The way that goes wrong is a second literal typed into a
 * fourth component, so the literal is counted.
 *
 * Runs against an in-memory database (PGLITE_DIR=memory://) so it never touches
 * a real .pgdata.
 */
process.env.PGLITE_DIR = "memory://";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

/** Every .ts / .tsx under src/ and scripts/, repo-relative with "/" separators. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(p);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(path.relative(ROOT, p).split(path.sep).join("/"));
      }
    }
  };
  walk(path.join(ROOT, "src"));
  walk(path.join(ROOT, "scripts"));
  return out;
}

const FILES = sourceFiles().map((file) => {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  return { file, text, code: stripComments(text) };
});

/**
 * The same text with every comment blanked, LINE COUNT AND LINE LENGTHS
 * PRESERVED, so a reported line number still points at the right line.
 *
 * The scans below are about what the code DOES. A comment that names both
 * totals in the same sentence is usually the sentence explaining why they must
 * never be added -- this file has one, and so do truckTypes.ts and
 * truckPresent.ts. Failing on those would teach the next author to delete the
 * explanation rather than to keep the rule.
 */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i++) out += text[i] === "\n" ? "\n" : " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < text.length) {
        out += text[i];
        if (text[i] === "\\") {
          i++;
          if (i < text.length) out += text[i];
          i++;
          continue;
        }
        if (text[i] === c) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The body of `export interface <name> { … }`, or null. */
function interfaceBody(text: string, name: string): string | null {
  const at = text.indexOf(`export interface ${name} {`);
  if (at === -1) return null;
  const start = text.indexOf("{", at);
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return null;
}

/** The field names an interface body declares, ignoring comments. */
function fieldNames(body: string): string[] {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").trim())
    .map((l) => /^([A-Za-z_$][\w$]*)\??\s*:/.exec(l)?.[1])
    .filter((n): n is string => Boolean(n));
}

// --- 1. the shapes cannot be added ------------------------------------------

function shapeChecks() {
  const types = FILES.find((f) => f.file === "src/lib/loads/types.ts")!.code;
  const truckTypes = FILES.find((f) => f.file === "src/lib/loads/truckTypes.ts")!.code;

  const loadBody = interfaceBody(types, "LoadSummary");
  const truckBody = interfaceBody(truckTypes, "TruckSummary");
  assert(loadBody != null, "LoadSummary was not found in src/lib/loads/types.ts — this scan is reading nothing");
  assert(truckBody != null, "TruckSummary was not found in src/lib/loads/truckTypes.ts — this scan is reading nothing");
  if (!loadBody || !truckBody) return;

  const jobFields = fieldNames(loadBody);
  const truckFields = fieldNames(truckBody);
  assert(jobFields.length >= 5, `LoadSummary parsed to ${jobFields.length} fields`);
  assert(truckFields.length >= 5, `TruckSummary parsed to ${truckFields.length} fields`);

  // The two DO share `count` and `freshToday`, and that is fine: both are counts
  // of rows, and "6 trucks" plus "98 jobs" is a mistake of English, not of
  // arithmetic -- boardHeadline below is where that is proved impossible.
  // What may NEVER be shared is a name carrying a VOLUME, because that is the
  // one that compiles into a wrong number nobody can see.
  const volume = (n: string) => /cf/i.test(n);
  for (const name of jobFields.filter(volume)) {
    assert(
      !truckFields.includes(name),
      `"${name}" is a volume field on BOTH LoadSummary and TruckSummary. Freight and free space must not share a field name, or summary.${name} + summary.${name} compiles`,
    );
  }
  for (const name of truckFields.filter(volume)) {
    assert(
      !jobFields.includes(name),
      `"${name}" is a volume field on BOTH TruckSummary and LoadSummary`,
    );
  }
  assert(jobFields.includes("totalCf"), "LoadSummary no longer has totalCf — this check has lost its subject");
  assert(truckFields.includes("totalFreeCf"), "TruckSummary no longer has totalFreeCf — this check has lost its subject");
  assert(!truckFields.includes("totalCf"), "TruckSummary has grown a totalCf. Free space is not freight");
  assert(!jobFields.includes("totalFreeCf"), "LoadSummary has grown a totalFreeCf. Freight is not free space");

  const shared = jobFields.filter((n) => truckFields.includes(n)).sort();
  console.log(`${DIM}LoadSummary ${jobFields.length} fields, TruckSummary ${truckFields.length}; shared: ${shared.join(", ") || "none"}${RESET}`);
}

// --- 2. no line names both totals -------------------------------------------

function lineChecks() {
  let scanned = 0;
  for (const { file, code } of FILES) {
    if (file === "scripts/check-sums.ts") continue;
    scanned++;
    code.split("\n").forEach((line, i) => {
      assert(
        !(line.includes("totalCf") && line.includes("totalFreeCf")),
        `${file}:${i + 1} names both totalCf and totalFreeCf on one line. Freight and free space are different quantities: ${line.trim()}`,
      );
    });
  }
  console.log(`${DIM}scanned ${scanned} source files for a line naming both totals${RESET}`);
}

// --- 3. truckLine() is jobs-only ---------------------------------------------

/** The balanced argument text of `name(` starting at `at`. */
function argsOf(body: string, at: number): string {
  let i = body.indexOf("(", at);
  if (i === -1) return "";
  const start = ++i;
  let depth = 1;
  while (i < body.length && depth > 0) {
    const c = body[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    i++;
  }
  return body.slice(start, i - 1);
}

/** The first argument of an argument list, split at the top level only. */
function firstArg(args: string): string {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) return args.slice(0, i);
  }
  return args;
}

function truckLineChecks() {
  let calls = 0;
  for (const { file, code } of FILES) {
    if (file === "scripts/check-sums.ts") continue;
    const re = /\btruckLine\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      // `headline.truckLine` is a STRING on boardHeadline's return, not this
      // function; and `export function truckLine(` is the declaration, whose
      // parameter is named `truckCf` for the viewer's own vehicle.
      const before = code.slice(Math.max(0, m.index - 10), m.index);
      if (before.endsWith(".") || /\bfunction\s+$/.test(before)) continue;
      calls++;
      const arg = firstArg(argsOf(code, m.index)).trim();
      assert(
        !/free/i.test(arg) && !/\btrucks?\b/i.test(arg),
        `${file}: truckLine(${arg}) is being given something truck-shaped. "≈ N truckloads" divides a volume of FREIGHT by the size of a truck; over free space it prints how many trucks fit inside your trucks`,
      );
    }
  }
  assert(calls > 0, "no truckLine() call sites found — the scan is reading nothing");
  console.log(`${DIM}checked ${calls} truckLine() call sites${RESET}`);
}

// --- H5: one string for an unstated size -------------------------------------

function unstatedSizeChecks() {
  const literal = '"Space not stated"';
  const owners = FILES.filter(
    (f) => f.file !== "scripts/check-sums.ts" && f.code.includes(literal),
  );
  assert(
    owners.length === 1 && owners[0].file === "src/lib/loads/truckPresent.ts",
    `"Space not stated" is written literally in ${owners.length} files (${owners.map((o) => o.file).join(", ")}). It must live in exactly one — src/lib/loads/truckPresent.ts — and be imported, or four surfaces will drift into four sentences`,
  );
  // And never the thing it exists instead of.
  for (const { file, code } of FILES) {
    if (file === "scripts/check-sums.ts") continue;
    assert(
      !/free_cf\s*\?\?\s*0/.test(code),
      `${file} defaults free_cf to 0. An unknown free space is unknown, never zero`,
    );
  }
}

// --- the two constants truckFilters.ts copies from FilterBar -----------------

function constantChecks() {
  const bar = FILES.find((f) => f.file === "src/components/FilterBar.tsx")!.code;
  const truck = FILES.find((f) => f.file === "src/components/truckFilters.ts")!.code;
  const barExact = /^const EXACT = "([^"]+)";/m.exec(bar)?.[1];
  const truckExact = /^const EXACT = "([^"]+)";/m.exec(truck)?.[1];
  const barRadius = /^const DEFAULT_RADIUS = (\d+);/m.exec(bar)?.[1];
  const truckRadius = /^const DEFAULT_RADIUS = "(\d+)";/m.exec(truck)?.[1];
  assert(
    barExact != null && barExact === truckExact,
    `FilterBar's EXACT is ${barExact} and truckFilters' is ${truckExact}: the truck board would send "this city only" as a radius`,
  );
  assert(
    barRadius != null && barRadius === truckRadius,
    `FilterBar's DEFAULT_RADIUS is ${barRadius} and truckFilters' is ${truckRadius}: the two boards would answer the same search at different distances`,
  );
}

// --- 4. boardHeadline ---------------------------------------------------------

async function headlineChecks() {
  const { boardHeadline, freeSpaceLabel, SPACE_NOT_STATED } = await import(
    "../src/lib/loads/truckPresent"
  );
  const jobs = {
    count: 98,
    totalCf: 42506,
    withCf: 98,
    readyNow: 73,
    freshToday: 12,
    priced: 2,
    medianPricePerCf: 3.38,
  };

  // H3: zero trucks, no truck line. Not "0 trucks".
  const zero = boardHeadline(jobs, {
    count: 0,
    totalFreeCf: 0,
    withFreeCf: 0,
    departingToday: 0,
    noDestination: 0,
    freshToday: 0,
    medianCorridorMiles: null,
  });
  assert(zero.truckLine === null, `zero trucks produced a truck line: ${zero.truckLine}`);
  assert(
    boardHeadline(jobs, null).truckLine === null,
    "a null truck summary produced a truck line",
  );
  assert(
    !zero.jobLine.includes("truck"),
    `the job line mentions trucks: ${zero.jobLine}`,
  );
  assert(zero.jobLine === "98 jobs · 42,506 cf", `the job line is ${zero.jobLine}`);

  // The property that matters: the job line does not depend on the trucks.
  // Fifty different truck summaries, one answer.
  const baseline = boardHeadline(jobs, null).jobLine;
  for (let i = 1; i <= 50; i++) {
    const trucks = {
      count: i,
      totalFreeCf: i * 137,
      withFreeCf: Math.max(0, i - 1),
      departingToday: i % 5,
      noDestination: i % 3,
      freshToday: i % 7,
      medianCorridorMiles: 25 + i,
    };
    const out = boardHeadline(jobs, trucks);
    assert(
      out.jobLine === baseline,
      `boardHeadline's job line changed when the trucks did (${trucks.count} trucks): ${out.jobLine}`,
    );

    // H6: neither line may carry the sum or the combined count, in any of the
    // three ways a number reaches a screen.
    const forbidden = [
      jobs.totalCf + trucks.totalFreeCf,
      jobs.count + trucks.count,
    ];
    for (const n of forbidden) {
      for (const shape of [String(n), n.toLocaleString("en-US")]) {
        assert(
          !out.jobLine.includes(shape) && !(out.truckLine ?? "").includes(shape),
          `boardHeadline printed ${shape}, which is a combined figure: ${out.jobLine} / ${out.truckLine}`,
        );
      }
    }

    assert(
      out.truckLine != null && out.truckLine.includes("cf free"),
      `the truck line does not use the unit phrase "cf free": ${out.truckLine}`,
    );
    assert(
      !(out.truckLine ?? "").includes("job"),
      `the truck line mentions jobs: ${out.truckLine}`,
    );
    assert(
      !(out.truckLine ?? "").includes("truckload"),
      `the truck line prints a truckload equivalent, which is a statement about freight volume: ${out.truckLine}`,
    );
  }

  // H5, at the source: one function, one string, and never a zero.
  const unstated = freeSpaceLabel({ free_cf: null, truck_cf: 1600, free_source: null, truck_text: "26 ft box truck" });
  assert(unstated.text === SPACE_NOT_STATED, `an unstated free space reads "${unstated.text}"`);
  assert(unstated.stated === false, "an unstated free space reported itself as stated");
  assert(!unstated.text.includes("0"), `an unstated free space printed a zero: ${unstated.text}`);
  const stated = freeSpaceLabel({ free_cf: 700, truck_cf: 1600, free_source: "stated", truck_text: null });
  assert(stated.text === "700 cf free", `a stated free space reads "${stated.text}"`);

  console.log(`${DIM}boardHeadline held its job line across 50 truck summaries${RESET}`);
}

// --- 5. the live board -------------------------------------------------------

/** The six figures H1 names, read off the real handler's real response. */
interface JobFigures {
  count: number;
  totalCf: number;
  withCf: number;
  readyNow: number;
  freshToday: number;
  priced: number;
  medianPricePerCf: number | null;
}

async function boardFigures(): Promise<JobFigures> {
  const board = (await import("../src/app/api/loads/route")) as {
    GET: (req: Request) => Promise<Response>;
  };
  const res = await board.GET(new Request("http://localhost/api/loads?limit=500"));
  if (res.status !== 200) throw new Error(`GET /api/loads answered ${res.status}`);
  const body = (await res.json()) as { summary: JobFigures };
  return body.summary;
}

async function liveChecks() {
  const { resetDemoData } = await import("../src/lib/demo/reset");
  const { query } = await import("../src/lib/db");
  const { insertTruck, truckCorpus } = await import("./fixtures/trucks");
  const { searchTrucks } = await import("../src/lib/loads/truckQuery");

  const seeded = await resetDemoData();
  assert(seeded.loadsCreated > 0, "the corpus seeded no jobs, so nothing below proves anything");

  const before = await boardFigures();
  assert(before.count > 0, `GET /api/loads reported ${before.count} jobs before any truck existed`);

  const now = new Date();
  const ids: number[] = [];
  for (const seed of truckCorpus(now)) ids.push(await insertTruck(seed));
  // Enough of them that a sum would be unmistakable, and enough free space that
  // the combined figure is a number a person could believe.
  for (let i = 0; i < 6; i++) {
    ids.push(
      await insertTruck({
        origin_label: `Test City ${i}, NJ 070${10 + i}`,
        origin_city: `Test City ${i}`,
        origin_state: "NJ",
        origin_lat: 40.7 + i / 100,
        origin_lng: -74.1 - i / 100,
        origin_precision: "city",
        free_cf: 700,
        free_source: "form",
        avail_now: true,
        corridor_miles: 60,
        truck_key: `sums-${i}`,
        shape: "form",
        first_seen_at: now.toISOString(),
        last_seen_at: now.toISOString(),
        seen_count: 1,
      }),
    );
  }

  const truckBoard = await searchTrucks("public", { limit: 500 }, { userId: null, includeDemo: false });
  assert(truckBoard.summary.count >= 10, `only ${truckBoard.summary.count} public trucks were seeded`);
  assert(truckBoard.summary.totalFreeCf > 0, "the seeded trucks state no free space at all");

  const withTrucks = await boardFigures();
  for (const key of ["count", "totalCf", "withCf", "readyNow", "freshToday", "priced", "medianPricePerCf"] as const) {
    assert(
      withTrucks[key] === before[key],
      `GET /api/loads summary.${key} moved from ${before[key]} to ${withTrucks[key]} when ${ids.length} trucks were added. A truck is not a shipment`,
    );
  }

  // The two numbers nobody may ever see.
  //
  // Scoped to the SUMMARY object, which is the thing the headline is built
  // from -- not to the whole payload, where 108 is also a plausible job id and
  // a plausible cubic-feet figure and the check would be superstition rather
  // than a test. The rendered-DOM half of H6 belongs to the integration walk,
  // which reads the board rather than the wire.
  const combinedCf = before.totalCf + truckBoard.summary.totalFreeCf;
  const combinedCount = before.count + truckBoard.summary.count;
  const summaryJson = JSON.stringify(withTrucks);
  for (const n of [combinedCf, combinedCount]) {
    assert(
      !summaryJson.includes(String(n)),
      `GET /api/loads summary contains ${n}, which is the jobs total plus the trucks total: ${summaryJson}`,
    );
  }

  // Editing a truck.
  await query(`UPDATE trucks SET free_cf = 1200, avail_now = false WHERE id = $1`, [ids[0]]);
  const afterEdit = await boardFigures();
  for (const key of ["count", "totalCf", "withCf", "readyNow", "freshToday", "priced"] as const) {
    assert(
      afterEdit[key] === before[key],
      `GET /api/loads summary.${key} moved to ${afterEdit[key]} when a truck was EDITED`,
    );
  }

  // Removing one.
  await query(`DELETE FROM trucks WHERE id = $1`, [ids[ids.length - 1]]);
  const afterDelete = await boardFigures();
  for (const key of ["count", "totalCf", "withCf", "readyNow", "freshToday", "priced"] as const) {
    assert(
      afterDelete[key] === before[key],
      `GET /api/loads summary.${key} moved to ${afterDelete[key]} when a truck was REMOVED`,
    );
  }

  console.log(
    `${DIM}${before.count} jobs · ${before.totalCf.toLocaleString("en-US")} cf held still across ${ids.length} trucks (${truckBoard.summary.totalFreeCf.toLocaleString("en-US")} cf free) added, edited and removed${RESET}`,
  );
}

async function main() {
  shapeChecks();
  lineChecks();
  truckLineChecks();
  unstatedSizeChecks();
  constantChecks();
  await headlineChecks();
  await liveChecks();

  if (failures.length) {
    console.log(`\n${RED}${failures.length} of ${checks} board-honesty checks failed${RESET}`);
    for (const f of failures) console.log(`  ${RED}✗${RESET} ${f}`);
    process.exit(1);
  }
  console.log(`\n${GREEN}✓${RESET} ${checks} board-honesty checks passed\n`);
  process.exit(0);
}

void main();
