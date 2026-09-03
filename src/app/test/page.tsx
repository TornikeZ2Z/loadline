import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { TestConsole } from "@/components/TestConsole";
import { listGroups, listMessages } from "@/lib/demo/chats";

export const dynamic = "force-dynamic";

export default async function TestPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const groups = await listGroups();
  const first = groups[0]?.id ?? null;

  return (
    <AppShell user={user} active="test">
      <TestConsole
        initialGroups={groups}
        initialGroupId={first}
        initialMessages={await listMessages(first)}
      />
    </AppShell>
  );
}
