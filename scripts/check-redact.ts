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

/**
 * Calls that hand back a row with a phone number still on it.
 *
 * The route scan below recognises a raw row BY THE NAME OF THE CALL that
 * produced it, so a handler calling something that is not in this list passes
 * the assertion vacuously -- it looks green and proves nothing. A new
 * row-returning function has to arrive here in the same commit that creates it,
 * and `rawSourceChecks` below fails if a name here no longer resolves to an
 * exported symbol, so the next rename cannot quietly empty the list.
 */
const RAW_SOURCES = [
  "searchLoads",
  "getLoad",
  "getDuplicates",
  "revealContact",
  "revealTruckContact",
  "listMessages",
  "loadsForMessage",
  // The truck board's reads. Same shape, same phone columns, same rule.
  "searchTrucks",
  "getTruck",
  // Only counted in a handler whose SQL actually names a load or message table:
  // /api/auth/* reads `users` with these too, and a user's own row is not a
  // redaction question.
  "query",
  "queryOne",
];

/**
 * Where each of those lives, so the list above can be proved rather than
 * trusted. `query`/`queryOne` are the database module itself.
 */
const RAW_SOURCE_MODULES: Record<string, string> = {
  searchLoads: "../src/lib/loads/query",
  getLoad: "../src/lib/loads/query",
  getDuplicates: "../src/lib/loads/query",
  searchTrucks: "../src/lib/loads/truckQuery",
  getTruck: "../src/lib/loads/truckQuery",
  revealContact: "../src/lib/pipeline/reconcile",
  revealTruckContact: "../src/lib/pipeline/reconcile",
  listMessages: "../src/lib/demo/chats",
  loadsForMessage: "../src/lib/demo/chats",
  query: "../src/lib/db",
  queryOne: "../src/lib/db",
};

/** The only functions allowed to turn one of those into a response. */
const SANITIZERS = [
  "toPublicLoad",
  "toPublicLoads",
  "toPublicSource",
  "toPublicTruck",
  "toPublicTrucks",
  "redactJob",
  "redactTruck",
  "redactPhones",
];

/**
 * Handlers that emit row data on purpose, and why that is right.
 *
 * Two entries, one per kind, and together they are the entire access model:
 * the contact reveal is the one door a phone number leaves by. Each needs an
 * account, each is rate-limited per account in its OWN bucket, and every pass
 * is logged with an actor id -- into `load_events` for a job and `truck_events`
 * for a truck, because `load_events.load_id` is `REFERENCES loads(id)` and
 * cannot hold a truck.
 */
