/**
 * Capacity survey. npm run survey:capacity  [--all-lines] [--limit N]
 *
 * READ-ONLY. It counts what is already in `raw_messages` and prints a report.
 * It writes nothing, extracts nothing, and creates no trucks -- there is no
 * `trucks` table yet. Every statement it issues goes through `read()` below,
 * which refuses anything that is not a SELECT.
 *
 * WHY IT EXISTS
 *
 * Stage 6 of the truck feature teaches the parser to recognise a mover offering
 * space. That is the one stage that can put a falsehood on the board: a false
 * positive invents a vehicle that does not exist, and the product's whole claim
 * is that it does not invent. The vocabulary in §7.2 of the spec, the ownership
 * test in §7.3 and the four message-level gates in §7.4 are all guesses until
 * somebody counts what the corpus actually contains. This is the counting.
 *
 * WHAT IT ANSWERS
 *
 *   - how many messages carry supply vocabulary at all, and which phrases fire
 *     (a phrase that never fires is a phrase to drop; a phrase that fires on
 *     brokers asking for a truck is a phrase to narrow);
 *   - what those lines look like -- with two lines of context, because a supply
 *     header with its details underneath is shape C5 and a supply line inside
 *     an inventory is a fabrication waiting to happen;
 *   - how many carry a ZIP, and how many a cubic-feet figure, decided by the
 *     production tokenizer rather than by a regex invented here;
 *   - how many would be refused, and by which gate;
 *   - and the one that matters most: how many supply lines ALREADY BECAME JOBS.
 *     `loads.line_text` holds the line each job was cut from, so a supply line
 *     that appears there is a truck the board is currently printing as freight.
 *     That is the §7.0 defect, measured rather than asserted.
 *
 * WHAT IT IS NOT
 *
 * It is not a gate and it does not run in CI. It reports on whatever database
 * it is pointed at, and it says so at the top of its output, because a survey
 * of the demo seed is not a survey of the WhatsApp corpus and reading one as
 * the other is exactly how a parser gets built against traffic that does not
 * exist. Point it at production with DATABASE_URL to survey production.
 */
import { query } from "../src/lib/db";
import { tokenizeBody } from "../src/lib/extract/tokens";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const ARGS = process.argv.slice(2);
const ALL_LINES = ARGS.includes("--all-lines");
const LIMIT = (() => {
  const i = ARGS.indexOf("--limit");
  const n = i >= 0 ? Number(ARGS[i + 1]) : NaN;
  return Number.isFinite(n) ? n : 40;
})();

/** Every statement this script runs. Nothing else touches the database. */
async function read<T extends object>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (!/^\s*select\b/i.test(sql)) throw new Error(`the survey is read-only; refused: ${sql.slice(0, 60)}`);
  reads++;
  return query<T>(sql, params);
}
let reads = 0;

// --- the vocabulary ----------------------------------------------------------
//
// A working copy of spec §7.2, held here because `src/lib/extract/capacity.ts`
// does not exist until stage 6. WHEN IT DOES, THESE ARRAYS MOVE THERE AND THIS
// FILE IMPORTS THEM. Two copies of the vocabulary is how the survey starts
// measuring something the parser no longer does.
//
// `LEXICON` in the extractor is deliberately not touched: adding a phrase to it
// changes tokenisation for every line that contains it.

/** Unambiguously an offer. No subject needed. */
const OFFER_CLEAR = [
  "space available", "available space", "space open", "open space",
  "free space", "partial space", "spots available", "backhaul available",
  "going empty", "running empty", "returning empty", "coming back empty",
  "heading back empty", "deadhead", "deadheading", "dead head",
  "empty truck", "truck empty", "truck available", "available truck",
  "empty in", "empty at", "empty out of",
  "espacio disponible", "camion vacio", "voy vacio",
];

/** Supply ONLY with a first-person subject on the same line: every one of these
 *  is also the standard way a broker ASKS for a truck. */
const OFFER_OWNED = [
  "have room", "have space", "has room", "has space", "got room", "got space",
  "room for", "space for", "room available",
  "can take", "can fit", "can carry", "can haul", "can load",
  "space on the truck", "space on my truck", "space on our truck",
  "tengo espacio", "hay espacio",
];

