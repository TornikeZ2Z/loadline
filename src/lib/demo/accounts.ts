/**
 * Seeded accounts and self-seeding.
 *
 * A hosted demo has to be useful the instant someone opens it, including on a
 * cold start where the embedded database was just rebuilt from nothing. So the
 * app seeds itself: if there are no users, create the seeded accounts and replay
 * the sample WhatsApp corpus through the real pipeline.
 *
 * `ensureDemoData()` is cheap to call repeatedly -- one count query when the
 * database is already populated -- and is awaited by every entry point that
 * could be the first page of a cold demo: the board, a deep-linked job, the
 * sign-in page and the demo sign-in route.
 *
 * Two kinds of account are seeded here and they are not the same thing. The
 * DEMO accounts below carry `users.is_demo`, which costs them every write
 * (src/lib/auth.ts `requireWriteRole`). The REAL ADMIN at the bottom of this
 * file does not, and it is the only account in the product that can reset the
 * corpus, edit a rule or spend money at HERE. It lives in this file because
 * this is the seeding module -- the one thing that runs on a cold start before
 * anybody can sign in -- not because it has anything to do with the demo.
 */
import { createHmac } from "node:crypto";
import { query, queryOne } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import type { Role } from "@/lib/session";
import { resetDemoData } from "./reset";

export interface DemoAccount {
  /** "driver" | "poster" | "admin" -- the sign-in key, equal to the role. */
  key: Role;
  email: string;
  name: string;
  role: Role;
  company: string | null;
  phone: string | null;
  /** Shown under the sign-in button. */
  blurb: string;
  /**
   * Does this account get a one-click button on /login, and may
   * POST /api/auth/demo issue a session for it?
   *
   * False for the demo admin, and that is the whole of it: the button is gone
   * from the sign-in page AND the route refuses the key, because removing the
   * button alone would leave `curl -d '{"role":"admin"}'` as an unguarded door
   * to every console. The row itself stays seeded and stays `is_demo`, so its
   * password keeps rotating with SESSION_SECRET on every cold start; dropping
   * it from this list instead would freeze whatever hash it happens to hold.
   */
  oneClick: boolean;
}

// Driver stays first: `findOneClickAccount(role ?? "driver")` and the contact
// gate rely on the driver default. `/login` re-sorts the buttons poster · driver.
export const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    key: "driver",
    email: "driver@example.com",
    name: "Dan Driver",
    role: "driver",
    company: "Kaz Moving LLC",
    phone: "+19735550000",
    // "on any job" until the board had trucks on it. The demo driver is the
    // account a stranger enters with one click, and the walkthrough it is for
    // now includes posting their own empty leg -- so the blurb has to name the
    // board rather than one kind of row on it.
    blurb: "See the contact on any listing, and post your own truck",
    oneClick: true,
  },
  {
    key: "poster",
    email: "poster@example.com",
    name: "Rosa Poster",
    role: "poster",
    company: "Sunshine Movers",
    phone: "+19085557788",
    blurb: "Post a job from the website and mark it taken",
    oneClick: true,
  },
  {
    key: "admin",
    email: "admin@example.com",
    name: "Ops Admin",
    role: "admin",
    company: null,
    phone: null,
    // No button, and no `POST /api/auth/demo` either -- see `oneClick`. The
    // blurb is kept only so this row still describes itself in scripts/seed.ts
    // output; nothing renders it any more.
    blurb: "Read-only console access; no one-click sign-in (see ADMIN_EMAIL below)",
    oneClick: false,
  },
];

/**
 * Password for the demo accounts, for anyone who prefers the normal form.
 *
 * NEVER a literal. This repository is public and the deployment is public, so a
 * password written here is a published credential: it was `demo1234`, printed
 * in README and DEMO, and it granted admin — including `POST /api/test/reset`,
 * which truncates the corpus — to anyone who read either file. Turning
 * DEMO_MODE off would not have helped, because that only removes the one-click
 * buttons; the ordinary e-mail form kept accepting it.
 *
 * So: whatever `DEMO_PASSWORD` is set to, else a value derived from
 * SESSION_SECRET. Derived rather than random because every task in a service
 * has to arrive at the same answer, and rotating SESSION_SECRET — which already
 * signs out every session — rotates this too. A deployment with no
 * SESSION_SECRET is refused in production by src/lib/auth.ts, and locally it
 * falls back to a development string, which is the only case where this value
 * is predictable and the only case where that is harmless.
 */
export const DEMO_PASSWORD =
  process.env.DEMO_PASSWORD ??
  createHmac("sha256", process.env.SESSION_SECRET ?? "loadline-dev-secret")
    .update("demo-account-password/v1")
    .digest("base64url")
    .slice(0, 16);

/**
 * One-click demo sign-in. On by default so a hosted demo needs no instructions;
 * set `DEMO_MODE=off` to disable it (the accounts and the password form stay).
 */
export function demoModeEnabled(): boolean {
  return (process.env.DEMO_MODE ?? "on").toLowerCase() !== "off";
}

// --- the real admin ----------------------------------------------------------

/**
 * The one account in the product that can change what everyone else sees.
 *
 * Every seeded account carries `users.is_demo`, and `requireWriteRole` refuses
 * a demo account every write -- so after wave one the live site had nobody who
 * could reset the corpus, edit a rule or run the geocode backfill. This row is
 * that person: `is_demo` false, created on the same cold-start path as the demo
 * rows, because an account that only exists once somebody SSHes in is an
 * account the live site does not have.
 *
 * There is deliberately no button and no form field that produces it. It signs
 * in through the ordinary e-mail form on /login and nowhere else.
 */
