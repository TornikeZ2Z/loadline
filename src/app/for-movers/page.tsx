import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { PRICE_NOT_PROVIDED } from "@/lib/loads/present";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "For movers",
  description:
    "Find moving loads that fit your route: pickup and delivery, cubic feet and stated dates in one searchable board, with the original post attached and the poster one call away.",
};

/**
 * The marketing page. Rewritten against review 01 ("Messages and voice"),
 * V13 (marketing hierarchy) and L05 (the page contradicted the product).
 *
 * WHAT L05 CAUGHT, and what changed because of it:
 *
 * 1. THIS PAGE SAID TRUCK SPACE WAS NOT ON OFFER. It said so in a whole block
 *    with a heading, on the strength of a decision that was true when the page
 *    was written and stopped being true when trucks shipped: there IS a second
 *    table, a second form at /post/truck, a second detail page at /trucks/:id
 *    and a second lifecycle. A marketing page telling a driver that the thing
 *    they came for does not exist -- while the nav offers it -- is the worst
 *    version of this bug, because the reader believes it and leaves. The block
 *    is gone and "Offer work or space" is one of the three sections now.
 *
 * 2. IT SAID EVERY JOB STARTS IN A GROUP MESSAGE, and then invited the reader
 *    to post one directly. Both halves are true of different jobs, which makes
 *    the sentence false about the board. There are two provenances and the page
 *    now names both, because they are not equally checkable: a job read out of
 *    a group post carries that post on its page, and a job typed into the form
 *    has no message behind it to check it against (src/lib/pipeline/web.ts
 *    inserts `source_message_id = NULL`, and LoadDetail renders the source
 *    block only when there is one).
 *
 * 3. IT SAID AN ACCOUNT BUYS ONE THING. Two, and always has: a contact reveal,
 *    and the ability to post. `requirePosting()` needs a session. The footer
 *    and /about carried the same sentence and are corrected in the same pass.
 *
 * WHAT V13 CHANGED: the hero was five paragraphs of mechanism. It is now the
 * promise, one benefit sentence, one primary action, and a before-and-after
 * that shows the mechanism instead of describing it. Everything the old hero
 * asserted about rules, evals and geocoding providers has moved into the
 * <details> at the end, which is where a reader who wants it will look.
 *
 * WHAT DID NOT CHANGE: no metric, no testimonial, no logo wall, no customer
 * count. Every one would have to be invented today, on the marketing page of a
 * product whose whole pitch is that it does not invent. And the limitations are
 * still here -- shorter, and next to the decision they affect, per V13.
 *
 * Colour: --brand-navy, --brand-blue (via --accent) and the chip classes from
 * globals.css. The hero is the one inverted band on the site, so its text is
 * --surface (the white token) rather than a new one.
 */

/** White on --brand-navy. Named once so the hero cannot drift out of the palette. */
const ON_NAVY = "var(--surface)";

/**
 * The "before": a real batch post, and the same one /about prints.
 *
 * It ends in `[phone hidden]` and not in an invented number for the reason the
 * whole board does: no phone-shaped run belongs in a payload an anonymous
 * visitor receives, not even a fictional one.
 */
const SAMPLE_POST = `FROM KEARNY NJ:
200cf FL 33180 RFD
350 FL 33435 $3.50
2000. FL 32439 $3.75 Bulky
Marco [phone hidden]`;

/**
 * The "after", and every field in it was READ OFF THE EXTRACTOR rather than
 * written by hand: `extractInventory` on the five lines above returns exactly
 * these three jobs, with these cubic feet, these prices and these three
 * readiness states. The one that says "Ready now" is the one line that carried
 * RFD; the two that do not say "Not ready yet", because the poster marked one
 * line ready and not the others, and `readyStateOf` keeps that distinction
 * instead of rounding it up. `PRICE_NOT_PROVIDED` is imported from
 * `@/lib/loads/present` for the same reason: if the board ever changes what it
 * says about a missing price, this example changes with it.
 *
 * That is the whole claim of the page in one card, so it must not be a mock-up
 * of a board that does not behave this way.
 */
const EXTRACTED: Array<{
  route: string;
  cf: string;
  ready: { label: string; chip: string };
  price: string;
}> = [
  {
    route: "Kearny, NJ → FL 33180",
    cf: "200 cf",
    ready: { label: "Ready now", chip: "chip chip-ready" },
    price: PRICE_NOT_PROVIDED,
  },
  {
    route: "Kearny, NJ → FL 33435",
    cf: "350 cf",
    ready: { label: "Not ready yet", chip: "chip chip-muted" },
    price: "$3.50/cf",
  },
  {
    route: "Kearny, NJ → FL 32439",
    cf: "2,000 cf",
    ready: { label: "Not ready yet", chip: "chip chip-muted" },
    price: "$3.75/cf",
  },
];