const FIRST_PERSON = [
  "i", "im", "i'm", "we", "we're", "my", "our", "me", "us",
  "my truck", "our truck", "mi", "estoy", "tengo", "voy", "regreso",
];

/** A hard veto, evaluated BEFORE any offer test. */
const DEMAND = [
  "need", "needs", "needed", "looking for", "look for", "in search of",
  "searching for", "want", "wanted", "who has", "who's got", "whos got",
  "anyone have", "anybody have", "anyone with", "anybody with",
  "anyone that", "anybody that", "anyone who", "any truck", "any trucks",
  "busco", "necesito",
];

/** The escape that keeps a real truck alive: a demand phrase whose object is
 *  FREIGHT is a driver looking for work, not a broker looking for a truck. */
const FREIGHT_OBJECT = [
  "load", "loads", "freight", "work", "job", "jobs", "cargo", "shipment",
  "shipments", "anything", "backhaul", "carga", "trabajo",
];

/** A broker's terms wearing a truck's words. Hard refusal. */
const BROKER_TERMS = [
  "min", "minimum", "max", "maximum", "to book", "must have", "no brokers",
  "double brokering", "cargo insurance", "mc number", "dot number",
];

const NEGATORS = ["no", "not", "dont", "don't", "isn't", "isnt", "without", "sin", "nada"];
const INTERROGATIVE = ["who", "anyone", "anybody", "any1", "does anyone", "quien", "alguien"];
const GROUP_RULE = ["please do not", "reminder:", "reminder ", "rule", "not allowed", "no posts"];

/** Words the spec names as too dangerous to add, counted so the ban has a number. */
const WATCHLIST = ["empty", "available", "availability", "heading", "driving", "space", "room"];

// --- matching ----------------------------------------------------------------

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Word-boundary match that survives apostrophes and trailing punctuation. */
function findPhrase(line: string, phrase: string): number {
  const re = new RegExp(`(?<![a-z0-9])${escapeRe(phrase)}(?![a-z0-9])`, "i");
  return line.search(re);
}
const has = (line: string, phrase: string) => findPhrase(line, phrase) >= 0;
const hasAny = (line: string, list: string[]) => list.some((p) => has(line, p));