export const ADMIN_EMAIL = "admin@movermesh.com";

/**
 * scrypt hash of the chosen password, `ZipToZip123!`.
 *
 * RESIDUAL RISK, stated plainly because it is real: this repository is public,
 * so this hash is public, and the password behind it is short and wordlist-
 * guessable -- anyone who reads this file can recover it offline in seconds and
 * sign in as a full admin on the live site. The CTO chose this password after
 * being advised against it and reaffirmed the choice; it is recorded here so
 * the next person to read this line knows it is a known cost, not an oversight.
 *
 * The fix needs no code change: set `ADMIN_PASSWORD` as a secret on the task
 * and the next cold start hashes that instead (see `adminPasswordHash`). Until
 * then the only thing standing between a reader of this file and
 * `POST /api/test/reset` is that nobody has looked.
 */
const ADMIN_PASSWORD_HASH =
  "scrypt$O5EqXzWrHAfwAdO56mvjJw$q_PjhS6mTaQvD1zlydaUDk_jACwFNTAEHMuTYaoEvLpdKebBK1wzieWwsQZM8_Evpz_8EKrQMQFhU4QoJVyOeA";

/**
 * `ADMIN_PASSWORD` first, then the committed hash.
 *
 * The environment wins so the password can be strengthened by setting one
 * secret and restarting -- no code change, no migration, no deploy of this
 * file. The committed hash is the floor that makes a fresh deployment usable
 * before anybody has set that secret.
 *
 * Never the plaintext: only the hash is written down here, so reading this file
 * costs an offline attack rather than handing the password over.
 */
function adminPasswordHash(): string {
  const configured = process.env.ADMIN_PASSWORD;
  return configured ? hashPassword(configured) : ADMIN_PASSWORD_HASH;
}

/**
 * Create the real admin, or bring an existing row back in line with this file.
 *
 * DO UPDATE rather than DO NOTHING, for the same reason the demo rows rotate:
 * this account is DEFINED IN CODE, so the code is what it is. That is what
 * makes `ADMIN_PASSWORD` work at all -- a row that kept its first password
 * could never be strengthened without a shell. It also means a hand-edited
 * password, or `admin:grant --revoke` run against this address, is undone on
 * the next cold start; the supported ways to close this account are to set
 * `ADMIN_PASSWORD` or to delete the row.
 *
 * `is_demo` false is re-asserted on the same pass and is the load-bearing part:
 * it is the entire difference between this row and the seeded demo admin.
 */
export async function ensureRealAdmin(): Promise<void> {
  await query(
    `INSERT INTO users (email, password_hash, name, role, phone, company, is_demo, can_post)
     VALUES ($1,$2,'MoverMesh Admin','admin',NULL,NULL,false,true)
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, role = 'admin', is_demo = false`,
    [ADMIN_EMAIL, adminPasswordHash()],
  );
}

export async function createDemoAccounts(): Promise<void> {
  for (const a of DEMO_ACCOUNTS) {
    await query(
      // DO UPDATE, not DO NOTHING: a database seeded when the password was a
      // published literal still holds that hash, and the whole point of this
      // change is that those rows stop accepting it. Every cold start rotates
      // them. Only the demo identities are touched; a real account created
      // through /register shares no e-mail with them.
      //
      // `is_demo` is re-asserted on the same pass, and for the same reason: it
      // is what stops a one-click admin session reaching POST /api/test/reset,
      // so a row that lost the flag -- seeded before the column existed, or
      // cleared by hand -- must not stay unmarked until the next deploy.
      `INSERT INTO users (email, password_hash, name, role, phone, company, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,true)
       ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash, is_demo = true`,
      [a.email, hashPassword(DEMO_PASSWORD), a.name, a.role, a.phone, a.company],
    );
  }
}

// A cold start can serve several requests at once; without this they would all
// decide the database is empty and seed it in parallel.
let seeding: Promise<void> | null = null;

/** Populate an empty database with demo accounts and sample traffic. */
export async function ensureDemoData(): Promise<void> {
  // Read this BEFORE touching the accounts: creating them is what makes the
  // table non-empty, so asking afterwards would never seed a fresh database.
  const existing = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
  const fresh = (existing?.n ?? 0) === 0;

  // Unconditional, and cheap: four upserts. A database seeded before the demo
  // password stopped being a published literal still holds hashes of it, and
  // returning early here is exactly what would let them survive. Every cold
  // start now rotates them to the derived value.
  await createDemoAccounts();
  // Unconditional for a second reason: the live database is NOT fresh, so an
  // admin created only on the `fresh` branch would never appear on the one
  // deployment that currently has no admin at all.
  await ensureRealAdmin();
  if (!fresh) return;

  seeding ??= (async () => {
    try {
      await resetDemoData();
    } finally {
      seeding = null;
    }
  })();

  await seeding;
}

/**
 * A demo account that may be entered with one click.
 *
 * Named for what it grants rather than for what it looks up: a lookup that
 * ignored `oneClick` would hand `POST /api/auth/demo` the admin row again, and
 * the whole of removing the button is that the route refuses it too.
 */
export function findOneClickAccount(key: string): DemoAccount | undefined {
  return DEMO_ACCOUNTS.find((a) => a.key === key && a.oneClick);
}