/** One post, then the loads it becomes. The mechanism, shown not described. */
function BeforeAndAfter() {
  return (
    <div className="card w-full p-[var(--sp-4)] md:p-[var(--sp-5)]">
      <span className="label">One group post</span>
      <pre
        className="overflow-x-auto rounded-[var(--radius-md)] border p-[var(--sp-3)] text-(length:--fs-base) leading-relaxed"
        style={{
          background: "var(--surface-2)",
          borderColor: "var(--border)",
          color: "var(--text)",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        }}
      >
        {SAMPLE_POST}
      </pre>

      {/* The turn. An arrow rather than a word, and aria-hidden, because the
          two labels above and below already say which way round it is. */}
      <div
        className="my-[var(--sp-3)] flex items-center gap-[var(--sp-2)]"
        style={{ color: "var(--muted)" }}
      >
        <span aria-hidden="true">↓</span>
        <span className="label" style={{ marginBottom: 0 }}>
          Three loads
        </span>
      </div>

      <ul className="flex flex-col gap-[var(--sp-2)]">
        {EXTRACTED.map((job) => (
          <li
            key={job.route}
            className="rounded-[var(--radius-md)] border p-[var(--sp-3)]"
            style={{ borderColor: "var(--border)" }}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-[var(--sp-3)]">
              <span className="big text-(length:--fs-lg)">{job.route}</span>
              <span className="big text-(length:--fs-lg)">{job.cf}</span>
            </div>
            <div className="mt-[var(--sp-2)] flex flex-wrap items-center gap-[var(--sp-2)]">
              <span className={job.ready.chip}>{job.ready.label}</span>
              <span className="text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
                {job.price}
              </span>
            </div>
          </li>
        ))}
      </ul>

      <p
        className="mt-[var(--sp-4)] text-(length:--fs-base) leading-relaxed"
        style={{ color: "var(--text-2)" }}
      >
        One line of that post said the load was ready; the other two did not, so the board does not
        say it either. The poster&rsquo;s number stays behind a sign-in, and the post itself stays
        attached to all three loads.
      </p>
    </div>
  );
}

/** One of the three things this page is for, with the steps under it. */
function Action({
  index,
  title,
  who,
  steps,
  cta,
}: {
  index: string;
  title: string;
  who: string;
  steps: React.ReactNode[];
  cta: { href: string; label: string; primary?: boolean };
}) {
  return (
    <div className="card flex flex-col p-[var(--sp-5)] md:p-[var(--sp-6)]">
      <div className="flex items-center gap-[var(--sp-3)]">
        <span
          className="big flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-pill)] text-(length:--fs-md)"
          style={{ background: "var(--accent-soft)", color: "var(--accent-deep)" }}
          aria-hidden="true"
        >
          {index}
        </span>
        <h3 className="big text-(length:--fs-xl)">{title}</h3>
      </div>
      <p
        className="mt-[var(--sp-3)] text-(length:--fs-md) leading-relaxed"
        style={{ color: "var(--muted)" }}
      >
        {who}
      </p>
      <ol
        className="mt-[var(--sp-4)] flex list-decimal flex-col gap-[var(--sp-3)] pl-[var(--sp-5)] text-(length:--fs-md) leading-relaxed [&_a]:underline"
        style={{ color: "var(--text-2)" }}
      >
        {steps.map((step, i) => (
          <li key={i} className="pl-1">
            {step}
          </li>
        ))}
      </ol>
      {/* mt-auto so the cards' buttons line up even when one list is longer. */}
      <div className="mt-auto pt-[var(--sp-5)]">
        <Link className={cta.primary ? "btn btn-primary" : "btn"} href={cta.href}>
          {cta.label}
        </Link>
      </div>
    </div>
  );
}

