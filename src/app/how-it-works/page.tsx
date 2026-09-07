import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { Note, Section, SitePage } from "@/components/SitePage";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "A WhatsApp group post becomes a job on the map: deterministic rules, the latest post wins, nothing is invented, and an unreadable format is queued for a human.",
};

/**
 * The page the product is actually sold on.
 *
 * Everything here is a claim about code that exists, and every claim is checked
 * by a gate that runs before a change ships: src/lib/pipeline/process.ts and
 * reconcile.ts for the lifecycle, src/lib/extract/* for the rules,
 * src/lib/loads/redact.ts for the masking, and npm run eval / score /
 * eval:lifecycle / check:redact for the proof. If any sentence here stops being
 * true, the sentence is the bug.
 */
export default async function HowItWorksPage() {
  const user = await getCurrentUser();

  return (
    <AppShell user={user} active="site" currentPath="/how-it-works">
      <SitePage
        eyebrow="Product"
        title="How it works"
        lead="Every job on MoverMesh started as a message in a group chat. Here is exactly what happens in between — including the parts that fail, and what happens then."
      >
        <Section title="1. A message arrives">
          <p>
            There are two ways in and one door. A connected group delivers messages through the
            WhatsApp Cloud API; an admin can also paste a message or a chat export straight into the
            console. Both call the same intake, so the demo data and live traffic take an identical
            path through the code.
          </p>
          <p>
            Intake is idempotent on the provider&rsquo;s message id. WhatsApp retries a delivery it
            did not get a prompt answer for, and a retry must not turn into a second copy of the
            same job.
          </p>
        </Section>

        <Section title="2. Rules read it, not a model">
          <p>
            Extraction is deterministic: a lexicon of moving vocabulary, a set of line patterns, and
            rules learned per sender. No language model, no API call, no per-message cost, and
            nothing in the extraction path that needs a network. The same message always produces
            the same jobs.
          </p>
          <p>That is not a purity argument. It buys three concrete things:</p>
          <ul>
            <li>
              <strong>It can be tested.</strong> The regression suite reads six real group posts and
              checks all 94 jobs they contain, field by field. A change that drops a job, shifts a
              ZIP, or produces a job that is not in the text fails before it ships.
            </li>
            <li>
              <strong>It can be explained.</strong> Every field on a job traces back to the line it
              came from, and the console shows that line highlighted next to the original message.
            </li>
            <li>
              <strong>It does not drift.</strong> A message read correctly today is read the same
              way next month. Nothing is re-interpreted behind your back.
            </li>
          </ul>
        </Section>

        <Section title="3. Nothing is invented">
          <p>
            The rules only ever report what a post says. Where a post is silent, so is the job.
          </p>
          <ul>
            <li>
              No price in the post means no price on the job. Not an estimate, not a market rate —
              nothing.
            </li>
            <li>
              A destination given only as a state is placed at the state and labelled{" "}
              <em>approximate location</em>, instead of being pinned to a plausible city.
            </li>
            <li>
              A line naming two places, where the rules cannot tell which is the destination, is
              flagged for review rather than resolved by a coin toss.
            </li>
            <li>
              A cubic-feet figure that reads as a revision of an earlier one is paired with it, not
              added as a second job.
            </li>
          </ul>
          <p>
            A board that fills in blanks is worse than a board with blanks in it. The first time a
            driver runs at a made-up address is the last time they open the app.
          </p>
        </Section>

        <Section title="4. The latest post wins">
          <p>
            A batch post is not a stream of new jobs — it is the sender&rsquo;s current inventory,
            republished. Reading it any other way leaves yesterday&rsquo;s work on the board
            forever. So:
          </p>
          <ul>
            <li>
              A job in the sender&rsquo;s newest full post is <strong>available</strong>.
            </li>
            <li>
              A job their newest full post no longer lists is <strong>delisted</strong>: still
              readable, plainly marked, not deleted. Delisted usually means it went, and that is
              worth being able to see.
            </li>
            <li>
              Two posts from the same sender inside six hours are read as one list, not as a list
              and a correction. Movers routinely finish a post in a second message.
            </li>
            <li>A repost bumps &ldquo;last seen&rdquo; instead of creating a duplicate.</li>
            <li>
              A sender who has gone quiet for four days has their jobs <strong>expired</strong>.
            </li>
            <li>
              A job someone has marked <strong>taken</strong> stays taken, even if the next post
              lists it again. A human decision outranks a re-read of the text.
            </li>
          </ul>
        </Section>

        <Section title="5. A format the rules cannot read is queued, not guessed">
          <p>
            Every message&rsquo;s line shapes are reduced to a signature. A layout that has never
            been seen puts that message in the admin queue as a new format — once, not once per
            line. A person then reads the original beside what the rules made of it and either
            confirms the reading or teaches the rule.
          </p>
          <p>
            The rule is stored against that sender, so their next post is read correctly without
            anybody editing code. Lines that keep coming back unread are counted, so the common
            failures get fixed before the rare ones.
          </p>
        </Section>

        <Section title="6. Where the map comes from">
          <p>
            A place name is resolved through a cache first, then a gazetteer of US cities and ZIP
            codes, then a geocoding service, and finally an honest fallback that marks the location
            approximate rather than pretending to precision. Resolved places are cached, so
            &ldquo;philly&rdquo; is looked up once and not once per post.
          </p>
          <p>
            The board draws every job as its two ends, pickup and delivery. Select one and the map
            draws the actual road route between them, and the job shows that route&rsquo;s miles and
            drive time. The list itself is ranked on straight-line distance, because routing fifty
            jobs to answer a question nobody has asked yet is fifty billable calls — the road number
            is worked out for the job you opened.
          </p>
        </Section>

        <Section title="7. The contact stays behind one door">
          <p>
            Everything else about a job is public: the route, the cubic feet, the price, how fresh
            the post is, the status, and the original message with every number replaced by{" "}
            <code>[phone hidden]</code>. Browsing needs no account and never will.
          </p>
          <p>
            The number itself comes from exactly one endpoint, it needs an account, and each reveal
            is recorded — which account, which job, when. A check in the build reads every public
            response back and fails if anything phone-shaped survives in it, in any format.
          </p>
          <p>
            <Link href="/privacy">Privacy</Link> sets out everything that is stored, and{" "}
            <Link href="/cookies">Cookies</Link> lists the five things that ever touch your browser.
          </p>
        </Section>

        <Note title="It still gets things wrong">
          Rules read a format they have seen. A sender who changes how they write will be misread
          until somebody notices. If a job does not match its post, send us the job and what the
          post actually said — that becomes a rule and a test case, not a one-off correction.{" "}
          <Link href="/contact" className="underline">
            Contact
          </Link>
          .
        </Note>
      </SitePage>
    </AppShell>
  );
}
