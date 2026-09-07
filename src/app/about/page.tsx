import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { Note, Section, SitePage } from "@/components/SitePage";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "About",
  description:
    "MoverMesh is a backhaul board for long-distance movers, built from the WhatsApp groups where the jobs are already posted.",
};

/**
 * The shape of a real batch post.
 *
 * The sender's line ends in `[phone hidden]` and not in an invented number, for
 * the same reason the board does it: no phone-shaped run belongs in a payload
 * an anonymous visitor receives, not even a fictional one. It also shows the
 * reader exactly what the public copy of a message looks like.
 */
const SAMPLE_POST = `FROM KEARNY NJ:
200cf FL 33180 RFD
350 FL 33435 $3.50
2000. FL 32439 $3.75 Bulky
Marco [phone hidden]`;

export default async function AboutPage() {
  const user = await getCurrentUser();

  return (
    <AppShell user={user} active="site" currentPath="/about">
      <SitePage
        eyebrow="Company"
        title="About MoverMesh"
        lead="A backhaul board for long-distance movers. The jobs are already being posted — in WhatsApp groups, as blocks of text nobody can search. MoverMesh reads them and puts them on a map."
      >
        <Section title="The empty half of the trip">
          <p>
            Long-distance moving runs on empty miles. A truck delivers twelve hundred miles from
            home and the trailer comes back with air in it. The work that would fill it exists: it
            is posted every morning, in group chats, in batches that look like this.
          </p>
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
          <p className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
            That is how the message reads on the board: the last line carried the sender&rsquo;s
            number, and every public copy has it masked.
          </p>
          <p>
            One origin, then a line per destination: state, ZIP, cubic feet, sometimes a price.
            Fifteen senders posting fifteen batches a day is a wall of text, and the job you wanted
            scrolled past an hour ago. You cannot sort it by what is near you. You cannot see that
            three of this morning&rsquo;s jobs are all going to the same corner of Florida.
          </p>
        </Section>

        <Section title="Who it is for">
          <ul>
            <li>
              <strong>A mover about to drive home empty.</strong> Say where you will be when the
              trailer clears, and the board sorts by how far the pickup is from there.
            </li>
            <li>
              <strong>A dispatcher covering several trucks.</strong> Filter by lane, by cubic feet,
              by price per cubic foot, by when it is ready — across every group at once, instead of
              scrolling each one.
            </li>
            <li>
              <strong>A company with more work than trucks.</strong> A batch posted in one group is
              seen by that group. Here it is a route on a map, with the original message attached.
            </li>
          </ul>
        </Section>

        <Section title="How a job gets here">
          <ol>
            <li>
              A group is connected — through the WhatsApp Cloud API, or by an admin pasting messages
              in. Both go through the same intake.
            </li>
            <li>The message is stored once, exactly as it arrived, and read only from that copy.</li>
            <li>
              Deterministic rules pull the jobs out of it. Not a language model — the same message
              always produces the same jobs.
            </li>
            <li>
              The places are resolved to coordinates, and the job is drawn pickup to delivery.
            </li>
            <li>
              The sender&rsquo;s newest post is treated as their current list. Jobs it no longer
              carries are marked delisted rather than quietly disappearing.
            </li>
          </ol>
          <p>
            <Link href="/how-it-works">How it works</Link> goes through each of those steps,
            including the parts that fail.
          </p>
        </Section>

        <Section title="What an account buys">
          <p>
            One thing: the sender&rsquo;s phone number. Browsing the board, filtering it, opening a
            job and reading the message it came from are all public and need no account. Phone
            numbers are stripped out of every public response — the original text shows{" "}
            <code>[phone hidden]</code> where a number stood. Press <strong>Show contact</strong> on
            a job and sign in, and the number arrives from a single endpoint that records the
            reveal.
          </p>
        </Section>

        <Section title="What MoverMesh is not">
          <ul>
            <li>
              <strong>Not a broker.</strong> No cut, no escrow, nobody standing between you and the
              sender. You call them and the deal is yours.
            </li>
            <li>
              <strong>Not a vetting service.</strong> We do not check anyone&rsquo;s operating
              authority, insurance or reputation. A job here is a message somebody posted in a group
              chat, no more verified than it was there.
            </li>
            <li>
              <strong>Not a writer of jobs.</strong> Every field on the board came out of a message.
              Nothing is inferred to fill a gap, and a gap is shown as a gap.
            </li>
          </ul>
        </Section>

        <Note title="A job on the board looks wrong?">
          That is worth telling us, and it is the most useful message we get. A misreading is a bug
          in a rule, so it gets fixed once and stays fixed for every post in that format.{" "}
          <Link href="/contact" className="underline">
            How to reach us
          </Link>
          .
        </Note>
      </SitePage>
    </AppShell>
  );
}
