import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { Note, Section, SitePage } from "@/components/SitePage";
import { readSiteSettings, settingText } from "@/lib/settings";
import { REPORT_ABOUT_PARAM, REPORT_SECTION_ID, isReportableJobPath } from "@/lib/support";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Where to report a job that does not match its post, how to get a WhatsApp group on the board, and how to have a sender's posts removed.",
};

/**
 * The one route to a human, and the destination of every "Report a problem"
 * link on the site (see src/lib/support.ts for the contract).
 *
 * NO CONTACT FORM, and that is not laziness: a form needs an inbox to post to,
 * and there is no inbox in this codebase. A form that silently drops messages
 * is worse than an address, because the sender believes they have been heard.
 *
 * The support address and the entity details come out of the settings store,
 * and render as `[[PLACEHOLDER]]`s until an admin fills them in at
 * /admin/settings -- never as a guess and never as nothing. See
 * src/lib/settings.ts and .design/impl/legal-placeholders.md. They are the ONLY
 * thing missing from the reporting path: the route, the anchor, the job
 * reference and the "what to include" list all work today, so the mailbox is a
 * form field rather than a build.
 */
export default async function ContactPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getCurrentUser();

  /**
   * The job a report is about, when the visitor arrived from one.
   *
   * This is a query parameter, so it is whatever the last person to write a URL
   * decided it should be. `isReportableJobPath` accepts a job path on this site
   * and nothing else, so the line below can never be used to put a stranger's
   * sentence -- or a link somewhere else -- on a page a reader is trusting.
   */
  const sp = await searchParams;
  const raw = sp[REPORT_ABOUT_PARAM];
  const about = isReportableJobPath(raw) ? raw : null;

  const settings = await readSiteSettings();
  const email = settingText(settings, "support_email");

  return (
    <AppShell user={user} active="site" currentPath="/contact">
      <SitePage
        eyebrow="Company"
        title="Contact"
        lead="Most questions about a job belong to the sender rather than to us. Here is what to do with everything else, and what to include so it can actually be acted on."
        meta={
          <>
            One address for all of it: <strong>{email}</strong>. Jump to{" "}
            <Link href={`#${REPORT_SECTION_ID}`}>report a problem with a job</Link>.
          </>
        }
      >
        <Section title="Report a problem with a job" id={REPORT_SECTION_ID}>
          {/* Only ever a job path on this site; see the note above. Rendered as
              a link because the first thing the reader has to do is copy it. */}
          {about ? (
            <div
              className="rounded-[var(--radius-md)] border p-[var(--sp-4)]"
              style={{ background: "var(--accent-soft)", borderColor: "var(--accent-soft)" }}
            >
              <span className="label">The job you came from</span>
              <Link href={about} className="font-semibold">
                {about}
              </Link>
            </div>
          ) : null}
          <p>
            A job that does not match the message it came from is the most useful thing you can
            send us. A misreading is a bug in a rule: it gets a test case and a fix, and the fix
            covers every future post in that format instead of that one job.
          </p>
          <p>
            Write to <strong>{email}</strong> with three things:
          </p>
          <ul>
            <li>
              <strong>The link to the job.</strong> Every job has its own page — copy the address
              out of the bar, or use the link above if you arrived here from one.
            </li>
            <li>
              <strong>What the original post actually said.</strong> The job page shows the message
              it was read out of, with the phone number masked; quoting the line is enough.
            </li>
            <li>
              <strong>What is wrong with it</strong> — the wrong ZIP, a missing destination, a size
              that belongs to the job above it, a price that was never in the text.
            </li>
          </ul>
          <p>
            Reports about the same format get fixed together, so the shapes that misread most often
            are the ones that get fixed first.
          </p>
        </Section>

        <Section title="Is a job still going?">
          <p>
            Ask the sender. The number behind <strong>Show contact</strong> is theirs, the job is
            theirs, and only they know whether this morning&rsquo;s load has already gone. We are
            not the seller: we cannot hold a job, move a price, or confirm that something is still
            available.
          </p>
          <p>What the board can tell you before you call:</p>
          <ul>
            <li>
              The status on the job — available, delisted, expired or taken — and what each of those
              means on <Link href="/how-it-works">How it works</Link>.
            </li>
            <li>When the sender was last seen posting it.</li>
          </ul>
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
            MoverMesh is operated by{" "}
            <strong>{settingText(settings, "company_legal_name")}</strong>,{" "}
            <strong>{settingText(settings, "registered_address")}</strong>. Legal notices go to{" "}
            <strong>{email}</strong>. See <Link href="/terms">Terms</Link> and{" "}
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
