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
 * Runs against an in-memory database (PGLITE_DIR=memory://) so it never
 * touches a real .pgdata.
 */
process.env.PGLITE_DIR = "memory://";

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

async function main() {
  fixtureChecks();
  unitChecks();
  groupLinkChecks();
  await corpusChecks();

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
