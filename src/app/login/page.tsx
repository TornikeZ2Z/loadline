import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AuthForm } from "@/components/AuthForm";
import { DEMO_ACCOUNTS, demoModeEnabled, ensureDemoData } from "@/lib/demo/accounts";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");

  // A hosted demo may be starting from an empty database. Seeding here means the
  // one-click buttons work on the very first visit after a cold start.
  const demo = demoModeEnabled();
  if (demo) await ensureDemoData();

  return (
    <AuthForm
      mode="login"
      demoAccounts={demo ? DEMO_ACCOUNTS.map(({ key, name, role, blurb }) => ({ key, name, role, blurb })) : []}
    />
  );
}
