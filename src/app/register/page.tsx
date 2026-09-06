import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { isSafeNext } from "@/lib/session";
import { AuthForm } from "@/components/AuthForm";
import { AppShell } from "@/components/AppShell";

export const dynamic = "force-dynamic";

/**
 * Creating an account. Driver or poster -- never admin, whatever the form says.
 *
 * `?as=` is set by the link inside the contact gate ("Create a driver account")
 * and by the post page, so the segmented choice starts on the reason the person
 * actually came. `?next=` brings them back to the job they were looking at.
 */
export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : null;

  if (await getCurrentUser()) redirect(isSafeNext(next) ? next : "/");

  const as = sp.as === "poster" ? "poster" : "driver";

  // Same shell as every other page; see the note on /login.
  return (
    <AppShell user={null} active="auth" currentPath="/register">
      <AuthForm mode="register" as={as} next={next} demoAccounts={[]} />
    </AppShell>
  );
}
