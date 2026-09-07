import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { LOGO_TAGLINE } from "@/components/Logo";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "For movers",
  description:
    "What you can actually do on MoverMesh: find a backhaul load sorted by distance from where your trailer goes empty, and post the work you cannot cover yourself.",
};

/**
 * The marketing page.
 *
 * Three decisions worth writing down, because each one was a real choice:
 *
 * 1. IT IS A SIBLING ROUTE, NOT A NEW HOME PAGE. The board is the front door
 *    and that is a decision recorded at src/app/page.tsx:6-12 -- a mover who is
 *    sent a link opens the map, not a pitch. This page is for the visitor who
 *    arrived without a link and wants to know what the thing is for.
 *
 * 2. IT ADVERTISES TWO ACTIONS, NOT THREE. The brief names three -- post a
 *    load, find a load, offer truck space. The third does not exist: there is
 *    no capacity listing type, no second table, no `kind` column, and the
 *    extractor deliberately discards "have room" / "going empty" lines as
 *    chatter (src/lib/extract/lines.ts). Advertising it would be a fabricated
 *    feature on the marketing page of a product whose entire selling point is
 *    that it does not fabricate. It is named below as a thing we do NOT do,
 *    with no date attached, because a reader who has heard the idea elsewhere
 *    deserves an answer rather than a silence.
 *
 * 3. NO NUMBERS THAT ARE NOT LOAD-BEARING. No customer count, no testimonial,
 *    no logo wall, no "X loads posted daily". Every one of those would have to
 *    be invented today. The page carries no metric at all rather than a soft
 *    one, and every capability sentence below describes shipped code.
 *
 * Colour: --brand-navy, --brand-blue (via --accent) and --brand-green, all from
 * globals.css. The hero is the one inverted band on the site, so its text is
 * --surface (the white token) rather than a new one.
 */

/** White on --brand-navy. Named once so the hero cannot drift out of the palette. */
const ON_NAVY = "var(--surface)";

/**
 * A real batch post, and the same one /about prints — one origin line, three
 * destination lines, a sender.
 *
 * It ends in `[phone hidden]` and not in an invented number for the reason the
 * whole board does: no phone-shaped run belongs in a payload an anonymous
 * visitor receives, not even a fictional one. It doubles as a demonstration:
 * this is exactly what the public copy of a message looks like.
 */
const SAMPLE_POST = `FROM KEARNY NJ:
200cf FL 33180 RFD
350 FL 33435 $3.50
2000. FL 32439 $3.75 Bulky
Marco [phone hidden]`;

/**
 * The hero's right half: the input, shown rather than described.
 *
 * There is no "after" mock-up beside it and that is deliberate — a drawn
 * screenshot of a board is a picture somebody made up, and the real board is
 * one click away on the button to its left. The count under it is not a metric
 * either: three destination lines are three destination lines, countable in the
 * block above by anyone who doubts it.
 */
function SamplePost() {
  return (
    <div className="card w-full p-[var(--sp-4)] md:p-[var(--sp-5)]">
      <span className="label">What a group post looks like</span>
      <pre
        className="overflow-x-auto rounded-[var(--radius-md)] border p-[var(--sp-4)] text-(length:--fs-base) leading-relaxed"
        style={{
          background: "var(--surface-2)",
          borderColor: "var(--border)",
          color: "var(--text)",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        }}
      >
        {SAMPLE_POST}
      </pre>
      <p
        className="mt-[var(--sp-4)] text-(length:--fs-base) leading-relaxed"
        style={{ color: "var(--text-2)" }}
      >
        One origin, three destination lines, one sender. MoverMesh reads that as{" "}
        <strong style={{ color: "var(--text)" }}>three jobs</strong> — each drawn Kearny to its own
        corner of Florida, with its cubic feet and its price per cubic foot — and keeps the
        sender&rsquo;s number behind a sign-in. Nothing that is not in those five lines ends up on
        the board.
      </p>
    </div>
  );
}

function HeroLine({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="mt-[var(--sp-4)] max-w-[58ch] text-(length:--fs-lg) leading-relaxed"
      style={{ color: ON_NAVY, opacity: 0.82 }}
    >
      {children}
    </p>
  );
}

