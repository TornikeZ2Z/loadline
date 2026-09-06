import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { jobIdFrom } from "@/lib/api";
import { getCurrentUser } from "@/lib/auth";
import { demoModeEnabled, ensureDemoData } from "@/lib/demo/accounts";
import { AppShell } from "@/components/AppShell";
import { Board } from "@/components/Board";

/**
 * One job, deep-linked -- the same public board with its drawer already open.
 *
 * It is the board rather than a page of its own because that is what a shared
 * link should restore: the route on the map, the list around it, the filters
 * that were applied. Closing the drawer leaves you somewhere useful instead of
 * on a dead end.
 */
export const dynamic = "force-dynamic";

/**
 * Jobs come and go by the hour and a search-engine copy of one would be a lie
 * within a day; the board itself is the page worth indexing.
 */
export const metadata: Metadata = { robots: { index: false } };

export default async function JobPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  // The same reading of a path segment the API routes use: digits only, inside
  // bigint range. `Number.isFinite` alone accepts "1.5", "0x10" and a 20-digit
  // string, all of which reach the database and come back as a 500 rather than
  // the 404 a made-up URL deserves.
  const jobId = jobIdFrom(id);
  if (jobId == null) notFound();

  const user = await getCurrentUser();
  if (demoModeEnabled()) await ensureDemoData();

  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") sp.set(key, value);
    else value?.forEach((v) => sp.append(key, v));
  }

  const qs = sp.toString();
  // Signing in from the header has to come back here, with this search and this
  // drawer -- so the shell is told the exact path rather than guessing at one.
  const currentPath = `/jobs/${id}${qs ? `?${qs}` : ""}`;

  return (
    <AppShell user={user} active="board" currentPath={currentPath}>
      <Board
        initialQuery={qs}
        initialJobId={jobId}
        signedIn={!!user}
        role={user?.role ?? null}
        userId={user?.id ?? null}
        demoMode={demoModeEnabled()}
      />
    </AppShell>
  );
}
