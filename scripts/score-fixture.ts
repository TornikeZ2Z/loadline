/**
 * Score the extractor against the REAL WhatsApp messages. npm run score
 *
 * This is the number that matters for the moving-industry pivot: of the 94
 * jobs a human reads out of six real group posts, how many does the extractor
 * produce with the right origin, the right destination and the right cubic
 * feet -- and how many does it invent?
 *
 * Deliberately separate from the eval suite and deliberately written before
 * the new extractor: the implementation is graded by a test it did not write.
 *
 * Matching is tolerant of *formatting* and strict about *facts*:
 *   - destination matches on the ZIP (or city+state when the post had no ZIP)
 *   - origin matches on the city name (state too when the fixture gives one)
 *   - CF must be exactly equal
 */
import { REAL_MESSAGES } from "./fixtures/real-whatsapp";
import { extractLoads } from "../src/lib/extract";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface Produced {
  origin: string;
  dest: string;
  cf: number | null;
}

/** Read whatever shape the extractor emits into a comparable record. */
function toProduced(load: Record<string, unknown>): Produced {
  const cf =
    (load.cubic_feet as number | null | undefined) ??
    (load.cf as number | null | undefined) ??
    null;
  return {
    origin: String(load.pickup_location ?? ""),
    dest: String(load.delivery_location ?? ""),
    cf: cf == null ? null : Number(cf),
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function destMatches(expected: string, produced: string): boolean {
  const e = norm(expected);
  const p = norm(produced);
  const zip = e.match(/\b\d{5}\b/)?.[0];
  if (zip) return p.includes(zip);
  // No ZIP in the post ("CO Denver"): need the city and the state.
  const [state, ...city] = e.split(" ");
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
  // Accept either the abbreviation or the full name.
  return p.includes(state) || e === p;
}

function main() {
  let expectedTotal = 0;
  let fullyCorrect = 0;
  let destOk = 0;
  let originOk = 0;
  let cfOk = 0;
  let fabricated = 0;
  const problems: string[] = [];

  for (const m of REAL_MESSAGES) {
    const expected = m.expected.flatMap((o) => o.jobs.map((j) => ({ origin: o.origin, dest: j[0], cf: j[1] })));
    const out = extractLoads({
      body: m.body,
      authorName: m.author,
      authorPhone: m.authorPhone,
      groupName: m.group,
      sentAt: new Date("2026-09-06T15:00:00Z"),
    });
    const produced = out.loads.map((l) => toProduced(l as unknown as Record<string, unknown>));
    const used = new Set<number>();

    let msgFull = 0;
    for (const want of expected) {
      expectedTotal++;
      // Best candidate: same destination, not yet claimed.
      const idx = produced.findIndex((p, i) => !used.has(i) && destMatches(want.dest, p.dest));
      if (idx === -1) {
        problems.push(`${m.format}: MISSED  ${want.origin} -> ${want.dest} ${want.cf}cf`);
        continue;
      }
      used.add(idx);
      const got = produced[idx];
      destOk++;
      const o = originMatches(want.origin, got.origin);
      const c = got.cf === want.cf;
      if (o) originOk++;
      if (c) cfOk++;
      if (o && c) {
        fullyCorrect++;
        msgFull++;
      } else {
        problems.push(
          `${m.format}: PARTIAL ${want.origin} -> ${want.dest} ${want.cf}cf  got origin="${got.origin}" cf=${got.cf}`,
        );
      }
    }
    const extra = produced.length - used.size;
    fabricated += extra;
    if (extra > 0) {
      produced.forEach((p, i) => {
        if (!used.has(i)) problems.push(`${m.format}: FABRICATED ${p.origin} -> ${p.dest} ${p.cf ?? "?"}cf`);
      });
    }

    const colour = msgFull === expected.length && extra === 0 ? GREEN : msgFull === 0 ? RED : YELLOW;
    console.log(
      `${colour}${m.format.padEnd(24)}${RESET} ${String(msgFull).padStart(2)}/${String(expected.length).padEnd(2)} fully correct` +
        `${extra ? `  ${RED}+${extra} fabricated${RESET}` : ""}` +
        (!out.is_load_post ? `  ${DIM}(extractor said: ${out.reason})${RESET}` : ""),
    );
  }

  const pct = Math.round((fullyCorrect / expectedTotal) * 100);
  const colour = fullyCorrect === expectedTotal && fabricated === 0 ? GREEN : pct >= 90 ? YELLOW : RED;
  console.log(
    `\n${colour}${fullyCorrect}/${expectedTotal} jobs fully correct (${pct}%)${RESET}` +
      `${DIM}  destination ${destOk}  origin ${originOk}  cf ${cfOk}  fabricated ${fabricated}${RESET}\n`,
  );

  if (problems.length) {
    const shown = problems.slice(0, 40);
    for (const p of shown) console.log(`  ${p}`);
    if (problems.length > shown.length) console.log(`  ${DIM}… ${problems.length - shown.length} more${RESET}`);
    console.log("");
  }

  if (fullyCorrect < expectedTotal || fabricated > 0) process.exit(1);
}

main();
