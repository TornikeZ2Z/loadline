import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { loginHref } from "@/lib/session";
import { AppShell } from "@/components/AppShell";
import { Note, Section, SitePage } from "@/components/SitePage";
import { SITE_SETTING_FIELDS, readSiteSettings } from "@/lib/settings";
import { SettingsForm } from "./SettingsForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Site settings",
  robots: { index: false, follow: false },
};

/**
 * Where the operator fills in the five facts the legal pages need.
 *
 * A page of its own rather than a tab in the console, and the reason is that
 * this is not console work: the other tabs are about the corpus -- messages,
 * rules, senders, the needs-attention queue -- and are opened weekly. This is
 * opened roughly twice in the life of the company, and every field on it
 * changes what six PUBLIC pages assert about who is behind the site. The link
 * from the console belongs in AdminConsole.tsx; see .design/impl/wave2-settings.md.
 *
 * Guarded twice over. This page redirects a non-admin, and PUT
 * /api/admin/settings independently refuses one -- the redirect is the courtesy
 * and the route guard is the boundary. A demo admin may READ the form (it is
 * part of what there is to show) and cannot save.
 */
export default async function AdminSettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginHref("/admin/settings"));
  if (user.role !== "admin") redirect("/");

  const settings = await readSiteSettings();

  return (
    <AppShell user={user} active="admin" currentPath="/admin/settings">
      <SitePage
        eyebrow="Admin"
        title="Site settings"
        lead="Five facts about the operating entity that the legal pages need and this codebase cannot know. Fill them in and six public pages stop showing placeholders."
        meta={
          <>
            Admin only · <Link href="/admin">Back to the console</Link>
          </>
        }
      >
        <Section title="The legal identity">
          <SettingsForm
            fields={SITE_SETTING_FIELDS}
            initial={settings}
            canWrite={!user.isDemo}
          />
        </Section>

        <Note tone="warn" title="Filling these in is not a legal review">
          Terms and Privacy carry standing notices saying the text has not been read by a lawyer.
          Those notices are not tied to this form and do not come off when it is complete — only
          counsel takes them off. A page that has had its blanks filled looks finished, which is
          exactly when an unreviewed one is most dangerous.
        </Note>

        <Note title="What happens to a value you clear">
          Emptying a field deletes it. The public pages go straight back to showing the bracketed
          placeholder, which is the honest state and always reachable — so a wrong company name is
          never something you have to live with. There is no default and no guess behind any of
          these fields.
        </Note>
      </SitePage>
    </AppShell>
  );
}
