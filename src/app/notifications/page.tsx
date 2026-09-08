import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth";
import { loginHref } from "@/lib/session";
import { listNotifications } from "@/lib/notify/query";
import { AppShell } from "@/components/AppShell";
import { NotificationList } from "@/components/NotificationList";

/**
 * Everything this account has been told, newest first.
 *
 * The rows are fetched HERE rather than by the list component, so the page
 * arrives rendered: this is a screen somebody opens from a bell they just saw a
 * number on, and a spinner between the number and the reason for it is the one
 * thing it must not do.
 *
 * `listNotifications` is `WHERE user_id = $1` with the id off the signed cookie.
 * There is no id in this URL and nothing in the query string is read.
 */
export const dynamic = "force-dynamic";

/** Somebody's own alerts. There is nothing here for a search engine. */
export const metadata: Metadata = { robots: { index: false }, title: "Notifications" };

export default async function NotificationsPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginHref("/notifications"));

  const rows = await listNotifications(user.id);

  return (
    <AppShell user={user} active="account" currentPath="/notifications">
      <main className="mx-auto w-full max-w-[760px] px-[var(--sp-4)] pb-[var(--sp-8)] pt-[var(--sp-6)]">
        <div className="mb-[var(--sp-4)] flex flex-wrap items-end justify-between gap-[var(--sp-2)]">
          <div>
            <h1 className="big text-(length:--fs-2xl)">Notifications</h1>
            <p className="mt-[var(--sp-1)] text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
              Loads that match your trucks, and trucks that could take your loads. Nothing is sent
              anywhere else — these live here.
            </p>
          </div>
          <Link className="btn" href="/settings/notifications">
            Settings
          </Link>
        </div>

        <NotificationList initial={rows} />
      </main>
    </AppShell>
  );
}