const EMITS_RAW_ON_PURPOSE: Record<string, string> = {
  "POST /api/loads/[id]/contact": "the one gated reveal; returns the number by design",
  "POST /api/trucks/[id]/contact": "the truck board's one gated reveal; the same gate, the same log, by design",
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

// --- trucks ------------------------------------------------------------------

/**
 * R1: `redactTruck` over a row that carries a number in every field a driver
 * can type into.
 *
 * The field list is the whole of this function. `redactJob` and `redactTruck`
 * mask different columns because the two rows HAVE different columns, and the
 * way a masking list goes wrong is by omission -- so each field is asserted by
 * name rather than by scanning the output for digits, which would pass a
 * function that had quietly stopped masking a field the fixture left empty.
 */
async function truckUnitChecks() {
  const { redactTruck } = await import("../src/lib/loads/redact");
  const base = {
    contact_phone: "+12015550199",
    sender_key: "phone:+12015550199",
    contact_name: "+1 (201) 555-0199",
    line_text: "empty NJ to FL Friday 700cf 201-555-0199",
    notes: "text me 7865550128",
    requirements: "COI before loading — call (201) 555-0199",
    equipment_notes: "lift gate, ask for Ana 786.555.0128",
    truck_text: "26 ft box truck 786-555-0128",
    origin_label: "Newark, NJ 07102 — gate code, ask for Ana 786.555.0128",
    dest_label: "Miami, FL 33101 — call +17865550128 on arrival",
  };
  const r = redactTruck(base);
  assert(r.contact_phone === null, "redactTruck: contact_phone not null");
  assert(r.sender_key === null, "redactTruck: sender_key not null");
  assert(r.contact_name === null, `redactTruck: phone-shaped contact_name not null (${r.contact_name})`);
  assert(r.line_text === `empty NJ to FL Friday 700cf ${PHONE_MASK}`, `redactTruck: line_text = ${JSON.stringify(r.line_text)}`);
  assert(r.notes === `text me ${PHONE_MASK}`, `redactTruck: notes = ${JSON.stringify(r.notes)}`);
  assert(r.requirements === `COI before loading — call ${PHONE_MASK}`, `redactTruck: requirements = ${JSON.stringify(r.requirements)}`);
  assert(r.equipment_notes === `lift gate, ask for Ana ${PHONE_MASK}`, `redactTruck: equipment_notes = ${JSON.stringify(r.equipment_notes)}`);
  assert(r.truck_text === `26 ft box truck ${PHONE_MASK}`, `redactTruck: truck_text = ${JSON.stringify(r.truck_text)}`);
  assert(r.origin_label === `Newark, NJ 07102 — gate code, ask for Ana ${PHONE_MASK}`, `redactTruck: origin_label = ${JSON.stringify(r.origin_label)}`);
  assert(r.dest_label === `Miami, FL 33101 — call ${PHONE_MASK} on arrival`, `redactTruck: dest_label = ${JSON.stringify(r.dest_label)}`);

  // A truck's size in words is not a phone, and a named driver keeps their name.
  const plain = redactTruck({ ...base, contact_name: "Marco", truck_text: "26 ft box truck" });
  assert(plain.contact_name === "Marco", `redactTruck: "Marco" became ${plain.contact_name}`);
  assert(plain.truck_text === "26 ft box truck", "redactTruck: a size in feet was masked");
  // Idempotent, like everything else built on redactPhones.
  assert(
    JSON.stringify(redactTruck(r)) === JSON.stringify(r),
    "redactTruck is not idempotent",
  );
}

/**
 * R4: every name in RAW_SOURCES resolves to an exported function.
 *
 * The route scan recognises a raw row by the name of the call that produced it.
 * A rename anywhere in src/ would leave a name here matching nothing, and the
 * scan would then pass every handler VACUOUSLY -- green, and blind. This is the
 * check that fails instead.
 */
async function rawSourceChecks() {
  for (const name of RAW_SOURCES) {
    const where = RAW_SOURCE_MODULES[name];
    assert(where != null, `RAW_SOURCES lists "${name}" but RAW_SOURCE_MODULES does not say where it lives`);
    if (!where) continue;
    const mod = (await import(where)) as Record<string, unknown>;
    assert(
      typeof mod[name] === "function",
      `RAW_SOURCES lists "${name}", which ${where} does not export — the route scan is matching nothing for it`,
    );
  }
}

/**
 * R2 and R3: the truck corpus, serialized.
 *
 * R2 is a COLUMN scan rather than a reading of the row type: TypeScript
 * interfaces do not exist at runtime, so what is asserted is the payload. Every
 * column of `trucks` whose name matches /phone/ must be either absent from the
 * public row or null in it, which is a property the next phone column added
 * inherits automatically.
 */
async function truckCorpusChecks() {
  const { seedTrucks } = await import("./fixtures/trucks");
  const { searchTrucks } = await import("../src/lib/loads/truckQuery");
  const { toPublicTrucks } = await import("../src/lib/loads/publicView");
  const { query } = await import("../src/lib/db");

  const ids = await seedTrucks(new Date());
  assert(ids.length >= 6, `the truck fixture seeded ${ids.length} rows`);

  // "admin" scope on purpose: the pending row is IN this serialization, so the
  // patterns below are run over the row that must never reach a browser as well
  // as over the five that may.
  const statuses = ["available", "booked", "departed", "expired", "cancelled"] as const;
  const { rows } = await searchTrucks("admin", { limit: 500, statuses: [...statuses] });
  assert(rows.length === ids.length, `searchTrucks("admin") returned ${rows.length} of ${ids.length} seeded trucks`);

  const publicTrucks = JSON.stringify(toPublicTrucks(rows));
  for (const [re, what] of PAYLOAD_PATTERNS) {
    const hit = publicTrucks.match(re);
    assert(
      !hit,
      `serialized trucks contain a ${what}: ...${publicTrucks.slice(Math.max(0, (hit?.index ?? 0) - 60), (hit?.index ?? 0) + 40)}...`,
    );
  }

  // Each seeded format really was there to begin with -- otherwise the patterns
  // above would pass over a corpus that never carried a phone.
  const raw = JSON.stringify(rows);
  const { SEEDED_PHONES } = await import("./fixtures/trucks");
  for (const [name, phone] of Object.entries(SEEDED_PHONES)) {
    assert(raw.includes(phone), `the truck fixture no longer carries a ${name}-format phone (${phone})`);
  }

  // R2: the column scan.
  const phoneColumns = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'trucks' AND column_name LIKE '%phone%'
      ORDER BY column_name`,
  );
  assert(phoneColumns.length >= 3, `only ${phoneColumns.length} phone-ish columns found on trucks -- the scan is reading nothing`);
  const publicRows = toPublicTrucks(rows) as unknown as Array<Record<string, unknown>>;
  for (const { column_name } of phoneColumns) {
    if (column_name in PHONE_COLUMN_EXEMPT) {
      const values = new Set(publicRows.map((r) => r[column_name]).filter((v) => v != null));
      assert(
        [...values].every((v) => v === "post" || v === "sender"),
        `${column_name} is exempt as an enum but carries ${[...values].join(", ")}`,
      );
      continue;
    }
    for (const row of publicRows) {
      assert(
        !(column_name in row) || row[column_name] === null,
        `trucks.${column_name} reaches the public wire as ${JSON.stringify(row[column_name])} — add it to redactTruck, or keep it out of TruckRow and TRUCK_SELECT_COLUMNS`,
      );
    }
  }
  assert(
    !raw.includes("contact_phone_raw"),
    "contact_phone_raw is in TRUCK_SELECT_COLUMNS — the number as it was typed must never enter a row shape",
  );

  console.log(`${DIM}checked ${rows.length} public truck rows over ${phoneColumns.length} phone-ish columns${RESET}`);
}

/**
 * A column whose name says "phone" but whose value is not one.
 *
 * Listing it here is a decision somebody has to write down, and the check
 * asserts the claim -- the enum's values -- rather than taking it on trust.
 */
const PHONE_COLUMN_EXEMPT: Record<string, string> = {
  contact_phone_source:
    "an enum ('post' | 'sender') saying where the number came from, never a number; the CHECK constraint in db/schema.sql is what keeps it one",
};

/**
 * R5 and R7: the real truck handlers, invoked.
 *
 * R5 -- `GET /api/trucks/:id` and `GET /api/trucks` are imported and called the
 * way Next calls them, and their actual bytes go through the same patterns as
 * everything else. Not a simulation of the routes; the routes.
 *
 * R7 -- a `visibility='pending'` truck is INDISTINGUISHABLE from an id that was
 * never issued: same status, same body. It is absent from the board, and
 * `?visibility=pending` is a 400 rather than a filter. The anonymous caller is
 * the one this can reproduce exactly (getCurrentUser answers null with no
 * request scope); the signed-in cases are asserted one call below the handler,
 * where the scope and the audience are both visible.
 */
async function liveTruckRouteChecks() {
  const { query } = await import("../src/lib/db");
  const { getTruck } = await import("../src/lib/loads/truckQuery");

  const rows = await query<{ id: number; visibility: string }>(
    `SELECT id, visibility FROM trucks ORDER BY id`,
  );
  const publicIds = rows.filter((r) => r.visibility === "public").map((r) => r.id);
  const pendingId = rows.find((r) => r.visibility === "pending")!.id;
  const noSuchTruck = Math.max(...rows.map((r) => r.id)) + 1000;
  assert(publicIds.length > 0 && pendingId != null, "the truck fixture seeded no pending row to hide");

  const detail = (await import("../src/app/api/trucks/[id]/route")) as {
    GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  };
  const call = (id: number) =>
    detail.GET(new Request(`http://localhost/api/trucks/${id}`), {
      params: Promise.resolve({ id: String(id) }),
    });

  for (const id of publicIds) {
    const res = await call(id);
    assert(res.status === 200, `GET /api/trucks/${id} answered ${res.status}`);
    const text = await res.text();
    assert(text.includes('"origin_label"'), `GET /api/trucks/${id} returned no truck to check`);
    for (const [re, what] of PAYLOAD_PATTERNS) {
      const hit = text.match(re);
      assert(!hit, `GET /api/trucks/${id} returned a ${what}: ...${text.slice(Math.max(0, (hit?.index ?? 0) - 60), (hit?.index ?? 0) + 40)}...`);
    }
  }

  const pending = await call(pendingId);
  const missing = await call(noSuchTruck);
  assert(pending.status === 404, `GET /api/trucks/:id answered ${pending.status} for a pending truck`);
  const pendingText = await pending.text();
  assert(
    pendingText === (await missing.text()),
    "GET /api/trucks/:id tells a pending truck apart from an id that was never issued",
  );

  const board = (await import("../src/app/api/trucks/route")) as {
    GET: (req: Request) => Promise<Response>;
  };
  const listed = await board.GET(new Request("http://localhost/api/trucks?limit=500&status=available,booked,departed,expired,cancelled"));
  assert(listed.status === 200, `GET /api/trucks answered ${listed.status}`);
  const listedBody = (await listed.text());
  for (const [re, what] of PAYLOAD_PATTERNS) {
    const hit = listedBody.match(re);
    assert(!hit, `GET /api/trucks returned a ${what}: ...${listedBody.slice(Math.max(0, (hit?.index ?? 0) - 60), (hit?.index ?? 0) + 40)}...`);
  }
  const parsed = JSON.parse(listedBody) as { rows: Array<{ id: number }>; total: number };
  assert(!parsed.rows.some((r) => r.id === pendingId), "GET /api/trucks returned the pending truck");
  assert(parsed.rows.length === publicIds.length, `GET /api/trucks returned ${parsed.rows.length} of ${publicIds.length} public trucks`);
  assert(parsed.total === parsed.rows.length, `GET /api/trucks counted ${parsed.total} but returned ${parsed.rows.length}`);

  // The quarantine is not a filter axis: asking for it by name is a 400, not a
  // query. This is the whole reason `visibility` is a column separate from
  // `status`, which api/loads/route.ts does NOT strip for anonymous callers.
  const asked = await board.GET(new Request("http://localhost/api/trucks?visibility=pending"));
  assert(asked.status === 400, `GET /api/trucks?visibility=pending answered ${asked.status}, not 400`);
  const jobUrl = await board.GET(new Request("http://localhost/api/trucks?minCf=600&readyOnly=1"));
  assert(jobUrl.status === 400, `a job board's URL on the truck board answered ${jobUrl.status}, not 400`);

  // No audience un-hides it: scope and the demo predicate are independent, and
  // the quarantine is the one that does not depend on who is asking.
  for (const audience of [
    { label: "anonymous", value: { userId: null } },
    { label: "a signed-in user", value: { userId: 1 } },
    { label: "a caller asking for demo rows", value: { userId: 1, includeDemo: true } },
  ]) {
    assert(
      (await getTruck(pendingId, "public", audience.value)) == null,
      `getTruck(pending, "public") returned the row to ${audience.label}`,
    );
  }
  assert((await getTruck(pendingId, "admin")) != null, "an admin console cannot reach the review queue");

  console.log(`${DIM}invoked GET /api/trucks and GET /api/trucks/:id on ${publicIds.length} public trucks and 1 pending one${RESET}`);
}

async function main() {
  fixtureChecks();
  unitChecks();
  await truckUnitChecks();
  groupLinkChecks();
  routeChecks();
  await rawSourceChecks();
  await corpusChecks();
  await liveRouteChecks();
  await truckCorpusChecks();
  await liveTruckRouteChecks();

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
