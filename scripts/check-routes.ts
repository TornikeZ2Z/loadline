/**
 * Route authorization check. npm run check:routes
 *
 * The guards under src/app/api are correct today -- every admin route opens
 * with a role check and the public ones are public on purpose. Nothing said so.
 * `grep -rn requireRole scripts/` returned nothing before this file, so the
 * exposure this closes is drift: a route added next month with no guard at all
 * would ship, pass every suite, and nobody would find out from the tests.
 *
 * The check is not "does each handler call something that looks like a guard".
 * That would pass a handler whose guard is wrong. Instead every handler is
 * DECLARED below, with the gate it is meant to have and why, and the script
 * fails when the code and the declaration disagree in either direction:
 *
 *   1. a handler with no entry            -- a new route shipped undeclared;
 *   2. an entry with no handler           -- a stale declaration;
 *   3. a guard that is not the declared one -- someone widened access;
 *   4. a mutation on an admin console that uses the READING guard
 *      (`requireRole`) where the writing one (`requireWriteRole`) belongs --
 *      structural, so it catches a new admin mutation even when its entry was
 *      written to match the mistake.
 *
 * Rule 4 is the one with teeth today. `requireWriteRole` is what keeps a demo
 * admin -- one click from the public sign-in page -- out of POST
 * /api/test/reset, which TRUNCATEs ten tables including the warmed geocode
 * cache. See the note on `users.is_demo` in db/schema.sql.
 *
 * Adding a route means adding a line here. That is the point: it costs a
 * sentence, and it makes "who may call this?" a thing somebody wrote down.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { guardOf, routeHandlers, type RouteHandler } from "./lib/routes";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Every handler under src/app/api, the gate it must have, and why.
 *
 * "public" is a claim about the response as much as about the caller: each of
 * these five answers with data that is already on the public board, and the
 * three that read jobs are covered separately by npm run check:redact, which
 * proves no phone number leaves through them.
 */
const DECLARED: Record<string, { guard: string; why: string }> = {
  // --- open to anybody ------------------------------------------------------
  "GET /api/health": { guard: "public", why: "ALB liveness probe; touches no database" },
  "POST /api/auth/login": { guard: "public", why: "issues the session; same error either way" },
  "POST /api/auth/logout": { guard: "public", why: "drops the cookie; nothing to protect" },
  "POST /api/auth/register": { guard: "public", why: "self-serve account, rate-limited to 10/min" },
  "POST /api/auth/demo": { guard: "public", why: "one-click demo sign-in; 404s when DEMO_MODE=off" },
  "GET /api/loads": { guard: "public", why: "the public board; admin-only filter keys stripped" },
  "GET /api/loads/[id]": { guard: "public", why: "public job detail, redacted through publicView" },
  "GET /api/loads/[id]/route": { guard: "public", why: "road geometry; carries no personal data" },
  "GET /api/trucks": {
    guard: "public",
    why: "the public truck board; searchTrucks(\"public\", …) pins visibility='public' in SQL, and the admin-only keys sender/review are stripped",
  },
  "GET /api/trucks/[id]": {
    guard: "public",
    why: "public truck detail, redacted through publicView; getTruck(id, \"public\") 404s a non-public row",
  },
  "GET /api/places/suggest": { guard: "public", why: "place autocomplete, rate-limited" },
  "POST /api/places/resolve": { guard: "public", why: "place lookup, rate-limited" },
  "POST /api/reports": {
    guard: "public",
    why: "anyone may report a wrong job; rate-limited, and UNIQUE (load_id, reason) bounds the queue",
  },

  // --- a person, whoever they are -------------------------------------------
  "POST /api/loads/[id]/contact": { guard: "user", why: "the ONE endpoint that returns a phone; logged per reveal" },
  "PATCH /api/loads/[id]/status": { guard: "user", why: "ownership, not role: own rows, or a real admin (isAdminActor)" },

  // --- the posting capability -----------------------------------------------
  "POST /api/loads": { guard: "posting", why: "users.can_post, not the poster role" },

  // --- a machine with a secret ----------------------------------------------
  "POST /api/cron/expire": { guard: "cron-secret", why: "scheduled sweep; bearer token" },
  "POST /api/cron/process": { guard: "cron-secret", why: "scheduled extraction; bearer token" },
  "GET /api/webhooks/whatsapp": { guard: "webhook", why: "Meta's subscription handshake; verify token" },
  "POST /api/webhooks/whatsapp": { guard: "webhook", why: "message delivery; X-Hub-Signature-256 HMAC" },

  // --- reading an admin console (a demo admin may) --------------------------
  "GET /api/admin/geocode": { guard: "role:admin", why: "HERE status and the ZIP survey" },
  "GET /api/admin/groups": { guard: "role:admin", why: "the WhatsApp groups list" },
  "GET /api/admin/issues": { guard: "role:admin", why: "the needs-attention queue" },
  "GET /api/admin/messages": { guard: "role:admin", why: "raw messages, unredacted, for triage" },
  "GET /api/admin/messages/[id]": { guard: "role:admin", why: "one raw message and what it produced" },
  "GET /api/admin/reports": { guard: "role:admin", why: "reported jobs, inside the needs-attention queue" },
  "GET /api/admin/rules": { guard: "role:admin", why: "the extraction rule set" },
  "GET /api/admin/senders": { guard: "role:admin", why: "sender directory, including phone keys" },
  "GET /api/admin/settings": { guard: "role:admin", why: "the legal identity; public the moment it is filled in" },
  "GET /api/admin/twins": { guard: "role:admin", why: "cross-sender twin detection" },
  "GET /api/test/groups": { guard: "role:admin", why: "the test console's group list" },
  "GET /api/test/messages": { guard: "role:admin", why: "the test console's message list" },
  "GET /api/test/messages/[id]": { guard: "role:admin", why: "one test message" },

  // --- changing what everyone else sees (a demo admin may NOT) --------------
  "PATCH /api/admin/formats/[signature]": { guard: "write:admin", why: "marks a format known and reprocesses it" },
  "POST /api/admin/geocode": { guard: "write:admin", why: "backfills coordinates; spends money at HERE" },
  "PATCH /api/admin/groups/[id]": { guard: "write:admin", why: "edits a group and its invite link" },
  "POST /api/admin/ingest": { guard: "write:admin", why: "puts new text into the corpus" },
  "PATCH /api/admin/issues/[id]": { guard: "write:admin", why: "resolves or ignores a queue item" },
  "POST /api/admin/messages/[id]/accept": { guard: "write:admin", why: "freezes an expectation into the fixture" },
  "POST /api/admin/messages/[id]/reprocess": { guard: "write:admin", why: "re-derives one message's jobs" },
  "POST /api/admin/reprocess": { guard: "write:admin", why: "re-derives the corpus in bulk" },
  "PATCH /api/admin/reports/[id]": { guard: "write:admin", why: "empties a shared queue; records resolved_by" },
  "POST /api/admin/rules": { guard: "write:admin", why: "a new rule changes every future extraction" },
  "PATCH /api/admin/rules/[id]": { guard: "write:admin", why: "edits a rule and re-runs what it touched" },
  "DELETE /api/admin/rules/[id]": { guard: "write:admin", why: "removes a rule and re-runs what it touched" },
  "PATCH /api/admin/senders/[key]": { guard: "write:admin", why: "manual sender facts outrank derived ones" },
  "PUT /api/admin/settings": { guard: "write:admin", why: "rewrites the company name and address on six public pages" },
  "POST /api/test/messages": { guard: "write:admin", why: "injects a message into the corpus" },
  "PATCH /api/test/messages/[id]": { guard: "write:admin", why: "rewrites a message and its jobs" },
  "DELETE /api/test/messages/[id]": { guard: "write:admin", why: "deletes a message and its jobs" },
  "POST /api/test/reset": { guard: "write:admin", why: "TRUNCATEs ten tables and the geocode cache" },
};

