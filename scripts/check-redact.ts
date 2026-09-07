/**
 * Phone redaction check. npm run check:redact
 *
 * The access model rests on one invariant: a phone number reaches a browser
 * only through POST /api/loads/:id/contact. This script proves the masking
 * that guards every other payload actually masks:
 *
 *   1. over the six real WhatsApp bodies, `redactPhones` leaves no phone-shaped
 *      run, changes only the lines that carried a (555) number, and keeps
 *      every "ST ZIP CF" line byte-identical -- "NY 11217 1200" is not a phone;
 *   2. `redactJob` nulls contact_phone, sender_key (it IS the phone) and a
 *      phone-shaped contact_name, masks the free-text fields, keeps "Marco";
 *   3. the whole seeded corpus, serialized through B's public view (or, until
 *      that exists, through redactJob/redactPhones directly), contains no
 *      separator phone, no bare 10-digit / E.164 run and no literal "phone:".
 *
 * Checks 1-3 test two functions. Nothing tested the layer that calls them, so a
 * handler added next month that answered with `result.rows` straight out of the
 * query would have passed all three -- the functions would still have been
 * correct, and simply not used. Two more checks close that:
 *
 *   4. every handler under src/app/api that a non-admin can reach is read as
 *      text: a variable assigned from a load or message query may reach the
 *      response only inside a publicView call, `.rows` may not appear bare, and
 *      a spread of a raw result must be overridden after it, not before;
 *   5. the real GET /api/loads/:id handler is imported and invoked against the
 *      seeded corpus, and its actual response body is run through the same
 *      patterns as everything else. Not a simulation of the route -- the route.
 *
 * Check 5 covers one handler, because it is the one public row-emitting handler
 * that can run outside a Next request scope (GET /api/loads reads `cookies()`
 * to decide whether the admin-only filter keys survive, and that throws here).
 * Check 4 is what covers the rest, and it is a text scan: anything clever enough
 * to hide a raw row from it is too clever to review, so failing loudly on it is
 * the right outcome.
 *
 * Runs against an in-memory database (PGLITE_DIR=memory://) so it never
 * touches a real .pgdata.
 */
process.env.PGLITE_DIR = "memory://";

import path from "node:path";
import { fileURLToPath } from "node:url";
import { REAL_MESSAGES } from "./fixtures/real-whatsapp";
import {
  PHONE_MASK,
  PHONE_RE,
  groupLinkCarriesPhone,
  isPhoneOnly,
  redactJob,
  redactPhones,
} from "../src/lib/loads/redact";
import { parseGroupLink } from "../src/lib/loads/groupLink";
import { guardOf, isAdminOnly, isMachineOnly, routeHandlers } from "./lib/routes";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** B's public view; imported by variable so the check runs before the file exists. */
const PUBLIC_VIEW_MODULE = "../src/lib/loads/publicView";

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

