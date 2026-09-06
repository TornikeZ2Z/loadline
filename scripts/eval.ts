/**
 * Extraction eval. npm run eval
 *
 * Runs every case in eval-cases.ts through the real extractor and reports what
 * broke. Pure functions all the way down -- no database, no network -- so it
 * finishes in milliseconds and can be run on every edit.
 *
 * Exit code is non-zero when anything fails, so it can gate a commit.
 */
import { extractLoads } from "../src/lib/extract";
import { resolveDatePhrase } from "../src/lib/extract/dates";
import { normalizePhone } from "../src/lib/extract/phone";
import { CASES, type ExpectedLoad } from "./eval-cases";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface Failure {
  case: string;
  detail: string;
}

function main() {
  const failures: Failure[] = [];
  let checks = 0;
  let passedCases = 0;

  // A fixed send time keeps relative dates ("tomorrow") deterministic.
  const sentAt = new Date("2026-09-03T14:00:00Z");

  for (const testCase of CASES) {
    const before = failures.length;
    const outcome = extractLoads({
      body: testCase.body,
      authorName: testCase.author ?? null,
      authorPhone: testCase.authorPhone ?? null,
      groupName: "Eval",
      sentAt,
    });

    const fail = (detail: string) => failures.push({ case: testCase.name, detail });

    if (testCase.expect === null) {
      checks++;
      if (outcome.is_load_post || outcome.loads.length) {
        fail(
          `expected no loads, got ${outcome.loads.length}: ` +
            outcome.loads.map((l) => `${l.pickup_location} -> ${l.delivery_location}`).join(" | "),
        );
      }
    } else {
      const expected = testCase.expect;
      checks++;
      if (outcome.loads.length !== expected.length) {
        fail(
          `expected ${expected.length} load(s), got ${outcome.loads.length}` +
            (outcome.loads.length
              ? `: ${outcome.loads.map((l) => `${l.pickup_location} -> ${l.delivery_location}`).join(" | ")}`
              : ` (reason: ${outcome.reason})`),
        );
      }

      expected.forEach((want, i) => {
        const got = outcome.loads[i];
        if (!got) return;
        checks += compare(want, got, sentAt, fail, i);
      });
    }

    if (failures.length === before) passedCases++;
  }

  const total = CASES.length;
  console.log(
    `\n${passedCases === total ? GREEN : RED}${passedCases}/${total} cases passed${RESET} ` +
      `${DIM}(${checks} assertions)${RESET}\n`,
  );

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

/** Returns how many assertions were made. */
function compare(
  want: ExpectedLoad,
  got: {
    pickup_location: string;
    delivery_location: string;
    // Optional because inventory-v1 carries these as legacy fields it never
    // emits; this harness is rewritten alongside the new extractor.
    pickup_date_text?: string | null;
    load_type?: string | null;
    weight_lbs?: number | null;
    pallets?: number | null;
    rate_usd?: number | null;
    contact_name: string | null;
    contact_phone: string | null;
  },
  sentAt: Date,
  fail: (detail: string) => void,
  index: number,
): number {
  let n = 0;
  const at = `load ${index + 1}`;

  n++;
  if (got.pickup_location !== want.pickup) {
    fail(`${at} pickup: expected "${want.pickup}", got "${got.pickup_location}"`);
  }
  n++;
  if (got.delivery_location !== want.delivery) {
    fail(`${at} delivery: expected "${want.delivery}", got "${got.delivery_location}"`);
  }

  if (want.dayOffset !== undefined) {
    n++;
    const iso = resolveDatePhrase(got.pickup_date_text, sentAt);
    const expectedIso = new Date(sentAt.getTime() + want.dayOffset * 86_400_000)
      .toISOString()
      .slice(0, 10);
    if (iso !== expectedIso) {
      fail(`${at} date: expected ${expectedIso}, got ${iso} (from "${got.pickup_date_text}")`);
    }
  }

  const scalar = <T>(label: string, expected: T | undefined, actual: T) => {
    if (expected === undefined) return;
    n++;
    if (actual !== expected) fail(`${at} ${label}: expected ${expected}, got ${actual}`);
  };

  scalar("loadType", want.loadType, got.load_type);
  scalar("weightLbs", want.weightLbs, got.weight_lbs);
  scalar("pallets", want.pallets, got.pallets);
  scalar("rateUsd", want.rateUsd, got.rate_usd);
  scalar("contact", want.contact, got.contact_name);

  if (want.phoneEndsWith !== undefined) {
    n++;
    const digits = normalizePhone(got.contact_phone).e164?.replace(/\D/g, "") ?? "";
    if (!digits.endsWith(want.phoneEndsWith)) {
      fail(`${at} phone: expected ending ${want.phoneEndsWith}, got ${got.contact_phone}`);
    }
  }

  return n;
}

main();
