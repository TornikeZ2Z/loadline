import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { loginHref } from "@/lib/session";
import { AppShell } from "@/components/AppShell";
import { TestConsole } from "@/components/TestConsole";
import { getMessage, listGroups, listMessages } from "@/lib/demo/chats";

export const dynamic = "force-dynamic";

/**
 * The WhatsApp console, now behind the admin gate where it belongs: its
 * payloads carry raw phone numbers and unmasked message bodies.
 *
 * `?message=<id>` opens on that message. It selects the message's **own** group
 * rather than the first one in the list -- a job linked from the board can come
 * from any group, and landing on a transcript that does not contain it would
 * make the link look broken.
 */
export default async function AdminTestPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect(loginHref("/admin/test"));
  if (user.role !== "admin") redirect("/");

  const sp = await searchParams;
  const raw = typeof sp.message === "string" ? Number(sp.message) : NaN;
  const message = Number.isFinite(raw) ? await getMessage(raw) : null;

  const groups = await listGroups();
  const groupId = message?.group_id ?? groups[0]?.id ?? null;

  return (
    <AppShell user={user} active="test" currentPath="/admin/test">
      <TestConsole
        initialGroups={groups}
        initialGroupId={groupId}
        initialMessages={await listMessages(groupId)}
        initialMessageId={message ? message.id : null}
      />
    </AppShell>
  );
}
