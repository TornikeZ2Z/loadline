import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { Note, Section, SitePage } from "@/components/SitePage";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Terms",
  description:
    "The rules for using MoverMesh: jobs are other people's posts, MoverMesh is not a broker, and a revealed number is for contacting that sender about that job.",
};

/**
 * Deliberately short, and deliberately unfinished in the places where only the
 * operator can finish it: the entity, the address and the governing law are
 * `[[PLACEHOLDER]]`s, not guesses. See .design/impl/legal-placeholders.md.
 */
export default async function TermsPage() {
  const user = await getCurrentUser();

  return (
    <AppShell user={user} active="site" currentPath="/terms">
      <SitePage
        eyebrow="Legal"
        title="Terms of use"
        lead="Short, because the service is small: it shows you jobs other people posted, and hands you a phone number once you have an account."
        meta={
          <>
            Last updated <strong>[[EFFECTIVE DATE]]</strong> · Operated by{" "}
            <strong>[[COMPANY LEGAL NAME]]</strong>, <strong>[[REGISTERED ADDRESS]]</strong>
          </>
        }
      >
        <Section title="1. What this service is">
          <p>
            MoverMesh is a board. It reads moving jobs out of WhatsApp group messages it has been
            given access to, and out of posts made on this site, and it shows them on a map. It is
            an index of other people&rsquo;s messages.
          </p>
          <p>
            MoverMesh is not a broker, a carrier or an agent. It does not arrange, price, insure
            or guarantee any move, takes no commission, and is not a party to whatever you and a
            sender agree.
          </p>
        </Section>

        <Section title="2. Jobs are other people's content">
          <p>
            Every job here comes from a message somebody else wrote. We do not verify that a job is
            accurate, that it is still available, that the price is real, or that the person posting
            it holds operating authority, insurance or any licence. Nor do we verify who they are.
          </p>
          <p>
            Check before you drive. If a job turns out not to exist, that is between you and whoever
            posted it. See <Link href="/how-it-works">How it works</Link> for what the board does
            and does not claim about a job.
          </p>
        </Section>

        <Section title="3. Your account">
          <p>
            Browsing needs no account. An account is one person&rsquo;s: keep the password to
            yourself, and you are responsible for what is done with it. Give a real email address —
            it is how an account is recovered and how we would reach you about it.
          </p>
        </Section>

        <Section title="4. Revealed phone numbers">
          <p>
            A number you reveal is for contacting that sender about that job. Every reveal is
            recorded against your account.
          </p>
          <p>
            Collecting numbers in bulk, automating the reveal endpoint, republishing numbers
            elsewhere, selling them, or using them for marketing unrelated to the job is not
            permitted and ends the account. This is the one rule the whole access model exists to
            protect.
          </p>
        </Section>

        <Section title="5. Posting a job">
          <p>
            Post only work you have the right to offer, and describe it accurately — the lane, the
            size, the price, the dates. Do not post anything unlawful, and do not post somebody
            else&rsquo;s job as your own. A post can be removed, and an account that repeatedly
            posts work that does not exist can be closed.
          </p>
        </Section>

        <Section title="6. Groups">
          <p>
            A WhatsApp group is connected only with the agreement of whoever administers it, and it
            is disconnected on request. A sender who does not want their posts republished here can
            say so and have them removed — see <Link href="/privacy">Privacy</Link>.
          </p>
        </Section>

        <Section title="7. Availability">
          <p>
            No uptime is promised. The service may change, be interrupted or stop. Jobs also
            disappear in normal operation: a job the sender&rsquo;s newest post no longer lists is
            delisted, and a sender who goes quiet for four days has their jobs expired. That is the
            board working, not the board failing.
          </p>
        </Section>

        <Section title="8. No warranty, and the limit of what we owe you">
          <p>
            The service is provided as it is, without warranties of any kind, to the fullest extent
            the law allows. To that same extent, <strong>[[COMPANY LEGAL NAME]]</strong> is not
            liable for lost profit, an empty trip, a job that fell through, or any decision made on
            the strength of something shown here.
          </p>
          <p>
            Nothing in these terms limits liability that cannot lawfully be limited — including for
            fraud, or for death or personal injury caused by negligence.
          </p>
        </Section>

        <Section title="9. Changes, law and contact">
          <p>
            These terms can change; the date at the top changes with them. They are governed by{" "}
            <strong>[[GOVERNING LAW]]</strong>, and disputes go to the courts of{" "}
            <strong>[[GOVERNING LAW]]</strong>. Write to <strong>[[SUPPORT EMAIL]]</strong>;{" "}
            <Link href="/contact">Contact</Link> says what to include.
          </p>
        </Section>

        <Note tone="warn" title="This is a draft">
          The bracketed details are not filled in, and this text has not been reviewed by a lawyer.
          It should not be relied on as it stands.
        </Note>
      </SitePage>
    </AppShell>
  );
}
