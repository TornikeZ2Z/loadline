/**
 * Extraction eval. npm run eval
 *
 * Runs every case through the real extractor -- the six real messages, the
 * variants, the negatives, and whatever the admin queue has taught
 * (scripts/fixtures/learned-rules.json + scripts/fixtures/learned/*.json,
 * written by `npm run rules:export`) -- and reports what broke. Pure functions
 * all the way down: no database, no network, milliseconds.
 *
 * Matching is order-insensitive and tolerant of formatting, strict about
 * facts, exactly like scripts/score-fixture.ts: every expected job claims the
 * best unclaimed produced job by destination and origin, then cf and every
 * defined optional field must agree; a produced job nobody claimed is a
 * fabrication and fails the case. Each case must reach its baseline (a ratchet).
 *
 * Exit code is non-zero when anything fails, so it can gate a commit.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractInventory, EMPTY_RULES, KNOWN_SIGNATURES, scopedRules, type RuleSet } from "../src/lib/extract";
import { resolveDatePhrase } from "../src/lib/extract/dates";
import { normalizePhone } from "../src/lib/extract/phone";
import { CASES, EVAL_SENT_AT, realMessageCases, type EvalCase, type ExpectedJob } from "./eval-cases";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

// --- tolerant matchers (mirrors score-fixture.ts, which is frozen) ------------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function destMatches(expected: string, produced: string): boolean {
  const e = norm(expected);
  const p = norm(produced);
  const zip = e.match(/\b\d{5}\b/)?.[0];
  if (zip) return p.includes(zip);
  const [state, ...city] = e.split(" ");
  if (!city.length) return p === state || p.startsWith(`${state} `) || p.endsWith(` ${state}`);
  return p.includes(city.join(" ")) && (p.includes(` ${state} `) || p.endsWith(` ${state}`) || p.startsWith(`${state} `));
}

function originMatches(expected: string, produced: string): boolean {
  const e = norm(expected);
  const p = norm(produced);
  const [cityPart, statePart] = expected.split(",").map((x) => norm(x));
  const city = cityPart.replace(/\b\d{5}\b/, "").trim();
  if (!p.includes(city)) return false;
  const state = statePart?.replace(/\b\d{5}\b/, "").trim();
  if (!state) return true;
  return p.includes(state) || e === p;
}

// --- learned fixtures ---------------------------------------------------------

function loadLearnedRules(): RuleSet {
  const file = path.join(FIXTURES, "learned-rules.json");
  if (!fs.existsSync(file)) return EMPTY_RULES;
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<RuleSet>;
  return {
    places: raw.places ?? {},
    ignoreLines: raw.ignoreLines ?? [],
    keywords: raw.keywords ?? [],
    lineTemplates: raw.lineTemplates ?? [],
    senderFormats: raw.senderFormats ?? {},
  };
}

function loadLearnedCases(): EvalCase[] {
  const dir = path.join(FIXTURES, "learned");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as {
        body: string; author?: string | null; authorPhone?: string | null; sentAt?: string; expected: ExpectedJob[];
      };
      return {
        name: `learned ${f}`,
        body: j.body,
        author: j.author ?? undefined,
        authorPhone: j.authorPhone ?? null,
        sentAt: j.sentAt ?? EVAL_SENT_AT,
        expect: j.expected,
      };
    });
}

/**
 * The sender key the pipeline would derive for a case (mirrors
 * reconcile.ts senderKeyFor without importing the database), so sender-scoped
 * learned rules apply only to that sender's cases.
 */
