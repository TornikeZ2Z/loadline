import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { Note, Section, SitePage } from "@/components/SitePage";
import { reportProblemHref } from "@/lib/support";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "About",
  description:
    "MoverMesh is a backhaul board for long-distance movers, built from the WhatsApp groups where the loads are already posted.",
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
        lead="A backhaul board for long-distance movers. The loads are already being posted — in WhatsApp groups, as blocks of text nobody can search. MoverMesh reads them and puts them on a map."
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
            That is how the message reads on the board: the last line carried the poster&rsquo;s
            number, and every public copy has it masked.
          </p>
          <p>
            One origin, then a line per destination: state, ZIP, cubic feet, sometimes a price.
            Fifteen posters putting up fifteen batches a day is a wall of text, and the load you wanted
            scrolled past an hour ago. You cannot sort it by what is near you. You cannot see that
            three of this morning&rsquo;s loads are all going to the same corner of Florida.
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
              by price per cubic foot, by stated readiness — across every group at once, instead of
              scrolling each one.
            </li>
            <li>
              <strong>A company with more work than trucks.</strong> A batch posted in one group is
              seen by that group. Here it is a route on a map, with the original message attached.
            </li>
            <li>
              <strong>A driver with room on a leg that is already booked.</strong> Truck space is a
              listing of its own, posted from the same account and searched the same way.
            </li>
          </ul>
        </Section>

        {/* L05. This section used to describe one path and call it "how a job
            gets here", on a board that has had two since the truck-space and
            direct-posting work shipped. The two are not interchangeable and the
            difference is exactly what a reader of an About page is trying to
            weigh: one has a message behind it that you can read yourself, and
            one has the poster's word for it. */}
        <Section title="How a listing gets here">
          <p>Two ways, and the board keeps them apart.</p>
          <p>
            <strong>Read out of a group post.</strong> A group is connected — through the WhatsApp
            Cloud API, or by an admin pasting messages in, both through the same intake. The message
            is stored once, exactly as it arrived. Deterministic rules pull the loads out of that
            copy; the places are resolved to coordinates; the load is drawn pickup to delivery. The
            poster&rsquo;s newest post is treated as their current list, so a load it no longer
            carries is marked delisted rather than quietly disappearing. The post itself stays on the
            load&rsquo;s page, so you can check the reading.
          </p>
          <p>
            <strong>Posted here directly.</strong> A company with a load, or a driver with space,
            fills in a form on this site. Nothing has to be read out of anything, so nothing can be
            misread — but there is also no original message to check it against, and the
            load&rsquo;s page shows none.
          </p>
          <p>
            <Link href="/how-it-works">How it works</Link> goes through each of those steps,
            including the parts that fail.
          </p>
        </Section>

        {/* L05. "One thing: the sender's phone number" was the sentence the
            footer and /for-movers carried too, and it was already wrong when
            posting arrived: `requirePosting()` needs a session. Two things. */}
        <Section title="What an account is for">
          <p>
            Two things. <strong>Seeing a phone number</strong>, and <strong>posting a listing</strong>
            . Everything else — browsing the board, filtering it, opening a load and reading the
            message it came from — is public and needs no account.
          </p>
          <p>
            Phone numbers are stripped out of every public response; the original text shows{" "}
            <code>[phone hidden]</code> where a number stood. Press <strong>Show contact</strong> on
            a load and sign in, and the number arrives from a single endpoint that records the
            reveal.
          </p>
          <p>
            Posting is open to any signed-in account, for either kind of listing. The word you pick
            when you register — driver or poster — records which door you came in through, not what
            you may do.
          </p>
        </Section>

        <Section title="What MoverMesh is not">
          <ul>
            <li>
              <strong>Not a broker.</strong> No cut, no escrow, nobody between you and the poster.
            </li>
            <li>
              <strong>Not a vetting service.</strong> Operating authority, insurance and identity are
              not checked, here or anywhere on this site.
            </li>
            <li>
              <strong>Not a writer of listings.</strong> Nothing is inferred to fill a gap, and a gap
              is shown as a gap.
            </li>
          </ul>
        </Section>

        <Note title="A listing on the board looks wrong?">
          That is worth telling us, and it is the most useful message we get. A misreading is a bug
          in a rule, so it gets fixed once and stays fixed for every post in that format. Send the
          listing&rsquo;s link and what the post actually said.{" "}
          <Link href={reportProblemHref()} className="underline">
            Report a problem
          </Link>
          .
        </Note>
      </SitePage>
    </AppShell>
  );
}