/** The tokens after a phrase, skipping the articles §7.3 step 6 skips. */
const SKIP = new Set(["a", "an", "the", "some", "any", "for", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
function objectAfter(line: string, phrase: string): string | null {
  const at = findPhrase(line, phrase);
  if (at < 0) return null;
  const rest = line.slice(at + phrase.length).split(/[^a-z0-9']+/i).filter(Boolean);
  for (const w of rest) {
    if (SKIP.has(w)) continue;
    return w;
  }
  return null;
}

interface Verdict {
  offerClear: string[];
  offerOwned: string[];
  firstPerson: boolean;
  /** The refusal §7.3 would reach first, or null if the line is a supply line. */
  refusal: string | null;
  demandObject: string | null;
}

/** §7.3, in order. Rule suppression (step 1) needs extraction_rules and is
 *  reported separately; nothing in the corpus can carry an `ignore_capacity`
 *  rule yet because the kind does not exist. */
function judge(line: string): Verdict {
  const offerClear = OFFER_CLEAR.filter((p) => has(line, p));
  const offerOwned = OFFER_OWNED.filter((p) => has(line, p));
  const firstPerson = hasAny(line, FIRST_PERSON);
  const v: Verdict = { offerClear, offerOwned, firstPerson, refusal: null, demandObject: null };

  if (hasAny(line, GROUP_RULE)) v.refusal = "group_rule";
  else if (hasAny(line, BROKER_TERMS)) v.refusal = "broker_terms";
  else if (/\?\s*$/.test(line)) v.refusal = "question";
  else if (INTERROGATIVE.some((w) => new RegExp(`^${escapeRe(w)}(?![a-z0-9])`, "i").test(line)))
    v.refusal = "question";
  else {
    for (const d of DEMAND) {
      if (!has(line, d)) continue;
      const obj = objectAfter(line, d);
      v.demandObject = obj;
      if (!obj || !FREIGHT_OBJECT.includes(obj)) {
        v.refusal = "demand_veto";
        break;
      }
    }
  }

  if (!v.refusal) {
    const offer = offerClear[0] ?? offerOwned[0];
    if (offer) {
      const at = findPhrase(line, offer);
      const before = line.slice(0, at).split(/[^a-z0-9']+/i).filter(Boolean).slice(-2);
      if (before.some((w) => NEGATORS.includes(w))) v.refusal = "negated";
    }
  }

  if (!v.refusal && !offerClear.length && !(offerOwned.length && firstPerson)) {
    v.refusal = "no_supply_line";
  }
  return v;
}

// --- the probe ---------------------------------------------------------------
//
// A survey that finds nothing has proved nothing unless the instrument works.
// These are the worked examples the spec itself writes down -- the five shapes
// in §7.5 and the seed set in §8.2 -- run through the same `judge()` the corpus
// scan uses, with the verdict the spec predicts beside it.
//
// A disagreement here is not a bug in this script. It is the spec's rules
// failing to produce the spec's own example, which is the exact failure §8.2
// warns about ("an earlier draft shipped a fixture table where four of nine
// positives could not be produced by the rules in the same document"). Finding
// it now costs nothing; finding it while writing capacity-posts.ts costs the
// fixture its authority, because the person who hits it will be tempted to
// edit the ground truth instead of the rules.

interface Probe {
  line: string;
  /** null = the spec expects this to reach §7.4 as a supply line. */
  expect: string | null;
  from: string;
}

const PROBES: Probe[] = [
  { from: "§7.5 C1", line: "Have room for 700 cf NJ to FL Friday", expect: null },
  { from: "§7.5 C2", line: "Space available Newark to Miami", expect: null },
  { from: "§7.5 C3", line: "I'm driving Dallas to Denver Friday, can take 400cf", expect: null },
  { from: "§7.5 C4", line: "Going empty to FL 33101 tomorrow, room for 500", expect: null },
  { from: "§7.5 C5", line: "🚛 SPACE AVAILABLE 🚛", expect: null },
  { from: "§7.0", line: "Space on my truck 300cf, Denver CO 80202, can go anywhere west", expect: null },
  { from: "§7.3 ex.", line: "empty in Newark, looking for loads to the midwest", expect: null },
  { from: "§8.2", line: "Have room. Call me.", expect: null },
  { from: "§8.2", line: "MIN 500 CF TO BOOK", expect: "broker_terms" },
  { from: "§8.2", line: "Need 400cf to go to FL", expect: "demand_veto" },
  { from: "§7.3 ex.", line: "Need someone that can take 800 cf from Newark to Atlanta", expect: "demand_veto" },
  { from: "§7.3 ex.", line: "Looking for a truck with space for 400cf out of Kearny to Miami", expect: "demand_veto" },
  { from: "§7.3 ex.", line: "I need a truck that can fit 600cf NJ to FL", expect: "demand_veto" },
  { from: "§8.2", line: "who has anything out of newark nj tomorrow", expect: "question" },
  { from: "§8.2", line: "anyone have room to FL?", expect: "question" },
  // The same ask without the punctuation, because half of WhatsApp omits it.
  { from: "adversarial", line: "anyone have room to FL", expect: "question" },
  { from: "§8.2", line: "no room left this week", expect: "negated" },
  { from: "eval negative", line: "No driver availability posts in this group.", expect: "no_supply_line" },
];

function runProbes(): { agreed: number; disagreements: string[] } {
  const disagreements: string[] = [];
  let agreed = 0;
  console.log(`\n${BOLD}The instrument${RESET}  ${DIM}the spec's own worked examples through the same test${RESET}`);
  for (const p of PROBES) {
    const norm = normalize(p.line);
    const v = judge(norm);
    const got = v.refusal;
    const ok = got === p.expect;
    if (ok) agreed++;
    else disagreements.push(`${p.from}: ${JSON.stringify(p.line)} -- spec says ${p.expect ?? "supply line"}, rules say ${got ?? "supply line"}`);
    const { tokens } = tokenizeBody(p.line).lines[0] ?? { tokens: [] };
    const extra = [
      tokens.some((t) => t.cls === "ZIP") ? "ZIP" : "",
      tokens.some((t) => t.cls === "CF_UNIT" || t.cls === "CF_PREFIX") ? "cf" : "",
    ].filter(Boolean).join(" ");
    console.log(
      `  ${ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`} ${DIM}${p.from.padEnd(15)}${RESET}` +
        `${(got ?? "supply line").padEnd(15)} ${DIM}${extra.padEnd(7)}${RESET} ${JSON.stringify(p.line)}`,
    );
    if (!ok) console.log(`        ${YELLOW}spec says ${p.expect ?? "supply line"}${RESET}`);
  }
  return { agreed, disagreements };
}

// --- the corpus --------------------------------------------------------------

interface Msg {
  id: number;
  body: string;
  sent_at: string;
  author_name: string | null;
  author_phone: string | null;
  group_name: string | null;
  status: string;
  skip_reason: string | null;
  jobs: number;
}

function pct(n: number, of: number): string {
  return of ? `${((n / of) * 100).toFixed(0)}%` : "--";
}

async function main() {
  const messages = await read<Msg>(
    `SELECT m.id, m.body, m.sent_at::text AS sent_at, m.author_name, m.author_phone,
            g.name AS group_name, m.status, m.skip_reason,
            (SELECT count(*)::int FROM loads l WHERE l.source_message_id = m.id) AS jobs
       FROM raw_messages m
       LEFT JOIN whatsapp_groups g ON g.id = m.group_id
      ORDER BY m.id`,
  );
  const span = await read<{ lo: string | null; hi: string | null; senders: number; groups: number }>(
    `SELECT min(sent_at)::text AS lo, max(sent_at)::text AS hi,
            count(DISTINCT coalesce(author_phone, author_name))::int AS senders,
            count(DISTINCT group_id)::int AS groups
       FROM raw_messages`,
  );
  // Every job's own line, so a supply line that already became freight can be
  // recognised by the text it was cut from.
  const jobLines = await read<{ line_text: string | null; source_message_id: number | null; id: number }>(
    `SELECT id, line_text, source_message_id FROM loads WHERE line_text IS NOT NULL`,
  );
  const jobLineByMsg = new Map<number, Map<string, number>>();
  for (const j of jobLines) {
    if (j.source_message_id == null || !j.line_text) continue;
    let m = jobLineByMsg.get(j.source_message_id);
    if (!m) jobLineByMsg.set(j.source_message_id, (m = new Map()));
    m.set(normalize(j.line_text), j.id);
  }

  const backend = process.env.DATABASE_URL ? "Postgres (DATABASE_URL)" : "PGlite (./.pgdata)";
  console.log(`${BOLD}Capacity survey${RESET}`);
  console.log(`${DIM}read-only; it reports on the database it is pointed at and nothing else${RESET}\n`);
  console.log(`  corpus     ${messages.length} messages in ${backend}`);
  console.log(`  span       ${span[0]?.lo ?? "--"}  ..  ${span[0]?.hi ?? "--"}`);
  console.log(`  senders    ${span[0]?.senders ?? 0} distinct · ${span[0]?.groups ?? 0} groups`);
  console.log(
    `  jobs       ${messages.reduce((n, m) => n + m.jobs, 0)} rows in \`loads\` came out of these messages`,
  );

  // --- scan ------------------------------------------------------------------

  interface Hit {
    msg: Msg;
    lineNo: number;
    text: string;
    norm: string;
    context: string[];
    verdict: Verdict;
    hasZip: boolean;
    hasCf: boolean;
    cfValue: number | null;
    becameJob: number | null;
    msgJobs: number;
  }

  const hits: Hit[] = [];
  const phraseHits = new Map<string, number>();
  const watchHits = new Map<string, number>();
  const messagesWithSupplyVocab = new Set<number>();
  const messagesWithSupplyLine = new Set<number>();

  for (const msg of messages) {
    const { lines } = tokenizeBody(msg.body);
    for (const L of lines) {
      const norm = normalize(L.text);
      if (!norm) continue;

      for (const w of WATCHLIST) if (has(norm, w)) watchHits.set(w, (watchHits.get(w) ?? 0) + 1);

      const clear = OFFER_CLEAR.filter((p) => has(norm, p));
      const owned = OFFER_OWNED.filter((p) => has(norm, p));
      if (!clear.length && !owned.length) continue;
      for (const p of [...clear, ...owned]) phraseHits.set(p, (phraseHits.get(p) ?? 0) + 1);
      messagesWithSupplyVocab.add(msg.id);

      const verdict = judge(norm);
      if (!verdict.refusal) messagesWithSupplyLine.add(msg.id);

      const cf = L.tokens.find((t) => t.cls === "CF_UNIT" || t.cls === "CF_PREFIX");
      hits.push({
        msg,
        lineNo: L.n,
        text: L.text,
        norm,
        context: [lines[L.n - 1]?.text ?? "", lines[L.n + 1]?.text ?? ""],
        verdict,
        hasZip: L.tokens.some((t) => t.cls === "ZIP"),
        hasCf: Boolean(cf),
        cfValue: typeof cf?.value === "number" ? cf.value : null,
        becameJob: jobLineByMsg.get(msg.id)?.get(norm) ?? null,
        msgJobs: msg.jobs,
      });
    }
  }

  // --- the headline ----------------------------------------------------------

  const supply = hits.filter((h) => !h.verdict.refusal);
  const refused = hits.filter((h) => h.verdict.refusal);
  const withZip = supply.filter((h) => h.hasZip);
  const withCf = supply.filter((h) => h.hasCf);
  const inJobPost = supply.filter((h) => h.msgJobs > 0);
  const alreadyFreight = hits.filter((h) => h.becameJob != null);

  console.log(`\n${BOLD}What the vocabulary finds${RESET}`);
  console.log(
    `  ${hits.length} lines carry a §7.2 offer phrase, in ${messagesWithSupplyVocab.size} of ` +
      `${messages.length} messages (${pct(messagesWithSupplyVocab.size, messages.length)})`,
  );
  console.log(
    `  ${supply.length} survive §7.3's ownership test, in ${messagesWithSupplyLine.size} messages` +
      `${supply.length ? "" : `  ${DIM}-- nothing in this corpus offers space${RESET}`}`,
  );
  console.log(`  ${refused.length} are refused before the offer test`);

  if (refused.length) {
    const byCode = new Map<string, number>();
    for (const h of refused) byCode.set(h.verdict.refusal!, (byCode.get(h.verdict.refusal!) ?? 0) + 1);
    for (const [code, n] of [...byCode].sort((a, b) => b[1] - a[1])) {
      console.log(`      ${String(n).padStart(4)}  ${code}`);
    }
  }

  console.log(`\n${BOLD}What a surviving supply line carries${RESET}`);
  console.log(`  ZIP           ${withZip.length}/${supply.length} (${pct(withZip.length, supply.length)})`);
  console.log(`  cubic feet    ${withCf.length}/${supply.length} (${pct(withCf.length, supply.length)})`);
  console.log(
    `  both          ${supply.filter((h) => h.hasZip && h.hasCf).length}/${supply.length}` +
      `  ${DIM}(the §7.0 shape: a capacity line with a ZIP is classified DESTINATION today)${RESET}`,
  );
  console.log(
    `  neither       ${supply.filter((h) => !h.hasZip && !h.hasCf).length}/${supply.length}` +
      `  ${DIM}(needs an origin from the header or a <24 h sender hint -- shape C4, always held)${RESET}`,
  );

  console.log(`\n${BOLD}Ambiguity against the job rules${RESET}`);
  console.log(
    `  ${inJobPost.length} supply lines sit in a message that ALSO produced jobs` +
      `  ${DIM}(§7.7: jobs win, the truck becomes a candidate and a counter)${RESET}`,
  );
  const line = `  ${alreadyFreight.length} offer lines are ALREADY a row in \`loads\``;
  if (alreadyFreight.length) {
    console.log(`${RED}${line}  -- each one is a truck the board prints as freight${RESET}`);
    for (const h of alreadyFreight.slice(0, LIMIT)) {
      console.log(`      load ${h.becameJob} · message ${h.msg.id} · ${JSON.stringify(h.text)}`);
    }
  } else {
    console.log(`${line}  ${DIM}(none -- the §7.0 defect is not firing on this corpus)${RESET}`);
  }

  console.log(`\n${BOLD}Which phrases fire${RESET}`);
  if (!phraseHits.size) {
    console.log(`  ${DIM}none of the ${OFFER_CLEAR.length + OFFER_OWNED.length} offer phrases occurs in this corpus${RESET}`);
  } else {
    for (const [p, n] of [...phraseHits].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${JSON.stringify(p)}`);
    }
  }
  console.log(
    `  ${DIM}silent: ${[...OFFER_CLEAR, ...OFFER_OWNED].filter((p) => !phraseHits.has(p)).length} of ` +
      `${OFFER_CLEAR.length + OFFER_OWNED.length}${RESET}`,
  );

  console.log(`\n${BOLD}The watchlist${RESET}  ${DIM}words §7.2 forbids adding to OFFER_CLEAR${RESET}`);
  for (const w of WATCHLIST) {
    const n = watchHits.get(w) ?? 0;
    const flag = n && !phraseHits.size ? `${YELLOW}  <- would fire on ${n} lines that offer nothing${RESET}` : "";
    console.log(`  ${String(n).padStart(4)}  ${JSON.stringify(w)}${flag}`);
  }

  // --- the lines themselves --------------------------------------------------

  const shown = ALL_LINES ? hits : hits.slice(0, LIMIT);
  if (hits.length) {
    console.log(`\n${BOLD}The lines${RESET}  ${DIM}${shown.length} of ${hits.length}, two lines of context${RESET}`);
    for (const h of shown) {
      const verdict = h.verdict.refusal
        ? `${DIM}refused ${h.verdict.refusal}${RESET}`
        : `${GREEN}supply line${RESET}`;
      console.log(
        `\n  ${DIM}message ${h.msg.id} · ${h.msg.group_name ?? "no group"} · ${h.msg.sent_at.slice(0, 16)} · ` +
          `${h.msgJobs} jobs · status ${h.msg.status}${h.msg.skip_reason ? `/${h.msg.skip_reason}` : ""}${RESET}`,
      );
      if (h.context[0]) console.log(`  ${DIM}  ${h.context[0]}${RESET}`);
      console.log(`  ${BOLD}> ${h.text}${RESET}`);
      if (h.context[1]) console.log(`  ${DIM}  ${h.context[1]}${RESET}`);
      const bits = [
        verdict,
        h.verdict.offerClear.length ? `clear=${JSON.stringify(h.verdict.offerClear[0])}` : "",
        h.verdict.offerOwned.length ? `owned=${JSON.stringify(h.verdict.offerOwned[0])}` : "",
        h.verdict.firstPerson ? "first-person" : "",
        h.verdict.demandObject ? `demand object=${JSON.stringify(h.verdict.demandObject)}` : "",
        h.hasZip ? "ZIP" : "",
        h.hasCf ? `${h.cfValue ?? "?"} cf` : "",
        h.becameJob != null ? `${RED}already load ${h.becameJob}${RESET}` : "",
      ].filter(Boolean);
      console.log(`  ${DIM}·${RESET} ${bits.join(` ${DIM}·${RESET} `)}`);
    }
    if (!ALL_LINES && hits.length > shown.length) {
      console.log(`\n  ${DIM}${hits.length - shown.length} more; pass --all-lines${RESET}`);
    }
  }

  // --- does the instrument work? ---------------------------------------------

  const probe = runProbes();
  console.log(
    `  ${probe.agreed}/${PROBES.length} agree with the spec` +
      (probe.disagreements.length ? `  ${RED}${probe.disagreements.length} do not${RESET}` : ""),
  );
  if (probe.disagreements.length) {
    console.log(`\n${BOLD}${YELLOW}Findings for stage 6${RESET}  ${DIM}the spec's rules do not produce the spec's examples${RESET}`);
    for (const d of probe.disagreements) console.log(`  · ${d}`);
  }

  // --- what this does and does not prove -------------------------------------

  console.log(`\n${BOLD}Read this before quoting it${RESET}`);
  if (messages.length < 100) {
    console.log(
      `  ${YELLOW}This corpus holds ${messages.length} messages.${RESET} That is a demo seed, not WhatsApp\n` +
        `  traffic. Every count above describes it and nothing else. Stage 6's rules\n` +
        `  need this run against production (DATABASE_URL) before any of them is\n` +
        `  called measured.`,
    );
  }
  if (!supply.length) {
    console.log(
      `  No line in this corpus offers space, so the vocabulary is unfalsified here\n` +
        `  rather than validated. What it DOES establish is the safety half of\n` +
        `  §7.0: rule A5d cannot fire on anything this corpus contains, so it cannot\n` +
        `  move a single one of the 94 scored jobs.`,
    );
  }
  console.log(`\n${DIM}${reads} statements, all SELECT; no row was written.${RESET}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`${RED}survey failed${RESET}`, err);
  process.exit(1);
});
