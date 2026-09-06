import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { loginHref } from "@/lib/session";
import { AppShell } from "@/components/AppShell";
import { AdminConsole } from "@/components/AdminConsole";
import { listGroups } from "@/lib/demo/chats";

export const dynamic = "force-dynamic";

const TABS = ["attention", "try", "messages", "senders", "rules", "groups"] as const;
type Tab = (typeof TABS)[number];

/**
 * The admin console. It opens on Needs attention because that is the only tab
 * with work waiting in it -- a message the rules could not read is a job nobody
 * on the board can see.
 *
 * `?tab=` and `?message=` exist so the job detail can link an admin straight to
 * the message a job came from.
 */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect(loginHref("/admin"));
  if (user.role !== "admin") redirect("/");

  const sp = await searchParams;
  const rawTab = typeof sp.tab === "string" ? sp.tab : undefined;
  const tab = TABS.includes(rawTab as Tab) ? (rawTab as Tab) : undefined;

  const rawMessage = typeof sp.message === "string" ? Number(sp.message) : NaN;
  const messageId = Number.isFinite(rawMessage) ? rawMessage : null;

  const groups = await listGroups();

  return (
    <AppShell user={user} active="admin" currentPath="/admin">
      <AdminConsole groups={groups} initialTab={tab} initialMessageId={messageId} />
    </AppShell>
  );
}
