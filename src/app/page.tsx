import { getCurrentUser } from "@/lib/auth";
import { demoModeEnabled, ensureDemoData } from "@/lib/demo/accounts";
import { AppShell } from "@/components/AppShell";
import { Board } from "@/components/Board";

/**
 * The board is the home page and it is public.
 *
 * No redirect, no sign-in, no dashboard first: a mover who is sent a link opens
 * the map and the list. An account buys exactly one thing (the contact on a
 * job), and it is asked for inside the job, not at the door.
 */
export const dynamic = "force-dynamic";

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getCurrentUser();
  // A cold database self-seeds on the first visit so the demo is never empty.
  if (demoModeEnabled()) await ensureDemoData();

  // Pass the incoming query through so a shared link opens the same search.
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") sp.set(key, value);
    else value?.forEach((v) => sp.append(key, v));
  }

  const qs = sp.toString();
  // The shell needs the exact path + query for loginHref(next): a driver who
  // signs in from the header has to come back to this search, not to "/".
  const currentPath = qs ? `/?${qs}` : "/";

  return (
    <AppShell user={user} active="board" currentPath={currentPath}>
      <Board
        initialQuery={qs}
        signedIn={!!user}
        role={user?.role ?? null}
        userId={user?.id ?? null}
        demoMode={demoModeEnabled()}
      />
    </AppShell>
  );
}
