import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { AdminConsole } from "@/components/AdminConsole";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");

  const groups = await query<{ id: number; name: string; active: boolean; message_count: number; load_count: number }>(
    `SELECT g.id, g.name, g.active,
            (SELECT count(*) FROM raw_messages m WHERE m.group_id = g.id)::int AS message_count,
            (SELECT count(*) FROM loads l WHERE l.group_id = g.id)::int AS load_count
       FROM whatsapp_groups g ORDER BY message_count DESC`,
  );

  return (
    <AppShell user={user} active="admin">
      <AdminConsole groups={groups} />
    </AppShell>
  );
}
