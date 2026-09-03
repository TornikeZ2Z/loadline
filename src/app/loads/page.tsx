import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { Board } from "@/components/Board";

export const dynamic = "force-dynamic";

export default async function LoadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // Pass the incoming query through so a shared link opens the same search.
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") sp.set(key, value);
    else value?.forEach((v) => sp.append(key, v));
  }

  return (
    <AppShell user={user} active="loads">
      <Board user={user} initialQuery={sp.toString()} />
    </AppShell>
  );
}
