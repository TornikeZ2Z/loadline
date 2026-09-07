import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { ClearStorageButton } from "@/components/CookieNotice";
import { Note, Section, SitePage, StoredItem } from "@/components/SitePage";
import { readSiteSettings, settingText } from "@/lib/settings";
import { reportProblemHref } from "@/lib/support";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Cookies",
  description:
    "MoverMesh sets one cookie — the signed session — and keeps four preferences in your browser. No analytics, no advertising, no third-party trackers.",
};

/**
 * The complete inventory, checked against the code rather than assumed:
 *
 *   lb_session                      src/lib/auth.ts (the only cookies().set in the repo)
 *   loadline.viewer.v1              src/lib/location.ts LOCATION_KEYS.current
 *   loadline.home.v1                src/lib/location.ts LOCATION_KEYS.home
 *   loadline.post.requirements.v1   src/components/PostLoadForm.tsx REQUIREMENTS_KEY
 *   loadline.locnudge               src/components/Board.tsx NUDGE_KEY (sessionStorage)
 *   loadline.notice.storage.v1      src/components/CookieNotice.tsx NOTICE_KEY
 *
 * If a seventh ever appears, it belongs on this page in the same commit.
 */
export default async function CookiesPage() {
  const user = await getCurrentUser();
  const settings = await readSiteSettings();

  return (
    <AppShell user={user} active="site" currentPath="/cookies">
      <SitePage
        eyebrow="Legal"
        title="Cookies and browser storage"
        lead="One cookie, set only if you sign in, and five small things kept in your own browser. That is the complete list, and none of it is a tracker."
        meta={
          <>
            Last updated <strong>{settingText(settings, "effective_date")}</strong> · See also{" "}
            <Link href="/privacy">Privacy</Link>
          </>
        }
      >
        <Section title="Why there is no Accept button">
          <p>
            Consent banners exist because most sites load advertising and analytics that follow you
            around. This one does not: there is no analytics script, no advertising pixel, no tag
            manager and no third-party cookie anywhere in it. An &ldquo;Accept all / Reject
            all&rdquo; pair over that would be theatre, and would imply there is something to
            reject.
          </p>
          <p>
            So the notice at the bottom of the screen tells you what is stored and gets out of the
            way. Below is the same list in full.
          </p>
        </Section>

        <Section title="The one cookie">
          <StoredItem name="lb_session" where="Cookie">
            Keeps you signed in. Written only when you sign in, never for a visitor who is just
            browsing. It holds your account id, an expiry, and a signature that proves the pair was
            issued by this site — no name, no email, no location. It is{" "}
            <code>HttpOnly</code> (JavaScript on the page cannot read it),{" "}
            <code>SameSite=Lax</code>, sent over HTTPS only in production, and it lasts 30 days.
            Signing out deletes it.
          </StoredItem>
        </Section>

        <Section title="Kept in your browser, not on our server">
          <p>
            These live in your browser&rsquo;s local storage. They are never sent to us as stored
            values, they are not cookies, and they do not leave the device.
          </p>
          <p>
            Their names still start with <code>loadline.</code>, which is what this product was
            called before it was MoverMesh. Renaming the keys would silently discard the location
            every existing visitor has saved, so the old prefix stays.
          </p>
          <StoredItem name="loadline.viewer.v1" where="Local storage">
            Where you said you will be when the trailer is empty, so the board can sort by distance
            to the pickup and show a drive time. Includes the truck size, if you gave one. Written
            only when you set a location.
          </StoredItem>
          <StoredItem name="loadline.home.v1" where="Local storage">
            Where you are heading back to, for the <em>Toward home</em> filter. Written only when
            you set it.
          </StoredItem>
          <StoredItem name="loadline.post.requirements.v1" where="Local storage">
            The requirements text on the post form, remembered so a poster does not retype the same
            paragraph on every job. Posters only.
          </StoredItem>
          <StoredItem name="loadline.locnudge" where="Session storage">
            That the board already offered, this visit, to set your location. Stops it asking twice.
            Cleared when you close the tab.
          </StoredItem>
          <StoredItem name="loadline.notice.storage.v1" where="Local storage">
            That you dismissed the storage notice. Written when you press the button on it, and not
            before.
          </StoredItem>
        </Section>

        <Section title="Clearing it">
          <p>
            The button below removes every item on this page from this browser, including the
            record that you dismissed the notice — so the notice comes back, which is the honest
            outcome.
          </p>
          <ClearStorageButton />
          <p>
            The session cookie is not on that button, and cannot be: it is <code>HttpOnly</code>,
            which is the point of it. Sign out to delete it. Your browser&rsquo;s own settings can
            also block all of this — the board still works without any of it, you simply lose the
            distance sort and have to re-enter a location each visit.
          </p>
        </Section>

        <Section title="Third-party requests">
          <p>
            The map&rsquo;s background tiles are fetched by your browser from OpenStreetMap&rsquo;s
            tile servers. That is a request to another domain, the same as any image on any web
            page, and it sets no cookie for us. Everything else the site needs from the outside —
            geocoding, road routes — is fetched by our server, not by your browser. See{" "}
            <Link href="/privacy">Privacy</Link>.
          </p>
        </Section>

        <Note title="If this list ever goes out of date, that is a bug">
          Every key above is written in one place in the source, and this page is meant to be the
          mirror of it. Tell us at <strong>{settingText(settings, "support_email")}</strong> — or through{" "}
          <Link href={reportProblemHref()} className="underline">
            Report a problem
          </Link>
          , which is the same address and says what to include.
        </Note>
      </SitePage>
    </AppShell>
  );
}
