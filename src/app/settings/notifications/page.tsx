import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth";
import { loginHref } from "@/lib/session";
import { getPrefs } from "@/lib/notify/query";
import { AppShell } from "@/components/AppShell";
import { NotificationSettings } from "@/components/NotificationSettings";

/**
 * What this account wants to be told, and what the product cannot do yet.
 *
 * Own row only: the preferences come from `getPrefs(user.id)` with the id off
 * the signed cookie, and there is nothing in this URL to name a different one.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { robots: { index: false }, title: "Notification settings" };

export default async function NotificationSettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginHref("/settings/notifications"));

  const prefs = await getPrefs(user.id);

  return (
    <AppShell user={user} active="account" currentPath="/settings/notifications">
      <main className="mx-auto w-full max-w-[760px] px-[var(--sp-4)] pb-[var(--sp-8)] pt-[var(--sp-6)]">
        <p className="label">Your account</p>
        <h1 className="big text-(length:--fs-2xl)">Notification settings</h1>
        <p
          className="mb-[var(--sp-5)] mt-[var(--sp-2)] max-w-[62ch] text-(length:--fs-md) leading-relaxed"
          style={{ color: "var(--text-2)" }}
        >
          You are told when a load matches a truck you posted, or a truck could take a job you
          posted. Nothing about your listings is sent to WhatsApp, and nothing is shared with anyone
          else on the board.
        </p>

        <NotificationSettings initial={prefs} />

        <p className="mt-[var(--sp-5)] text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
          <Link href="/notifications" className="underline">
            Back to your notifications
          </Link>
        </p>
      </main>
    </AppShell>
  );
}
