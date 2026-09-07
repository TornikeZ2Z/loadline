import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { isSafeNext } from "@/lib/session";
import { AuthForm } from "@/components/AuthForm";
import { AppShell } from "@/components/AppShell";

export const dynamic = "force-dynamic";

/**
 * Creating an account. Never admin, whatever the form says.
 *
 * `?as=` is set by the link inside the contact gate ("Create a driver account")
 * and by the post page, so the segmented choice starts on the reason the person
 * actually came. `?next=` brings them back to the job they were looking at.
 *
 * The choice is a starting point, not a fork: every account created here can
 * both see contacts and post jobs (`users.can_post`), so nobody who picks the
 * wrong one has to register twice. The form's own wording still reads as if the
 * two were alternatives -- that copy lives in src/components/AuthForm.tsx and
 * is the last thing left of the old exclusivity.
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
