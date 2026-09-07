import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { jobIdFrom } from "@/lib/api";
import { getCurrentUser } from "@/lib/auth";
import { demoModeEnabled, ensureDemoData } from "@/lib/demo/accounts";
import { AppShell } from "@/components/AppShell";
import { Board } from "@/components/Board";

/**
 * One truck, deep-linked -- the same public board with the Trucks tab open and
 * its drawer already showing.
 *
 * The board rather than a page of its own, for the same reason `/jobs/[id]` is:
 * a shared link should restore the search that produced the listing, not a dead
 * end. Closing the drawer leaves the dispatcher on the truck board.
 *
 * Nothing is fetched here. The row itself comes from `GET /api/trucks/:id`,
 * which is where the scope and the audience live -- a truck in the review queue
 * and another account's demo truck both 404 there, and a page that pre-fetched
 * would be a second place for that decision to be got wrong.
 *
 * `jobIdFrom` parses the segment: digits only, inside bigint range. It is named
 * for the board it was written on and knows nothing about jobs.
 */
export const dynamic = "force-dynamic";

/**
 * Trucks come and go by the DAY -- a 48-hour listing at the outside -- so a
 * search-engine copy of one is stale faster than a job's. The board is the page
 * worth indexing.
 */
export const metadata: Metadata = { robots: { index: false } };

export default async function TruckPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const truckId = jobIdFrom(id);
  if (truckId == null) notFound();

  const user = await getCurrentUser();
  if (demoModeEnabled()) await ensureDemoData();

  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") sp.set(key, value);
    else value?.forEach((v) => sp.append(key, v));
  }

  const qs = sp.toString();
  const currentPath = `/trucks/${id}${qs ? `?${qs}` : ""}`;

  return (
    <AppShell user={user} active="board" currentPath={currentPath}>
      <Board
        initialQuery={qs}
        initialTruckId={truckId}
        signedIn={!!user}
        role={user?.role ?? null}
        userId={user?.id ?? null}
        demoMode={demoModeEnabled()}
      />
    </AppShell>
  );
}