const failures: string[] = [];
let checks = 0;
const assert = (ok: boolean, what: string) => {
  checks++;
  if (!ok) failures.push(what);
};

/** An admin surface whose method changes something. */
function isAdminMutation(h: RouteHandler): boolean {
  const admin = h.route.startsWith("/api/admin") || h.route.startsWith("/api/test");
  return admin && h.method !== "GET" && h.method !== "HEAD";
}

function main() {
  const handlers = routeHandlers(ROOT);
  assert(handlers.length > 20, `only ${handlers.length} handlers found -- the scanner is not reading src/app/api`);

  const seen = new Set<string>();

  for (const h of handlers) {
    seen.add(h.id);
    const actual = guardOf(h.body);
    const declared = DECLARED[h.id];

    if (!declared) {
      assert(
        false,
        `${h.id} (${h.file}) has no entry in check-routes.ts. Every handler must declare who may call it — add a line saying its guard and why.`,
      );
      continue;
    }

    assert(
      actual === declared.guard,
      `${h.id} declares "${declared.guard}" (${declared.why}) but the code applies "${actual}"`,
    );

    if (isAdminMutation(h)) {
      assert(
        actual.startsWith("write:"),
        `${h.id} changes an admin surface but uses "${actual}". A mutation must call requireWriteRole, or a demo admin — one click from the public sign-in page — can run it.`,
      );
    }

    if (h.route.startsWith("/api/admin") || h.route.startsWith("/api/test")) {
      assert(
        actual === "role:admin" || actual === "write:admin",
        `${h.id} is an admin surface guarded by "${actual}"`,
      );
    }
  }

  for (const id of Object.keys(DECLARED)) {
    assert(seen.has(id), `${id} is declared in check-routes.ts but no such handler exists — remove the stale entry`);
  }

  const guards = handlers.map((h) => guardOf(h.body));
  const open = handlers.filter((_, i) => guards[i] === "public").length;
  console.log(
    `${DIM}${handlers.length} handlers in ${new Set(handlers.map((h) => h.file)).size} route files: ` +
      `${guards.filter((g) => g.startsWith("write:")).length} write-guarded, ` +
      `${guards.filter((g) => g.startsWith("role:")).length} role-guarded, ` +
      `${guards.filter((g) => g === "user" || g === "posting").length} account-guarded, ` +
      `${guards.filter((g) => g === "cron-secret" || g === "webhook").length} secret-guarded, ` +
      `${open} deliberately public${RESET}`,
  );

  if (failures.length) {
    console.log(`\n${RED}${failures.length} of ${checks} route authorization checks failed${RESET}`);
    for (const f of failures) console.log(`  ${RED}✗${RESET} ${f}`);
    process.exit(1);
  }
  console.log(`\n${GREEN}✓${RESET} ${checks} route authorization checks passed\n`);
  process.exit(0);
}

main();
