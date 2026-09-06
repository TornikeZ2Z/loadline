import { redirect } from "next/navigation";

/**
 * The board moved to "/". This keeps every link that was ever shared, and the
 * console's "See it on the board", working -- with the search intact, which is
 * the part a bare redirect to "/" would have thrown away.
 */
export const dynamic = "force-dynamic";

export default async function LoadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") sp.set(key, value);
    else value?.forEach((v) => sp.append(key, v));
  }

  const qs = sp.toString();
  redirect(qs ? `/?${qs}` : "/");
}
