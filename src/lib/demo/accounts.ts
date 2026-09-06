/**
 * Demo accounts and self-seeding.
 *
 * A hosted demo has to be useful the instant someone opens it, including on a
 * cold start where the embedded database was just rebuilt from nothing. So the
 * app seeds itself: if there are no users, create the demo accounts and replay
 * the sample WhatsApp corpus through the real pipeline.
 *
 * `ensureDemoData()` is cheap to call repeatedly -- one count query when the
 * database is already populated -- and is awaited by every entry point that
 * could be the first page of a cold demo: the board, a deep-linked job, the
 * sign-in page and the demo sign-in route.
 */
import { createHmac } from "node:crypto";
import { query, queryOne } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import type { Role } from "@/lib/session";
import { resetDemoData } from "./reset";

export interface DemoAccount {
  /** "driver" | "poster" | "admin" -- the one-click sign-in key, equal to the role. */
  key: Role;
  email: string;
  name: string;
  role: Role;
  company: string | null;
  phone: string | null;
  /** Shown under the sign-in button. */
  blurb: string;
}

// Driver stays first: `findDemoAccount(role ?? "driver")` and the contact gate
// rely on the driver default. `/login` re-sorts the buttons poster · admin · driver.
export const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    key: "driver",
    email: "driver@example.com",
    name: "Dan Driver",
    role: "driver",
    company: "Kaz Moving LLC",
    phone: "+19735550000",
    blurb: "See the contact on any job",
  },
  {
    key: "poster",
    email: "poster@example.com",
    name: "Rosa Poster",
    role: "poster",
    company: "Sunshine Movers",
    phone: "+19085557788",
    blurb: "Post a job from the website and mark it taken",
  },
  {
    key: "admin",
    email: "admin@example.com",
    name: "Ops Admin",
    role: "admin",
    company: null,
    phone: null,
    blurb: "Pipeline, needs-attention queue and the WhatsApp console",
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

export async function createDemoAccounts(): Promise<void> {
  for (const a of DEMO_ACCOUNTS) {
    await query(
      // DO UPDATE, not DO NOTHING: a database seeded when the password was a
      // published literal still holds that hash, and the whole point of this
      // change is that those rows stop accepting it. Every cold start rotates
      // them. Only the demo identities are touched; a real account created
      // through /register shares no e-mail with them.
      `INSERT INTO users (email, password_hash, name, role, phone, company)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
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

  // Unconditional, and cheap: three upserts. A database seeded before the demo
  // password stopped being a published literal still holds hashes of it, and
  // returning early here is exactly what would let them survive. Every cold
  // start now rotates them to the derived value.
  await createDemoAccounts();
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

export function findDemoAccount(key: string): DemoAccount | undefined {
  return DEMO_ACCOUNTS.find((a) => a.key === key);
}