const ANY_PHONE = /\d{3}[\s.\-]?\d{3}[\s.\-]?\d{4}/;
const PAYLOAD_PATTERNS: Array<[RegExp, string]> = [
  [/\d{3}[\s.\-]\d{3}[\s.\-]\d{4}/, "separator-formatted phone"],
  [/(?<![\d.])\+?1?\d{10}(?!\d)/, "bare 10-digit run"],
  [/\+\d{10,15}/, "E.164 run"],
  [/"phone:/, 'literal "phone:" (a sender key)'],
  // A group link is gated, not public (see below): a wa.me link IS a phone
  // number, and publishing only the harmless chat.whatsapp.com kind would mean
  // trusting every future caller to tell the two apart.
  [/wa\.me\//, "wa.me link (a phone number written as a URL)"],
  [/chat\.whatsapp\.com/, "group invite link (gated with the phone, not public)"],
];

function fixtureChecks() {
  for (const m of REAL_MESSAGES) {
    const masked = redactPhones(m.body)!;
    assert(!ANY_PHONE.test(masked), `${m.format}: a phone survived redactPhones`);
    const before = m.body.split("\n");
    const after = masked.split("\n");
    assert(before.length === after.length, `${m.format}: line count changed`);
    before.forEach((line, i) => {
      const phones = line.match(new RegExp(PHONE_RE.source, "g")) ?? [];
      const had555 = phones.some((p) => /555/.test(p));
      const changed = line !== after[i];
      assert(changed === had555, `${m.format} line ${i + 1}: ${changed ? "changed without" : "kept despite"} a 555 number: ${JSON.stringify(line)}`);
      if (/[A-Z]{2}\s*\d{5}/.test(line) && !phones.length) {
        assert(line === after[i], `${m.format} line ${i + 1}: ST ZIP line altered: ${JSON.stringify(line)} -> ${JSON.stringify(after[i])}`);
      }
    });
    assert(redactPhones(masked) === masked, `${m.format}: redactPhones is not idempotent`);
  }
}

function unitChecks() {
  const base = {
    contact_phone: "+12015550199",
    sender_key: "phone:+12015550199",
    contact_name: "+1 (201) 555-0199",
    line_text: "FL 33435 350cf call 201-555-0199",
    job_notes: "text me 7865550128",
    notes: "+17865550128 anytime",
    requirements: "Must have DOT",
    contact_mode: "dm" as const,
  };
  const r = redactJob(base);
  assert(r.contact_phone === null, "redactJob: contact_phone not null");
  assert(r.sender_key === null, "redactJob: sender_key not null");
  assert(r.contact_name === null, `redactJob: phone-shaped contact_name not null (${r.contact_name})`);
  assert(r.line_text === `FL 33435 350cf call ${PHONE_MASK}`, `redactJob: line_text = ${JSON.stringify(r.line_text)}`);
  assert(r.job_notes === `text me ${PHONE_MASK}`, `redactJob: job_notes = ${JSON.stringify(r.job_notes)}`);
  assert(r.notes === `${PHONE_MASK} anytime`, `redactJob: notes = ${JSON.stringify(r.notes)}`);
  assert(r.requirements === "Must have DOT", "redactJob: requirements altered");
  assert(r.contact_mode === "dm", "redactJob: contact_mode did not survive");
  const named = redactJob({ ...base, contact_name: "Marco" });
  assert(named.contact_name === "Marco", `redactJob: "Marco" became ${named.contact_name}`);
  assert(isPhoneOnly("+1 (786) 555-0128") && isPhoneOnly("7865550128") && isPhoneOnly("+17865550128"), "isPhoneOnly misses a phone form");
  assert(!isPhoneOnly("Marco") && !isPhoneOnly("NY 11217 1200"), "isPhoneOnly over-matches");
  assert(redactPhones("NY 11217 1200") === "NY 11217 1200", "ZIP CF pair masked");
  assert(redactPhones("38558 1700") === "38558 1700", "38558 1700 masked");
  assert(redactPhones("call 555-0128") === `call ${PHONE_MASK}`, "7-digit shorthand with a hyphen not masked");
  assert(redactPhones("786 555 0128") === PHONE_MASK, "spaced phone not masked");
  assert(redactPhones("+447700900123") === PHONE_MASK, "international not masked");
}

/**
 * Group links (§1.2), and the decision behind them.
 *
 * Two links exist: `chat.whatsapp.com/<code>`, an opaque group invite that
 * names no person, and `wa.me/<digits>`, which IS a phone number written as a
 * URL. The deliberate decision is that BOTH stay behind the contact gate --
 * they travel only in POST /api/loads/:id/contact's response and never on a
 * board or detail row -- so no public payload has to be trusted to tell them
 * apart. These checks pin down that the difference is understood (the
 * predicate), that the dangerous kind is caught by the same masking as any
 * other phone should one ever reach free text, and (via PAYLOAD_PATTERNS) that
 * neither kind appears in a public payload.
 */
function groupLinkChecks() {
  const invite = "https://chat.whatsapp.com/HkR2mJ9qL3xA0bT7ZnQ4Ve";
  const wa = "https://wa.me/17865550128";

  assert(groupLinkCarriesPhone(wa), "a wa.me link is not recognised as carrying a phone");
  assert(!groupLinkCarriesPhone(invite), "an invite code is misread as a phone");
  assert(!groupLinkCarriesPhone(null), "groupLinkCarriesPhone(null) is not false");
  assert(redactPhones(wa) === `https://wa.me/${PHONE_MASK}`, `wa.me digits not masked: ${redactPhones(wa)}`);
  assert(redactPhones(invite) === invite, "an invite link was altered by redactPhones");

  // The validator: only the two real shapes, canonicalized.
  assert(parseGroupLink(invite)?.kind === "invite", "invite link rejected");
  assert(parseGroupLink("chat.whatsapp.com/HkR2mJ9qL3xA0bT7ZnQ4Ve")?.url === invite, "scheme-less invite not canonicalized");
  assert(parseGroupLink("wa.me/17865550128")?.kind === "wa", "wa.me link rejected");
  assert(parseGroupLink("786 555 0128")?.url === wa, "a bare number did not become a wa.me link");
  assert(parseGroupLink("https://example.com/whatsapp") === null, "a foreign host was accepted");
  assert(parseGroupLink("https://chat.whatsapp.com/") === null, "an empty invite code was accepted");
  // The URL that does not exist: there is no deep link to one message.
  assert(parseGroupLink("https://wa.me/message/ABC123") === null, '"link to a message" was accepted');
  assert(parseGroupLink("") === null && parseGroupLink(null) === null, "empty input was accepted");
}

async function corpusChecks() {
  const { resetDemoData } = await import("../src/lib/demo/reset");
  const { searchLoads } = await import("../src/lib/loads/query");
  const { query } = await import("../src/lib/db");

  const summary = await resetDemoData();
  console.log(`${DIM}seeded ${summary.messages} messages, ${summary.loadsCreated} jobs (in memory)${RESET}`);

  const statuses = ["available", "delisted", "pending", "taken", "expired", "cancelled"] as const;
  const { rows } = await searchLoads({ limit: 500, statuses: [...statuses], includeDuplicates: true });
  const messages = await query<{ body: string; author_name: string | null; sent_at: string; group_name: string | null }>(
    `SELECT m.body, m.author_name, m.sent_at::text AS sent_at, g.name AS group_name
       FROM raw_messages m LEFT JOIN whatsapp_groups g ON g.id = m.group_id`,
  );

  let publicLoads: string;
  let publicSources: string[];
  let via: string;
  try {
    const pv = (await import(PUBLIC_VIEW_MODULE)) as {
      toPublicLoads?: (r: unknown[]) => unknown[];
      toPublicSource?: (s: unknown) => unknown;
    };
    if (!pv.toPublicLoads || !pv.toPublicSource) throw new Error("no exports");
    publicLoads = JSON.stringify(pv.toPublicLoads(rows));
    publicSources = messages.map((m) => JSON.stringify(pv.toPublicSource!(m)));
    via = "publicView.ts";
  } catch {
    console.log(`${DIM}publicView not found — checked redact.ts only${RESET}`);
    publicLoads = JSON.stringify(rows.map((r) => redactJob(r)));
    publicSources = messages.map((m) =>
      JSON.stringify({ ...m, body: redactPhones(m.body), author_name: isPhoneOnly(m.author_name) ? null : redactPhones(m.author_name) }),
    );
    via = "redact.ts";
  }

  for (const [re, what] of PAYLOAD_PATTERNS) {
    const hit = publicLoads.match(re);
    assert(!hit, `serialized loads (${via}) contain a ${what}: ...${publicLoads.slice(Math.max(0, (hit?.index ?? 0) - 60), (hit?.index ?? 0) + 40)}...`);
    for (const s of publicSources) {
      const h = s.match(re);
      assert(!h, `serialized source (${via}) contains a ${what}: ...${s.slice(Math.max(0, (h?.index ?? 0) - 60), (h?.index ?? 0) + 40)}...`);
    }
  }
  assert(rows.length > 0, "the seeded corpus produced no rows to check");

  // The other half of the gate: the link IS stored, it just never leaves through
  // a public payload. Without this the patterns above would also pass on a
  // build where the group link feature silently stopped working.
  const linked = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM whatsapp_groups WHERE invite_url IS NOT NULL`,
  );
  assert(linked[0].n > 0, "no seeded group has an invite link, so the gate proves nothing");

  console.log(`${DIM}checked ${rows.length} public rows and ${messages.length} sources via ${via}${RESET}`);
}

// --- the route layer ---------------------------------------------------------

/** Calls that hand back a row with a phone number still on it. */
const RAW_SOURCES = [
  "searchLoads",
  "getLoad",
  "getDuplicates",
  "revealContact",
  "listMessages",
  "loadsForMessage",
  // Only counted in a handler whose SQL actually names a load or message table:
  // /api/auth/* reads `users` with these too, and a user's own row is not a
  // redaction question.
  "query",
  "queryOne",
];

/** The only functions allowed to turn one of those into a response. */
const SANITIZERS = ["toPublicLoad", "toPublicLoads", "toPublicSource", "redactJob", "redactPhones"];

/**
 * Handlers that emit row data on purpose, and why that is right.
 *
 * One entry, and it is the entire access model: the contact reveal is the one
 * door a phone number leaves by. It needs an account, it is rate-limited per
 * account, and every pass is logged with an actor id.
 */
const EMITS_RAW_ON_PURPOSE: Record<string, string> = {
  "POST /api/loads/[id]/contact": "the one gated reveal; returns the number by design",
};

/** The text `NextResponse.json(...)` / `Response.json(...)` is given, per return. */
function responseExpressions(body: string): string[] {
  const out: string[] = [];
  const re = /(?:NextResponse|Response)\.json\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    let i = re.lastIndex;
    let depth = 1;
    const start = i;
    while (i < body.length && depth > 0) {
      const c = body[i];
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") depth--;
      i++;
    }
    out.push(body.slice(start, i - 1));
  }
  return out;
}

/** The index of the previous / next character that is not whitespace. */
function prevNonSpace(text: string, at: number): number {
  let i = at - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  return i;
}
function nextNonSpace(text: string, at: number): number {
  let i = at;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/** True when `name` at `at` is the argument of a publicView call. */
function insideSanitizer(text: string, at: number): boolean {
  const i = prevNonSpace(text, at);
  if (text[i] !== "(") return false;
  const before = text.slice(Math.max(0, i - 24), i);
  return SANITIZERS.some((s) => before.endsWith(s));
}

/**
 * True when this occurrence is the KEY of an object literal, not a value.
 *
 * `{ load: toPublicLoad(load) }` mentions `load` twice and only the second one
 * is data. A key is an identifier followed by ":" that itself follows "{" or
 * "," -- which is deliberately narrower than "followed by a colon", so the
 * middle of a ternary (`{ x: fresh ? load : null }`) is still checked.
 */
function isObjectKey(text: string, at: number, name: string): boolean {
  if (text[nextNonSpace(text, at + name.length)] !== ":") return false;
  const before = prevNonSpace(text, at);
  return before < 0 || text[before] === "{" || text[before] === ",";
}

function routeChecks() {
  const handlers = routeHandlers(ROOT);
  assert(handlers.length > 20, `only ${handlers.length} route handlers found -- the scanner is not reading src/app/api`);

  let scanned = 0;
  let sanitized = 0;

  for (const h of handlers) {
    const guard = guardOf(h.body);
    // An admin reads raw messages and sender phone keys as part of the job, and
    // cron and the webhook answer machines. Neither is a public payload.
    if (isAdminOnly(guard) || isMachineOnly(guard)) continue;
    if (EMITS_RAW_ON_PURPOSE[h.id]) continue;
    scanned++;

    const touchesRows = /\bFROM loads\b|\braw_messages\b|\bFROM whatsapp_groups\b/.test(h.body);
    const sources = RAW_SOURCES.filter((s) =>
      s === "query" || s === "queryOne" ? touchesRows : true,
    );

    // Every variable this handler assigns out of one of those calls.
    const raw = new Set<string>();
    for (const s of sources) {
      const re = new RegExp(String.raw`(?:const|let)\s+([A-Za-z_$][\w$]*)[^;]*?\b${s}\s*[<(]`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(h.body))) raw.add(m[1]);
    }

    for (const expr of responseExpressions(h.body)) {
      if (SANITIZERS.some((s) => expr.includes(`${s}(`))) sanitized++;

      // The named drift: `NextResponse.json({ rows: result.rows })`.
      for (const m of expr.matchAll(/\.rows\b/g)) {
        let start = m.index!;
        while (start > 0 && /[\w$.]/.test(expr[start - 1])) start--;
        assert(
          insideSanitizer(expr, start),
          `${h.id} (${h.file}) answers with a bare ".rows" — query rows must go through ${SANITIZERS.slice(0, 3).join(" / ")}`,
        );
      }

      for (const name of raw) {
        // A spread is legal only when the sanitized key overrides it AFTER, so
        // `{ ...result, rows: toPublicLoads(result.rows) }` passes and the same
        // object written the other way round does not.
        const spread = expr.indexOf(`...${name}`);
        if (spread !== -1) {
          const fixedAfter = SANITIZERS.map((s) => expr.indexOf(`${s}(`, spread)).filter((i) => i !== -1);
          assert(
            fixedAfter.length > 0,
            `${h.id} (${h.file}) spreads "${name}" into the response with nothing sanitized after it`,
          );
        }
        for (const m of expr.matchAll(new RegExp(String.raw`\b${name}\b`, "g"))) {
          const at = m.index!;
          if (at >= 3 && expr.slice(at - 3, at) === "...") continue;
          if (expr[at - 1] === ".") continue;
          if (isObjectKey(expr, at, name)) continue;
          assert(
            insideSanitizer(expr, at),
            `${h.id} (${h.file}) puts "${name}" — read straight out of the database — into a response without ${SANITIZERS.slice(0, 3).join(" / ")}`,
          );
        }
      }
    }
  }

  assert(scanned >= 8, `only ${scanned} non-admin handlers were scanned -- the guard classifier is over-excluding`);
  assert(sanitized > 0, "no handler was found calling publicView at all -- the scanner is matching nothing");
  console.log(`${DIM}scanned ${scanned} handlers a non-admin can reach; ${sanitized} responses go through publicView${RESET}`);
}

/**
 * The real handler, invoked.
 *
 * Everything above reads source text. This imports src/app/api/loads/[id]/route
 * and calls its exported GET the way Next would, against the corpus seeded by
 * corpusChecks, then runs the same PAYLOAD_PATTERNS over the bytes that came
 * back. If someone deletes the `toPublicLoad` call, this fails on the response
 * rather than on the shape of the source.
 */
async function liveRouteChecks() {
  // The gate must never make a billable call. tsx does not read .env.local, so
  // this is belt and braces for a developer who exported the key in their shell:
  // with no key `loadDistances` short-circuits before it can route.
  delete process.env.HERE_API_KEY;

  const { query } = await import("../src/lib/db");
  const ids = await query<{ id: number }>(
    `SELECT id FROM loads WHERE contact_phone IS NOT NULL ORDER BY id LIMIT 5`,
  );
  assert(ids.length > 0, "no seeded job carries a phone, so invoking the route would prove nothing");

  const mod = (await import("../src/app/api/loads/[id]/route")) as {
    GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  };

  for (const { id } of ids) {
    const res = await mod.GET(new Request(`http://localhost/api/loads/${id}`), {
      params: Promise.resolve({ id: String(id) }),
    });
    assert(res.status === 200, `GET /api/loads/${id} answered ${res.status}`);
    const text = await res.text();
    assert(text.includes('"line_text"'), `GET /api/loads/${id} returned no job to check`);
    for (const [re, what] of PAYLOAD_PATTERNS) {
      const hit = text.match(re);
      assert(!hit, `GET /api/loads/${id} returned a ${what}: ...${text.slice(Math.max(0, (hit?.index ?? 0) - 60), (hit?.index ?? 0) + 40)}...`);
    }
  }
  console.log(`${DIM}invoked the real GET /api/loads/:id on ${ids.length} jobs that carry a phone${RESET}`);
}

async function main() {
  fixtureChecks();
  unitChecks();
  groupLinkChecks();
  routeChecks();
  await corpusChecks();
  await liveRouteChecks();

  if (failures.length) {
    console.log(`\n${RED}${failures.length} of ${checks} redaction checks failed${RESET}`);
    for (const f of failures) console.log(`  ${RED}✗${RESET} ${f}`);
    process.exit(1);
  }
  console.log(`\n${GREEN}✓${RESET} ${checks} redaction checks passed\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
