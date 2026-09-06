/**
 * Demo accounts and self-seeding.
 *
 * A hosted demo has to be useful the instant someone opens it, including on a
 * cold start where the embedded database was just rebuilt from nothing. So the
 * app seeds itself: if there are no users, create the demo accounts and replay
 * the sample WhatsApp corpus through the real pipeline.
 *
 * `ensureDemoData()` is cheap to call repeatedly -- one count query when the
 * database is already populated -- and is awaited by the sign-in page and the
 * demo sign-in route.
 */
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
    blurb: "See the phone number on any job",
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

/** Password for the demo accounts, for anyone who prefers the normal form. */
export const DEMO_PASSWORD = "demo1234";

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
      `INSERT INTO users (email, password_hash, name, role, phone, company)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (email) DO NOTHING`,
      [a.email, hashPassword(DEMO_PASSWORD), a.name, a.role, a.phone, a.company],
    );
  }
}

// A cold start can serve several requests at once; without this they would all
// decide the database is empty and seed it in parallel.
let seeding: Promise<void> | null = null;

/** Populate an empty database with demo accounts and sample traffic. */
export async function ensureDemoData(): Promise<void> {
  const existing = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
  if ((existing?.n ?? 0) > 0) return;

  seeding ??= (async () => {
    try {
      await createDemoAccounts();
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