function senderKeyOf(tc: EvalCase): string | null {
  const phone = normalizePhone(tc.authorPhone ?? null).e164;
  if (phone) return `phone:${phone}`;
  const slug = (tc.author ?? "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug ? `name:0:${slug}` : null;
}

// --- the run ------------------------------------------------------------------

interface Failure { case: string; detail: string }

function main() {
  const rules = loadLearnedRules();
  const real = realMessageCases();
  const learned = loadLearnedCases();
  const all = [...real, ...CASES, ...learned];
  const failures: Failure[] = [];
  let realTotal = 0;
  let realCorrect = 0;
  let passedCases = 0;

  for (const tc of all) {
    const before = failures.length;
    const fail = (d: string) => failures.push({ case: tc.name, detail: d });
    const sentAt = new Date(tc.sentAt ?? EVAL_SENT_AT);
    // A `sender_format` rule reaches the extractor as a hint, not through the
    // RuleSet (process.ts §"senderHints"). Without this an accepted case whose
    // origin came from an admin-taught sender default replays as `no_origin`,
    // so the export → eval round-trip could never confirm the rule that fixed
    // it. There is no prior snapshot in an eval run, hence lastOrigin: null.
    const senderKey = senderKeyOf(tc);
    const format = (senderKey && rules.senderFormats[senderKey]) || null;
    const out = extractInventory(
      {
        body: tc.body,
        authorName: tc.author ?? "Tester",
        authorPhone: tc.authorPhone ?? null,
        groupName: "Eval",
        sentAt,
        senderHints: { lastOrigin: null, defaultOrigin: format?.default_origin ?? null, format },
      },
      scopedRules(rules, senderKey),
    );

    if (out.extractor !== "inventory-v1") fail(`extractor is ${out.extractor}`);
    const isReal = real.includes(tc);
    if (isReal) {
      const n = tc.body.split("\n").length;
      if (out.lines.length !== n) fail(`line audit covers ${out.lines.length} of ${n} lines`);
      if (!KNOWN_SIGNATURES.has(out.format_signature)) fail(`format signature not in KNOWN_SIGNATURES: ${out.format_signature}`);
    }

    if (tc.expect === null) {
      if (out.is_load_post || out.loads.length) {
        fail(`expected no jobs, got ${out.loads.length}: ` + out.loads.map((l) => `${l.pickup_location} -> ${l.delivery_location}`).join(" | "));
      }
    } else {
      const used = new Set<number>();
      let correct = 0;
      const line = (i: number) => `${out.loads[i].pickup_location} -> ${out.loads[i].delivery_location} ${out.loads[i].cubic_feet ?? "?"}cf`;
      for (const want of tc.expect) {
        const idx = out.loads.findIndex((l, i) => !used.has(i) && destMatches(want.dest, l.delivery_location) && originMatches(want.origin, l.pickup_location));
        if (idx < 0) {
          const dest = out.loads.findIndex((l, i) => !used.has(i) && destMatches(want.dest, l.delivery_location));
          fail(`MISSED ${want.origin} -> ${want.dest} ${want.cf ?? "?"}cf` + (dest >= 0 ? ` (destination found with origin "${out.loads[dest].pickup_location}")` : ` (reason: ${out.reason})`));
          continue;
        }
        used.add(idx);
        const got = out.loads[idx];
        let ok = true;
        const check = <T>(label: string, expected: T | undefined, actual: T) => {
          if (expected === undefined) return;
          if (actual !== expected) { fail(`${line(idx)}: ${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); ok = false; }
        };
        check("cf", want.cf, got.cubic_feet);
        check("pricePerCf", want.pricePerCf, got.price_per_cf);
        check("priceFlat", want.priceFlat, got.price_flat);
        check("ready", want.ready, got.ready_now);
        check("readySource", want.readySource, got.ready_source);
        if (want.readyDate !== undefined) check("readyDate", want.readyDate, resolveDatePhrase(got.ready_date_text, sentAt));
        if (want.tags) for (const t of want.tags) if (!got.tags.includes(t)) { fail(`${line(idx)}: missing tag ${t} (got ${got.tags.join(",") || "none"})`); ok = false; }
        if (want.notesIncludes !== undefined && !(got.notes ?? "").includes(want.notesIncludes)) { fail(`${line(idx)}: notes "${got.notes}" lack "${want.notesIncludes}"`); ok = false; }
        if (want.flagsInclude) for (const f of want.flagsInclude) if (!got.flags.includes(f)) { fail(`${line(idx)}: missing flag ${f} (got ${got.flags.join(",") || "none"})`); ok = false; }
        if (ok) correct++;
      }
      out.loads.forEach((l, i) => { if (!used.has(i)) fail(`FABRICATED ${l.pickup_location} -> ${l.delivery_location} ${l.cubic_feet ?? "?"}cf`); });
      const baseline = tc.baseline ?? tc.expect.length;
      if (correct < baseline) fail(`${correct}/${tc.expect.length} fully correct, below baseline ${baseline}`);
      if (isReal) { realTotal += tc.expect.length; realCorrect += correct; }
      if (isReal) console.log(`${correct === tc.expect.length ? GREEN : RED}${tc.name.padEnd(30)}${RESET} ${String(correct).padStart(2)}/${tc.expect.length}`);
    }

    for (const f of tc.expectFlags ?? []) if (!out.flags.includes(f)) fail(`missing message flag ${f} (got ${out.flags.join(",") || "none"})`);
    for (const f of tc.expectNotFlags ?? []) if (out.flags.includes(f) || out.loads.some((l) => l.flags.includes(f))) fail(`unexpected flag ${f}`);
    if (tc.expectContact) {
      if (tc.expectContact.name !== undefined && out.contact.name !== tc.expectContact.name) fail(`contact name expected "${tc.expectContact.name}", got "${out.contact.name}"`);
      if (tc.expectContact.phoneEndsWith !== undefined) {
        const digits = normalizePhone(out.contact.phone).e164?.replace(/\D/g, "") ?? "";
        if (!digits.endsWith(tc.expectContact.phoneEndsWith)) fail(`contact phone expected ending ${tc.expectContact.phoneEndsWith}, got ${out.contact.phone}`);
      }
    }
    if (tc.expectRequirements !== undefined && out.requirements.length !== tc.expectRequirements) {
      fail(`expected ${tc.expectRequirements} requirement line(s), got ${out.requirements.length}: ${out.requirements.join(" | ")}`);
    }

    if (failures.length === before) passedCases++;
  }

  const total = all.length;
  console.log(`\n${realCorrect === realTotal ? GREEN : RED}${realCorrect}/${realTotal} real jobs${RESET}  ${DIM}(rules: ${Object.keys(rules.places).length} places, ${rules.keywords.length} keywords, ${rules.ignoreLines.length} ignores, ${rules.lineTemplates.length} templates; ${learned.length} learned cases)${RESET}`);
  console.log(`${passedCases === total ? GREEN : RED}${passedCases}/${total} cases passed${RESET}\n`);

  if (failures.length) {
    for (const f of failures) {
      console.log(`${RED}✗${RESET} ${f.case}`);
      console.log(`   ${f.detail}`);
    }
    console.log("");
    process.exit(1);
  }
  console.log(`${GREEN}✓${RESET} extraction rules are behaving\n`);
}

main();
