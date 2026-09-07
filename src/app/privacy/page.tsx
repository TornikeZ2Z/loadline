import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { Note, Section, SitePage } from "@/components/SitePage";
import { readSiteSettings, settingText } from "@/lib/settings";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "What MoverMesh stores: the group messages jobs are derived from, what the rules pull out of them, account details for the few who sign in, and contact reveals. Your location stays in your browser.",
};

/**
 * Written from the schema and the code, not from a template.
 *
 * Every claim below is checkable: db/schema.sql for what is stored,
 * src/lib/auth.ts for the account fields and the cookie, src/lib/location.ts
 * for the location staying client-side, src/lib/loads/redact.ts for the
 * masking, src/lib/geo/here.ts for the one third party the server talks to.
 *
 * What this page deliberately does NOT say: that we comply with any particular
 * regime, that we hold a certification, or that data is deleted on a schedule.
 * The code implements none of those, and a privacy page that overstates is
 * worse than no privacy page.
 */
export default async function PrivacyPage() {
  const user = await getCurrentUser();
  const settings = await readSiteSettings();
  const company = settingText(settings, "company_legal_name");
  const email = settingText(settings, "support_email");

  return (
    <AppShell user={user} active="site" currentPath="/privacy">
      <SitePage
        eyebrow="Legal"
        title="Privacy"
        lead="What this site holds, why it holds it, and who else sees anything. Written from the database schema rather than from a template, so it can be checked."
        meta={
          <>
            Last updated <strong>{settingText(settings, "effective_date")}</strong> · Operated by{" "}
            <strong>{company}</strong> · Questions to{" "}
            <strong>{email}</strong>
          </>
        }
      >
        <Section title="The short version">
          <ul>
            <li>
              One cookie, set only when you sign in. No analytics, no advertising, no third-party
              trackers.
            </li>
            <li>The location you pick stays in your browser. It is never written to our database.</li>
            <li>
              Phone numbers are removed from everything an anonymous visitor can see, and revealed
              only to a signed-in account, one job at a time, on the record.
            </li>
            <li>Nothing here is sold, rented, or handed to an advertiser.</li>
          </ul>
        </Section>

        <Section title="What is stored">
          <p>
            <strong>Messages from connected groups.</strong> For a group that has been connected by
            its administrator: the text of each message, the sender&rsquo;s display name and
            WhatsApp number as the provider supplies them, when it was sent, which group it came
            from, and the delivery envelope around it. The message is the source of truth — every
            job is derived from it, and can be re-derived when a rule improves — and it is what a
            driver reads when they want to see the post in the sender&rsquo;s own words.
          </p>
          <p>
            <strong>What the rules take out of a message.</strong> Origin, destinations, cubic feet,
            price, ready and deliver-by dates, requirements, and the contact details written in the
            post. Plus, for auditing, the full record of how the message was read.
          </p>
          <p>
            <strong>Account details, for the few people who sign in.</strong> Your email, your name,
            your role, a scrypt hash of your password — never the password itself — and optionally a
            phone number and company name if you give them. Browsing the board needs none of this.
          </p>
          <p>
            <strong>Contact reveals.</strong> When a signed-in account presses{" "}
            <strong>Show contact</strong>, we record which account, which job, and when. That is the
            accountability behind the gate: a number handed out anonymously is a number sold to a
            scraper.
          </p>
          <p>
            <strong>Jobs posted on the site.</strong> If a poster puts a job up through{" "}
            <Link href="/post">Post a job</Link>, that job and its contact details are stored the
            same way.
          </p>
        </Section>

        <Section title="What stays in your browser">
          <p>
            The location you set — where you will be when the trailer is empty, and where you are
            heading back to — is kept in your browser&rsquo;s own storage and nowhere else. It is
            not on your account, not in a cookie, and not in the link you share when you send
            somebody a search.
          </p>
          <p>
            Coordinates do travel with each search, as ordinary parameters, so the server can sort
            jobs by how far the pickup is from you and work out a drive time. They are used to
            answer that request and are not written to any table.{" "}
            <Link href="/cookies">Cookies</Link> lists every key, and offers a button that clears
            them.
          </p>
        </Section>

        <Section title="What is not collected">
          <p>
            There is no analytics script, no advertising pixel, no tag manager, no session recorder
            and no third-party tracker anywhere in this app. Nothing profiles you, nothing follows
            you to another site, and there is no data to sell because none of it is gathered. That
            is why the notice at the bottom of the screen tells you what is stored rather than
            asking you to accept something.
          </p>
        </Section>

        <Section title="Who else sees anything">
          <ul>
            <li>
              <strong>OpenStreetMap.</strong> The map&rsquo;s background tiles are fetched by your
              browser directly from OpenStreetMap&rsquo;s tile servers, so those servers see the
              request and your IP address, in the same way as any image loaded from another domain.
            </li>
            <li>
              <strong>HERE.</strong> Place names and road routes are resolved through HERE — but
              from our server, not from your browser. HERE sees a place name such as
              &ldquo;Kearny, NJ&rdquo;; it does not see you.
            </li>
            <li>
              <strong>Whoever hosts this deployment.</strong> Like any website, the machine serving
              these pages handles the ordinary web-server request that fetched them.
            </li>
          </ul>
          <p>
            That is the complete list. There is no fourth party, and no data is shared for
            advertising or resale.
          </p>
        </Section>

        <Section title="How long it is kept">
          <p>
            There is no automatic deletion schedule in this software today: messages, jobs, accounts
            and reveal records stay in the database until an operator removes them. So removal is
            something you ask for, and the next section says exactly how and what can be done. When
            a retention period is implemented, the period will be printed here.
          </p>
        </Section>

        <Section title="Asking for something to be removed">
          <p>
            Write to <strong>{email}</strong>. What can actually be done today:
          </p>
          <ul>
            <li>Delete your account and the reveal records attached to it.</li>
            <li>
              Remove a group&rsquo;s stored messages and every job derived from them — including at
              the request of a sender who does not want their posts republished here.
            </li>
            <li>Tell you what is held about a particular sender or account.</li>
          </ul>
          <p>
            <Link href="/contact">Contact</Link> sets out what to put in the message for each of
            those, so a request can be acted on without a round of questions first.
          </p>
        </Section>

        <Note tone="warn" title="This is a description, not a compliance statement">
          This page says what the software does. It does not claim compliance with GDPR, CCPA or any
          other regime, and it does not claim a certification.{" "}
          <strong>{company}</strong> should have it reviewed against the law that
          applies before this site is offered to the public.
        </Note>
      </SitePage>
    </AppShell>
  );
}