export default async function ForMoversPage() {
  const user = await getCurrentUser();

  return (
    <AppShell user={user} active="site" currentPath="/for-movers">
      <main>
        {/* The hero. One band of brand navy, the only inverted surface on the
            site, and it stops at the fold rather than running the page. */}
        <section style={{ background: "var(--brand-navy)" }}>
          {/* Two columns only from `lg`. At 768-1023 the sample post would be a
              280 px column of monospace, which wraps every line of it. */}
          <div className="mx-auto grid w-full max-w-[1100px] items-center gap-[var(--sp-6)] px-[var(--sp-4)] pb-[var(--sp-8)] pt-[var(--sp-6)] md:pb-[calc(var(--sp-8)*1.75)] md:pt-[var(--sp-8)] lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-[var(--sp-8)]">
            <div>
              <p className="label" style={{ color: ON_NAVY, opacity: 0.62 }}>
                MoverMesh · the load board for movers
              </p>
              {/* The promise, not the tagline. "The Load Board for Movers." is
                  the CEO's line and it still opens this page -- as the eyebrow
                  above, and under the wordmark in the footer lockup. What a
                  headline has to do is different: say what the reader gets, in
                  their words, which is the route they are about to drive.

                  48/54 desktop, 32/38 mobile, straight out of review 01's type
                  table. --fs-3xl IS the 32 px step; the design system stops
                  there on purpose (see globals.css) and leaves the desktop
                  marketing size to the one page that has a marketing headline,
                  which is this one. */}
              <h1
                className="big text-(length:--fs-3xl) leading-[38px] md:text-[48px] md:leading-[54px]"
                style={{ color: ON_NAVY }}
              >
                Find moving loads that fit your route.
              </h1>
              <p
                className="mt-[var(--sp-4)] max-w-[54ch] text-(length:--fs-lg) leading-relaxed"
                style={{ color: ON_NAVY, opacity: 0.82 }}
              >
                Pickup and delivery, cubic feet and stated dates, in one board you can sort by how
                far each pickup is from where your trailer goes empty. Open the original post, then
                call the poster to confirm the details.
              </p>
              {/* ONE primary action (V13). Posting is the other thing this page
                  is for, but it is not the thing a first-time visitor should be
                  pushed at, and a second filled button would say it is. It is a
                  link in the line below, and a whole section further down. */}
              <div className="mt-[var(--sp-6)]">
                <Link className="btn btn-primary" href="/">
                  Browse loads
                </Link>
              </div>
              <p
                className="mt-[var(--sp-4)] max-w-[54ch] text-(length:--fs-base) leading-relaxed [&_a]:underline"
                style={{ color: ON_NAVY, opacity: 0.72 }}
              >
                Browsing needs no account. Sign in to see a poster&rsquo;s phone number, or to{" "}
                <Link href="/post" style={{ color: ON_NAVY }}>
                  post a listing
                </Link>{" "}
                of your own.
              </p>
            </div>
            <BeforeAndAfter />
          </div>
        </section>

        <div className="mx-auto w-full max-w-[1100px] px-[var(--sp-4)] pb-[var(--sp-8)] pt-[var(--sp-8)]">
          <h2 className="big text-(length:--fs-2xl)">What you can do here</h2>
          <p
            className="mt-[var(--sp-3)] max-w-[70ch] text-(length:--fs-md) leading-relaxed"
            style={{ color: "var(--text-2)" }}
          >
            All three are live today, and none of them needs anybody at MoverMesh to be awake.
          </p>

          <div className="mt-[var(--sp-6)] grid gap-[var(--sp-5)] lg:grid-cols-3">
            <Action
              index="1"
              title="Find work"
              who="For a driver heading home with an empty trailer, and for a dispatcher covering several trucks at once."
              steps={[
                <>
                  Say where you will be when the trailer clears. Every load is sorted by how far
                  its pickup is from there — not by when it was posted.
                </>,
                <>
                  Narrow it down: the lane, cubic feet, price per cubic foot, and how fresh the post is.
                </>,
                <>
                  Open a load for the road route, the miles and an estimated drive time, next to
                  the post it was read out of.
                </>,
                <>
                  Press <strong>Show contact</strong>, sign in, and call the poster. The deal is
                  between the two of you.
                </>,
              ]}
              cta={{ href: "/", label: "Browse loads", primary: true }}
            />

            <Action
              index="2"
              title="Offer work or space"
              who="For a company with more work than trucks, and for a driver with room on a leg that is already booked."
              steps={[
                <>
                  A <strong>load</strong>: lane, cubic feet, price and dates. Drivers hunting a
                  backhaul see it on the board and on the map.
                </>,
                <>
                  Or <strong>truck space</strong>: where you will be free, where you are headed, and
                  how much room is left. Dispatchers looking for a truck see it the same way.
                </>,
                <>
                  Anything you do not know stays blank. There is a{" "}
                  <em>not stated yet</em> answer for readiness and for price, and a blank field is
                  never filled in for you.
                </>,
                <>
                  Your number is hidden on every public copy of the listing, and shown only to a
                  signed-in account, one listing at a time, on the record.
                </>,
              ]}
              cta={{ href: "/post", label: "Post a listing" }}
            />

            <Action
              index="3"
              title="Understand the source"
              who="For anyone deciding whether the number on a card is worth acting on."
              steps={[
                <>
                  Loads arrive two ways. Most are read out of a{" "}
                  <strong>WhatsApp group post</strong>, and that post is shown on the load&rsquo;s
                  page so you can check the reading yourself.
                </>,
                <>
                  The rest are <strong>posted here directly</strong>, by the company offering them.
                  Those have no message behind them, and their pages show none.
                </>,
                <>
                  Where a post was silent, the load is silent: no price becomes{" "}
                  <em>{PRICE_NOT_PROVIDED}</em>, no ready marker becomes{" "}
                  <em>Ready date not stated</em>, and a destination given only as a state is drawn at
                  the state and labelled approximate.
                </>,
                <>
                  Every listing carries when it was last posted and whether it is still listed —{" "}
                  <Link href="/how-it-works">How it works</Link> explains what each of those means.
                </>,
              ]}
              cta={{ href: "/how-it-works", label: "How it works" }}
            />
          </div>

          {/* The limitations, kept and made short (V13). They sit here, after
              the reader has seen what the product does and before they decide
              to act on it, rather than repeated in full on three pages. */}
          <section className="mt-[var(--sp-8)] grid gap-[var(--sp-3)] lg:grid-cols-[minmax(0,220px)_minmax(0,1fr)] lg:gap-[var(--sp-6)]">
            <h2 className="big text-(length:--fs-xl)">Before you call</h2>
            <div
              className="flex max-w-[74ch] flex-col gap-[var(--sp-3)] text-(length:--fs-md) leading-relaxed [&_a]:underline"
              style={{ color: "var(--text-2)" }}
            >
              <ul className="flex list-disc flex-col gap-[var(--sp-2)] pl-[var(--sp-5)]">
                <li className="pl-1">
                  <strong style={{ color: "var(--text)" }}>Confirm availability with the poster.</strong>{" "}
                  MoverMesh does not reserve, hold or confirm a listing. The board shows you when it
                  was last posted; only the poster knows whether it has gone.
                </li>
                <li className="pl-1">
                  <strong style={{ color: "var(--text)" }}>Nobody here is vetted.</strong> Operating
                  authority, insurance and identity are not checked, and there are no badges saying
                  otherwise.
                </li>
                <li className="pl-1">
                  <strong style={{ color: "var(--text)" }}>No money moves through this site.</strong>{" "}
                  No cut, no escrow, no payment. You agree the price with the poster directly.
                </li>
              </ul>
            </div>
          </section>

          {/* V13: the implementation detail lives here, folded, for the reader
              who came looking for it. <details>, not a client component: it
              opens, closes and answers the keyboard with no JavaScript. */}
          <details className="card mt-[var(--sp-8)] p-[var(--sp-5)] md:p-[var(--sp-6)]">
            <summary className="big cursor-pointer text-(length:--fs-xl)">
              How the reading is checked
            </summary>
            <div
              className="mt-[var(--sp-4)] flex max-w-[74ch] flex-col gap-[var(--sp-3)] text-(length:--fs-md) leading-relaxed [&_a]:underline"
              style={{ color: "var(--text-2)" }}
            >
              <p>
                Group posts are read by deterministic rules — no language model, no network call, no
                guessing. The same message always produces the same loads, which is what makes the
                next two sentences possible.
              </p>
              <p>
                Six real group posts, with all 94 loads in them written out by hand, are read
                again before any change goes live. A change that drops a load, shifts a ZIP, or
                produces a load that is not in the text does not reach the board.
              </p>
              <p>
                Places are resolved through a cache, then a gazetteer of US cities and ZIP codes,
                then a geocoding service, and finally a fallback that marks the location approximate
                rather than pretending to precision. A post laid out in a shape the rules have not
                met is queued for a person instead of being forced into a guess.
              </p>
              <p>
                <Link href="/how-it-works">How it works</Link> walks the whole path, including the
                parts that fail and what happens then.
              </p>
            </div>
          </details>

          <div className="card mt-[var(--sp-8)] flex flex-col items-start gap-[var(--sp-4)] p-[var(--sp-5)] md:flex-row md:items-center md:justify-between md:p-[var(--sp-6)]">
            <div>
              <h2 className="big text-(length:--fs-xl)">The board is public. Go and look.</h2>
              <p
                className="mt-[var(--sp-2)] text-(length:--fs-md) leading-relaxed"
                style={{ color: "var(--text-2)" }}
              >
                Nothing to sign up for, nothing to install, no sales call.
              </p>
            </div>
            <Link className="btn btn-primary shrink-0" href="/">
              Browse loads
            </Link>
          </div>
        </div>
      </main>
    </AppShell>
  );
}
