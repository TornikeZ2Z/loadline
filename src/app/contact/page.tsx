import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { Note, Section, SitePage } from "@/components/SitePage";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Who to write to about a job, a misreading, adding a WhatsApp group, or taking a sender's posts off the board.",
};

/**
 * No contact form: a form would need somewhere to post to, and there is no
 * inbox in this codebase to post it to. An address the operator fills in once
 * is honest; a form that silently drops messages is not.
 *
 * `[[SUPPORT EMAIL]]` and the entity details are placeholders on purpose --
 * see .design/impl/legal-placeholders.md.
 */
export default async function ContactPage() {
  const user = await getCurrentUser();

  return (
    <AppShell user={user} active="site" currentPath="/contact">
      <SitePage
        eyebrow="Company"
        title="Contact"
        lead="There is no call centre here, and no contact form that quietly goes nowhere. This is what to do, depending on what you need."
        meta={
          <>
            Write to <strong>[[SUPPORT EMAIL]]</strong>. We do not promise a response time, so we
            are not going to print one.
          </>
        }
      >
        <Section title="About a job on the board">
          <p>
            Do not write to us — write to the sender. The number behind{" "}
            <strong>Show contact</strong> is theirs, the job is theirs, and the deal is between the
            two of you. We are not the seller. We cannot hold a job, negotiate a price, or confirm
            that something posted this morning is still going.
          </p>
          <p>
            What the board can tell you without asking anyone: the status on the job, and when the
            sender was last seen posting it.
          </p>
        </Section>

        <Section title="A job here does not match the post">
          <p>
            This is the most useful message we get. Send the job&rsquo;s link and what the original
            message actually said. A misreading is a bug in a rule, so it gets a test case and a
            fix, and the fix covers every future post in that format instead of just that one job.
          </p>
        </Section>

        <Section title="Getting a group onto the board">
          <p>
            Groups are connected by an admin, with the agreement of whoever runs the group. Tell us
            which group it is and who administers it.
          </p>
          <p>
            To be plain about what that means: MoverMesh reads the messages that are already
            visible to that group&rsquo;s members, and republishes the jobs in them with the phone
            numbers hidden. It does not join a group without the group&rsquo;s admin knowing.
          </p>
        </Section>

        <Section title="Posting a job without a group">
          <p>
            A poster account can put a job on the board directly, from{" "}
            <Link href="/post">Post a job</Link>. If you do not have one, say so and say what you
            move.
          </p>
        </Section>

        <Section title="Taking your posts down">
          <p>
            If you are a sender and you want your posts off the board, tell us which group and which
            sender you are. We remove the stored messages and every job derived from them. Say so
            plainly in the message — it is a request we act on, not one we argue with.
          </p>
        </Section>

        <Section title="Legal, press and everything else">
          <p>
            MoverMesh is operated by <strong>[[COMPANY LEGAL NAME]]</strong>,{" "}
            <strong>[[REGISTERED ADDRESS]]</strong>. Legal notices go to{" "}
            <strong>[[SUPPORT EMAIL]]</strong>. See <Link href="/terms">Terms</Link> and{" "}
            <Link href="/privacy">Privacy</Link>.
          </p>
        </Section>

        <Note tone="warn" title="Never send a password">
          Nobody here will ever ask you for your password, and no message from us will ask you to
          confirm an account by replying with one.
        </Note>
      </SitePage>
    </AppShell>
  );
}
