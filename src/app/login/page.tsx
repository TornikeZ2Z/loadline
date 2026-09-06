import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { isSafeNext } from "@/lib/session";
import { AuthForm } from "@/components/AuthForm";
import { DEMO_ACCOUNTS, demoModeEnabled, ensureDemoData } from "@/lib/demo/accounts";

export const dynamic = "force-dynamic";

/**
 * The demo buttons in the order a visitor should meet them.
 *
 * Poster and Admin come first because they are the accounts that exist to *do*
 * something on this site. Driver comes last and is worded around the one thing
 * it unlocks -- it is not the front door, the public board is, and the normal
 * way a driver signs in is the contact gate inside a job they already want.
 */
const ORDER = ["poster", "admin", "driver"] as const;

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : null;

  // Already signed in: honour where they were headed.
  if (await getCurrentUser()) redirect(isSafeNext(next) ? next : "/");

  // A hosted demo may be starting from an empty database. Seeding here means the
  // one-click buttons work on the very first visit after a cold start.
  const demo = demoModeEnabled();
  if (demo) await ensureDemoData();

  const accounts = demo
    ? [...DEMO_ACCOUNTS]
        .sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key))
        .map(({ key, name, role, blurb }) => ({ key, name, role, blurb }))
    : [];

  return <AuthForm mode="login" next={next} demoAccounts={accounts} />;
}
