import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { Note, Section, SitePage } from "@/components/SitePage";
import { reportProblemHref } from "@/lib/support";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "Search, inspect, contact, confirm — and behind that, how a WhatsApp group post becomes a job on the map without anything being invented along the way.",
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
 *
 * WRITTEN FOR A CUSTOMER, and that took an edit rather than a rewrite. The page
 * used to open on the pipeline, which answers a question nobody had asked yet:
 * a dispatcher wants to know what THEY do here before they care how the sausage
 * is made. "Using the board" now comes first and walks the four steps -- search,
 * inspect, contact, confirm -- and the numbered sections after it are the
 * provenance story, which is the reason to trust what step 1 shows you.
 *
 * What was taken out: the words "regression suite", "signature" and "line
 * shapes", and the billing detail behind the routing decision. All three are
 * true, but they describe the implementation, and they belong in README.md,
 * which has them. What stayed: the six posts and the 94 jobs (a checkable
 * fact, not a mechanism), and every sentence about what the rules cannot do.
 * The honesty on this page is the selling point; it is not the part to trim.
 */
export default async function HowItWorksPage() {
  const user = await getCurrentUser();

  return (
    <AppShell user={user} active="site" currentPath="/how-it-works">
      <SitePage
        eyebrow="Product"
        title="How it works"
        lead="Four steps to find a load and reach the person offering it — and then, in detail, how a message in a group chat becomes a job on the map, including the parts that fail."
      >
        <Section title="Using the board">
          <p>
            Nothing in the first two steps needs an account, and none of it needs anybody at
            MoverMesh to be awake.
          </p>
          <ol>
            <li>
              <strong>Search.</strong> Say where you will be when your trailer goes empty. The board
              orders every job by how far its pickup is from there, and you can narrow it by lane,
              by cubic feet, by price per cubic foot, and by how recently the sender posted it.
            </li>
            <li>
              <strong>Inspect the details.</strong> Open a job for the road route between its two
              ends, the miles and the drive time, the size, and the price if the post carried one —
              next to the original group message it was read out of, so you can check the reading
              yourself.
            </li>
            <li>
              <strong>Contact the poster.</strong> Press <strong>Show contact</strong> and sign in.
              The number is the one the sender wrote in their own post. The deal is between the two
              of you: MoverMesh is not in it and takes nothing from it.
            </li>
            <li>
              <strong>Confirm it is still going.</strong> Ask them. The board shows you the job&rsquo;s
              status and when the sender last posted it, but only the sender knows whether this
              morning&rsquo;s load has already gone. Nothing here reserves or holds a job.
            </li>
          </ol>
          <p>
            The rest of this page is what happens before step 1 — how a job gets onto the board at
            all, and why you can trust what it says.
          </p>
        </Section>

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
            The jobs are read by rules that were written down, not by a language model. Nothing
            about a post is guessed, nothing is sent away to be interpreted, and nothing is read a
            second way on a second day. The same message always produces the same jobs.
          </p>
          <p>That is not a purity argument. It buys three concrete things:</p>
          <ul>
            <li>
              <strong>It can be checked.</strong> Six real group posts, with all 94 jobs in them
              written out by hand, are read again before any change goes live. A change that drops a
              job, shifts a ZIP, or produces a job that is not in the text does not reach the board.
            </li>
            <li>
              <strong>It can be explained.</strong> Every field on a job traces back to the line of
              the post it came from — and the job page shows you that post, so the reading is yours
              to check rather than ours to assert.
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
            A post laid out in a way the rules have not met before is set aside for a person instead
            of being forced into a guess — once for the whole message, not once per line. Somebody
            reads the original next to what the rules made of it, and either confirms the reading or
            corrects it.
          </p>
          <p>
            The correction is remembered against that sender, so their next post in the same shape
            is read properly. The layouts that fail most often are the ones that get fixed first.
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
            drive time. The list itself is ranked on straight-line distance, because working out
            road routes for fifty jobs to answer a question nobody has asked yet would make the
            board slow for everyone — the road number is worked out for the job you opened.
          </p>
        </Section>

        <Section title="7. The contact stays behind one door">
          <p>
            Everything else about a job is public: the route, the cubic feet, the price, how fresh
            the post is, the status, and the original message with every number replaced by{" "}
            <code>[phone hidden]</code>. Browsing needs no account and never will.
          </p>
          <p>
            The number itself is handed out in one place only, it needs an account, and each reveal
            is recorded — which account, which job, when. Nothing goes live until every public
            response has been read back and checked that no number survived in it, in any format.
          </p>
          <p>
            <Link href="/privacy">Privacy</Link> sets out everything that is stored, and{" "}
            <Link href="/cookies">Cookies</Link> lists the five things that ever touch your browser.
          </p>
        </Section>

        <Note title="It still gets things wrong">
          Rules read a format they have seen. A sender who changes how they write will be misread
          until somebody notices, and the somebody is usually a driver. If a job does not match its
          post, send us the job&rsquo;s link and what the post actually said — that becomes a rule
          and a test case, not a one-off correction.{" "}
          <Link href={reportProblemHref()} className="underline">
            Report a problem
          </Link>
          .
        </Note>
      </SitePage>
    </AppShell>
  );
}