/** One of the two things a visitor can actually do, as a card with its steps. */
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
  cta: { href: string; label: string };
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
        className="mt-[var(--sp-4)] flex list-decimal flex-col gap-[var(--sp-3)] pl-[var(--sp-5)] text-(length:--fs-md) leading-relaxed"
        style={{ color: "var(--text-2)" }}
      >
        {steps.map((step, i) => (
          <li key={i} className="pl-1">
            {step}
          </li>
        ))}
      </ol>
      {/* mt-auto so the two cards' buttons line up even when one list is longer. */}
      <div className="mt-auto pt-[var(--sp-5)]">
        <Link className="btn btn-primary" href={cta.href}>
          {cta.label}
        </Link>
      </div>
    </div>
  );
}

function Block({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  /* The heading moves into a left rail from `lg`, and the prose is capped at a
     reading measure beside it. Left uncapped, these paragraphs ran the full
     1100 px container -- about 150 characters a line at 1440, twice what anyone
     reads comfortably -- and capped without the rail they left the right half of
     a wide screen empty. Below `lg` the two simply stack, which is the shape
     every other content page on the site already has. */
  return (
    <section className="grid gap-[var(--sp-3)] lg:grid-cols-[minmax(0,220px)_minmax(0,1fr)] lg:gap-[var(--sp-6)]">
      <h2 className="big text-(length:--fs-xl)">{title}</h2>
      <div
        className="flex max-w-[74ch] flex-col gap-[var(--sp-3)] text-(length:--fs-md) leading-relaxed [&_a]:underline"
        style={{ color: "var(--text-2)" }}
      >
        {children}
      </div>
    </section>
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
              MoverMesh
            </p>
            {/* The tagline is the headline. It is the CEO's line, it is already
                the one under the wordmark in the footer, and repeating it here
                verbatim is what makes it a tagline rather than a caption. */}
            <h1
              className="big text-(length:--fs-3xl) md:text-[40px]"
              style={{ color: ON_NAVY }}
            >
              {LOGO_TAGLINE}
            </h1>
            <HeroLine>
              Long-distance moving runs on empty miles. The work that would fill them is already
              being posted — in WhatsApp groups, as blocks of text nobody can search, sort or map.
            </HeroLine>
            <HeroLine>
              MoverMesh reads those posts with rules, draws every job pickup-to-delivery, and orders
              the board by how far each pickup is from where your trailer goes empty.
            </HeroLine>
            <div className="mt-[var(--sp-6)] flex flex-wrap items-center gap-[var(--sp-3)]">
              <Link className="btn btn-primary" href="/">
                Browse the board
              </Link>
              {/* The chooser, not the job form: this page's reader is as
                  likely to be a driver with an empty leg as a poster with
                  freight, and naming one would tell the other they are not
                  invited. */}
              <Link className="btn" href="/post">
                Post to the board
              </Link>
            </div>
            <p
              className="mt-[var(--sp-4)] text-(length:--fs-base)"
              style={{ color: ON_NAVY, opacity: 0.72 }}
            >
              Browsing is public and needs no account. An account buys one thing: a sender&rsquo;s
              phone number.
            </p>
            </div>
            <SamplePost />
          </div>
        </section>

        <div className="mx-auto w-full max-w-[1100px] px-[var(--sp-4)] pb-[var(--sp-8)] pt-[var(--sp-8)]">
          <h2 className="big text-(length:--fs-2xl)">Two things you can do here</h2>
          <p
            className="mt-[var(--sp-3)] max-w-[70ch] text-(length:--fs-md) leading-relaxed"
            style={{ color: "var(--text-2)" }}
          >
            Both of them are live today. Neither of them needs anybody at MoverMesh to be awake.
          </p>

          <div className="mt-[var(--sp-6)] grid gap-[var(--sp-5)] md:grid-cols-2">
            <Action
              index="1"
              title="Find a load"
              who="For a driver heading home with an empty trailer, and for a dispatcher covering several trucks at once."
              steps={[
                <>
                  Say where you will be when the trailer clears. Every job is sorted by how far its
                  pickup is from there — not by when it was posted.
                </>,
                <>
                  Narrow it down: the lane, cubic feet, price per cubic foot, how recently the sender
                  posted it.
                </>,
                <>
                  Open a job for the road route, the miles and the drive time, plus the original
                  group message it was read out of.
                </>,
                <>
                  Press <strong>Show contact</strong>, sign in, and call the sender. The deal is
                  between the two of you.
                </>,
              ]}
              cta={{ href: "/", label: "Browse the board" }}
            />

            <Action
              index="2"
              title="Post a load"
              who="For a company with more work than trucks, and for anyone already posting batches into a group."
              steps={[
                <>
                  Post a job straight from this site with a poster account: lane, cubic feet, price,
                  dates.
                </>,
                <>
                  Or connect the WhatsApp group you already post in — with the agreement of whoever
                  administers it. What you post there lands on the board.
                </>,
                <>
                  Repost as usual. Your newest batch is read as your current list, so a job you drop
                  from it is marked delisted instead of sitting there forever.
                </>,
                <>
                  Your number is stripped out of every public copy of the post, and shown only to a
                  signed-in account, one job at a time, on the record.
                </>,
              ]}
              /* This block is about a SENDER's freight -- reposting a batch,
                 having their number stripped out of it -- so the word still
                 means a shipment and the link goes straight to the job form. */
              cta={{ href: "/post/job", label: "Post a job" }}
            />
          </div>

          <div className="mt-[var(--sp-8)] flex flex-col gap-[var(--sp-8)]">
            <Block title="Where the jobs come from">
              <p>
                Every job on the board started as somebody&rsquo;s message in a group chat.
                Deterministic rules read those messages — no language model, no network call, no
                guessing. The same message always produces the same jobs.
              </p>
              <p>
                Where a post is silent, the job is silent. No price in the post means no price on the
                job — not an estimate, not a market rate. A destination given only as a state is
                shown at the state and labelled approximate, rather than pinned to a plausible city.
                A board that fills in blanks is worse than a board with blanks in it.
              </p>
              <p>
                <Link href="/how-it-works">How it works</Link> walks through the whole path,
                including the parts that fail and what happens then.
              </p>
            </Block>

            <Block title="What MoverMesh does not do">
              <ul className="flex list-disc flex-col gap-[var(--sp-2)] pl-[var(--sp-5)]">
                <li className="pl-1">
                  <strong style={{ color: "var(--text)" }}>It does not broker.</strong> No cut, no
                  escrow, no payment of any kind through this site, and nobody standing between you
                  and the sender.
                </li>
                <li className="pl-1">
                  <strong style={{ color: "var(--text)" }}>It does not vet anyone.</strong> Operating
                  authority, insurance and reputation are not checked, and there are no badges saying
                  otherwise. A job here is exactly as verified as it was in the group chat it came
                  from.
                </li>
                <li className="pl-1">
                  <strong style={{ color: "var(--text)" }}>
                    It does not hold or confirm a job.
                  </strong>{" "}
                  Only the sender knows whether this morning&rsquo;s load is still going. The board
                  shows you when they last posted it; you ask them the rest.
                </li>
              </ul>
              <p>
                None of that is modesty. It is the whole product: the board is worth opening because
                what it shows you came out of a real message and nothing was added on the way.
              </p>
            </Block>

            {/* The one feature people ask about that does not exist. Named, not
                promised, and with no date -- see decision 2 at the top of this file. */}
            <Block title="Not here yet: offering truck space">
              <p>
                The obvious other half of a backhaul board is the reverse listing — the empty space
                in a truck that is already rolling, offered to whoever has something to move. It is a
                fair thing to want and it is not what MoverMesh does today.
              </p>
              <p>
                Today the board runs in one direction: jobs that need a truck, and the drivers and
                dispatchers looking for one to fill. If you are here for the other direction, this
                page would rather tell you now than sell it to you.
              </p>
            </Block>
          </div>

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
              Browse the board
            </Link>
          </div>
        </div>
      </main>
    </AppShell>
  );
}
