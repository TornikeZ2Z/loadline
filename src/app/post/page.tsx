import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { loginHref } from "@/lib/session";
import { AppShell } from "@/components/AppShell";

/**
 * The chooser: a load to move, or space on a truck.
 *
 * `/post` used to BE the load form. It is now one question with two answers,
 * because the board has two kinds of listing and neither is the default one --
 * a mover who drives a full truck south and returns empty posts both, in the
 * same week, from the same account.
 *
 * WHO SEES IT, SAID BEFORE THE FORM (L06 / V12). This page used to end on
 * "both are free, both are public, and neither shows your phone number until
 * somebody signs in to ask for it." The last clause was true. The middle one
 * was not, for the account most likely to be reading it: a demo account's
 * listing is stamped `is_demo` and served to nobody but its poster
 * (`demoVisibilitySql`, src/lib/loads/query.ts and truckQuery.ts). The demo
 * poster learned that at the top of the NEXT page, after choosing. So the
 * visibility statement is now the first thing on this page, it is written from
 * `user.isDemo` rather than in the abstract, and it names the two things a
 * demo visitor otherwise conflates: the sample board they have been browsing,
 * which is seeded corpus data and public, and the listing they are about to
 * make, which is not.
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
        <p className="mt-[var(--sp-1)] text-(length:--fs-md)" style={{ color: "var(--muted)" }}>
          Two kinds of listing, and the same account posts both. Free, and nothing here takes a cut.
        </p>

        {/* Before the choice, not after it, and not on the next page. */}
        {user.isDemo ? (
          <div
            className="mt-[var(--sp-4)] rounded-[var(--radius-md)] p-[var(--sp-4)] text-(length:--fs-base) leading-relaxed"
            style={{ background: "var(--warn-soft)", color: "var(--warn)" }}
          >
            <strong className="block">Who will see this: only you.</strong>
            <p className="mt-[var(--sp-2)]">
              You are signed in to a shared demo account. Whichever of the two you post, it is
              stamped as a demo listing and served to this account and nobody else — it does not
              reach the public board, and no other mover can find it or call you about it. Everything
              else works: you can open it, filter to it and mark it taken.
            </p>
            <p className="mt-[var(--sp-2)]">
              That is a different thing from the loads you have been browsing. Those are sample
              inventory, seeded from real group posts, and they are public — every visitor sees the
              same board with or without an account. To post something other movers can see, sign
              out from the account menu and register an account of your own.
            </p>
          </div>
        ) : (
          <div
            className="mt-[var(--sp-4)] rounded-[var(--radius-md)] border p-[var(--sp-4)] text-(length:--fs-base) leading-relaxed"
            style={{ borderColor: "var(--border)", background: "var(--surface-2)", color: "var(--text-2)" }}
          >
            <strong className="block" style={{ color: "var(--text)" }}>
              Who will see this: everyone.
            </strong>
            <p className="mt-[var(--sp-2)]">
              Both kinds of listing go straight onto the public board. Anyone browsing it sees yours,
              signed in or not, and so does anyone you send the link to.
            </p>
            <p className="mt-[var(--sp-2)]">
              Your phone number does not. It is masked in every public copy, handed out one listing
              at a time to a signed-in account, and each reveal is recorded. When the work is gone,
              mark it taken or cancelled from its own page; only you and an admin can.
            </p>
          </div>
        )}

        <div className="mt-[var(--sp-4)] grid gap-[var(--sp-3)] md:grid-cols-2">
          <Choice
            href={`/post/job${suffix}`}
            title="I have a load to move"
            body="Where it is, where it goes, how many cubic feet, and what it pays. Drivers hunting a backhaul see it on the board and on the map."
            cta="Post a load"
          />
          <Choice
            href={`/post/truck${suffix}`}
            title="I have space on a truck"
            body="An empty leg: where you will be free, where you are headed, and how much room is left. Takes about a minute, and anything you do not know stays blank."
            cta="Post truck space"
          />
        </div>

        <p className="mt-[var(--sp-4)] text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
          Posting is open to any signed-in account — the word you picked when you registered says
          which door you came in through, not what you may do. See{" "}
          <Link href="/how-it-works" className="underline">
            How it works
          </Link>{" "}
          for what happens to a listing once it is up.
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
