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
import type { Role } from "@/lib/auth";
import { resetDemoData } from "./reset";

export interface DemoAccount {
  key: "carrier" | "broker" | "admin";
  email: string;
  name: string;
  role: Role;
  company: string | null;
  phone: string | null;
  homeLabel: string;
  homeLat: number;
  homeLng: number;
  /** Shown on the sign-in buttons. */
  blurb: string;
}

export const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    key: "carrier",
    email: "carrier@example.com",
    name: "Dan Carrier",
    role: "carrier",
    company: "Kaz Trucking LLC",
    phone: "+19735550000",
    homeLabel: "Newark, NJ",
    homeLat: 40.7357,
    homeLng: -74.1724,
    blurb: "Search loads by route, radius and date",
  },
  {
    key: "broker",
    email: "broker@example.com",
    name: "Rosa Broker",
    role: "broker",
    company: "Rosa Logistics",
    phone: "+19085557788",
    homeLabel: "Philadelphia, PA",
    homeLat: 39.9526,
    homeLng: -75.1652,
    blurb: "Post loads and mark them taken",
  },
  {
    key: "admin",
    email: "admin@example.com",
    name: "Ops Admin",
    role: "admin",
    company: null,
    phone: null,
    homeLabel: "Newark, NJ",
    homeLat: 40.7357,
    homeLng: -74.1724,
    blurb: "Inspect the pipeline and data quality",
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
      `INSERT INTO users (email, password_hash, name, role, phone, company, home_label, home_lat, home_lng)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (email) DO NOTHING`,
      [
        a.email,
        hashPassword(DEMO_PASSWORD),
        a.name,
        a.role,
        a.phone,
        a.company,
        a.homeLabel,
        a.homeLat,
        a.homeLng,
      ],
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
