import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { isSafeNext, type Role } from "@/lib/session";
import { AuthForm } from "@/components/AuthForm";
import { AppShell } from "@/components/AppShell";
import {
  DEMO_ACCOUNTS,
  demoModeEnabled,
  ensureDemoData,
  ensureRealAdmin,
} from "@/lib/demo/accounts";

export const dynamic = "force-dynamic";

/**
 * The demo buttons in the order a visitor should meet them.
 *
 * Poster comes first because it is the account that exists to *do* something on
 * this site. Driver comes last and is worded around the one thing it unlocks --
 * it is not the front door, the public board is, and the normal way a driver
 * signs in is the contact gate inside a job they already want.
 *
 * Admin is not on this list and is not in `demoAccounts` at all: it is
 * password-only now, through the e-mail form below the buttons. That form is
 * therefore the ONLY way into a console, which is why it stays reachable on
 * this page no matter what `DEMO_MODE` says.
 */
const ORDER: Role[] = ["poster", "driver"];

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
  //
  // The `else` is not symmetry for its own sake: with DEMO_MODE=off this page is
  // the only door to a console, and ensureDemoData() -- which would otherwise
  // have created the admin -- is skipped precisely so the sample corpus stays
  // out. Without this line the production cutover ships a site nobody can
  // administer, which is the failure wave one left behind.
  const demo = demoModeEnabled();
  if (demo) await ensureDemoData();
  else await ensureRealAdmin();

  const accounts = demo
    ? DEMO_ACCOUNTS.filter((a) => a.oneClick)
        .sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key))
        .map(({ key, name, role, blurb }) => ({ key, name, role, blurb }))
    : [];

  // The auth screens used to render bare, which left them the only two pages
  // on the site with no header: no way back to the board except the browser's
  // own, and no reach to the legal pages from the one screen that asks a
  // visitor for an email and a password. They wear the shell now, like
  // everything else that is not the board itself.
  return (
    <AppShell user={null} active="auth" currentPath="/login">
      <AuthForm mode="login" next={next} demoAccounts={accounts} />
    </AppShell>
  );
}
