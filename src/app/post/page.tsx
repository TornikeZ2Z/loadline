import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { loginHref } from "@/lib/session";
import { AppShell } from "@/components/AppShell";

/**
 * The chooser: freight, or space on a truck.
 *
 * `/post` used to BE the job form. It is now one question with two answers,
 * because the board has two kinds of listing and neither is the default one --
 * a mover who drives a full truck south and returns empty posts both, in the
 * same week, from the same account.
 *
 * The query string is carried through to whichever card is chosen, so a link
 * that arrives here with a search on it (or with `?notice=…`) does not lose it
 * on the way to the form.
 *
 * Both gates are the same as before and are applied here rather than twice on
 * the pages below: signing in is required to post anything, and `canPost` is a
 * capability every account has unless an admin switched it off.
 */
export const dynamic = "force-dynamic";

export default async function PostPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect(loginHref("/post"));
  if (!user.canPost) redirect("/?notice=poster-only");

  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") sp.set(key, value);
    else value?.forEach((v) => sp.append(key, v));
  }
  const qs = sp.toString();
  const suffix = qs ? `?${qs}` : "";

  return (
    <AppShell user={user} active="post" currentPath={`/post${suffix}`}>
      <div className="mx-auto max-w-[720px] p-[var(--sp-5)]">
        <h1 className="big text-(length:--fs-xl)">Post to the board</h1>
        <p className="mt-[var(--sp-1)] text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
          Two kinds of listing, and the same account posts both.
        </p>

        <div className="mt-[var(--sp-4)] grid gap-[var(--sp-3)] md:grid-cols-2">
          <Choice
            href={`/post/job${suffix}`}
            title="I have freight to move"
            body="A shipment: where it is, where it goes, how many cubic feet, and what it pays. Drivers hunting a backhaul see it on the board and on the map."
            cta="Post a job"
          />
          <Choice
            href={`/post/truck${suffix}`}
            title="I have space on a truck"
            body="An empty leg: where you will be free, where you are headed, and how much room is left. Takes about a minute, and anything you don't know stays blank."
            cta="Post truck space"
          />
        </div>

        <p className="mt-[var(--sp-4)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
          Both are free, both are public, and neither shows your phone number until somebody signs in
          to ask for it.
        </p>
      </div>
    </AppShell>
  );
}

function Choice({
  href,
  title,
  body,
  cta,
}: {
  href: string;
  title: string;
  body: string;
  cta: string;
}) {
  return (
    <Link
      href={href}
      className="card card-hover flex flex-col gap-[var(--sp-2)] p-[var(--sp-4)]"
      style={{ color: "inherit" }}
    >
      <div className="big text-(length:--fs-lg)">{title}</div>
      <p className="text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
        {body}
      </p>
      <span
        className="mt-auto pt-[var(--sp-2)] text-(length:--fs-base) font-semibold"
        style={{ color: "var(--accent)" }}
      >
        {cta} →
      </span>
    </Link>
  );
}
